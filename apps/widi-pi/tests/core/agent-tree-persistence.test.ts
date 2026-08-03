/**
 * The spawn tree as branch state: what a parent records about the agents it
 * spawned, and what a fork does with them.
 *
 * The cases that matter are the ones where the branch and this process disagree
 * - a rewound branch, an inherited one, a ref that will not land - because that
 * disagreement is the whole reason the tree lives on the branch. The last group
 * runs against the real repository, because the property the design is sold on
 * is one only a real fork can demonstrate: the new tree owns its children.
 */

import type { SessionTreeEntry } from "@widi/agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createSubagentNamespace,
	openSubagentTreeStorage,
	reduceSubagentRecords,
	SessionSubagentStore,
	SUBAGENT_NAMESPACE,
	SubagentTreeStorage,
	subagentSessionDependencies,
	toSubagentRecord,
} from "../../src/core/orchestrator/agent-tree.ts";
import type { SubagentBranchPort, SubagentMember, SubagentRecord } from "../../src/core/orchestrator/types.ts";
import type { NamespaceProjection, PersistedSession, SessionKey } from "../../src/core/persistence/index.ts";
import {
	createPersistenceRefData,
	JsonlPersistenceRepo,
	PERSISTENCE_REF_CUSTOM_TYPE,
	PersistenceDiagnostics,
	PersistenceRegistry,
	projectBranch,
} from "../../src/core/persistence/index.ts";
import { MemoryFileSystem } from "../helpers/memory-fs.ts";

const CWD = "/root/projs/widi";
const ROOT = "/runs";
const DIR = "/runs/--w--/root/persistence/core__subagent";
const OWNER: SessionKey = ["20260801T120000Z_root"];

function spawned(sessionDirName: string, agentId = sessionDirName, spawnedAt = 1): SubagentRecord {
	return { kind: "spawned", sessionDirName, agentId, profileId: "coder", spawnedAt };
}

function removed(sessionDirName: string, removedAt = 9): SubagentRecord {
	return { kind: "removed", sessionDirName, removedAt };
}

function states(members: readonly SubagentMember[]): Array<readonly [string, string]> {
	return members.map((member) => [member.sessionDirName, member.state] as const);
}

// -- the reducer ----------------------------------------------------------

describe("reduceSubagentRecords", () => {
	it("reduces a spawn and its removal into one member", () => {
		const members = reduceSubagentRecords([spawned("d1"), spawned("d2"), removed("d1")]);
		expect(states(members)).toEqual([
			["d1", "removed"],
			["d2", "live"],
		]);
		expect(members[0]?.removedAt).toBe(9);
	});

	it("drops a removal whose spawn is not on this chain", () => {
		expect(reduceSubagentRecords([removed("d1"), spawned("d2")])).toHaveLength(1);
	});

	it("keeps the first record naming a directory", () => {
		const members = reduceSubagentRecords([
			spawned("d1", "coder-1", 1),
			spawned("d1", "coder-9", 5),
			removed("d1", 7),
			removed("d1", 8),
		]);
		expect(members).toHaveLength(1);
		expect(members[0]?.agentId).toBe("coder-1");
		expect(members[0]?.removedAt).toBe(7);
	});

	it("keys on the directory, so one AgentId can name two members", () => {
		const members = reduceSubagentRecords([spawned("d1", "coder-1", 1), spawned("d2", "coder-1", 2)]);
		expect(members.map((member) => member.agentId)).toEqual(["coder-1", "coder-1"]);
	});
});

describe("toSubagentRecord", () => {
	it("takes the records this build writes", () => {
		expect(toSubagentRecord(spawned("d1"))).toEqual(spawned("d1"));
		expect(toSubagentRecord(removed("d1"))).toEqual(removed("d1"));
	});

	it("rejects anything it could not reduce", () => {
		expect(toSubagentRecord(undefined)).toBeUndefined();
		expect(toSubagentRecord([spawned("d1")])).toBeUndefined();
		expect(toSubagentRecord({ ...spawned("d1"), sessionDirName: "" })).toBeUndefined();
		expect(toSubagentRecord({ ...spawned("d1"), kind: "renamed" })).toBeUndefined();
		expect(toSubagentRecord({ ...spawned("d1"), spawnedAt: "soon" })).toBeUndefined();
		expect(toSubagentRecord({ kind: "removed", sessionDirName: "d1" })).toBeUndefined();
	});
});

describe("subagentSessionDependencies", () => {
	it("names a spawn's child under the session that owns the record", () => {
		expect(subagentSessionDependencies(OWNER, spawned("d1"))).toEqual([[...OWNER, "d1"]]);
	});

	it("names nothing for a removal, which introduces no directory", () => {
		expect(subagentSessionDependencies(OWNER, removed("d1"))).toEqual([]);
		expect(subagentSessionDependencies(OWNER, { kind: "spawned" })).toEqual([]);
	});
});

// -- the storage ----------------------------------------------------------

describe("SubagentTreeStorage", () => {
	let fs: MemoryFileSystem;

	async function open(): Promise<SubagentTreeStorage> {
		return await SubagentTreeStorage.open({
			fs,
			dirPath: DIR,
			sessionKey: OWNER,
			diagnostics: new PersistenceDiagnostics(),
		});
	}

	beforeEach(() => {
		fs = new MemoryFileSystem();
	});

	it("resolves a chain oldest first", async () => {
		const storage = await open();
		let root = await storage.appendRecord(spawned("d1"), null);
		root = await storage.appendRecord(spawned("d2"), root);
		root = await storage.appendRecord(removed("d1"), root);

		expect(await open().then(async (reopened) => reopened.resolveState(root))).toEqual({
			members: [
				{ sessionDirName: "d1", agentId: "d1", profileId: "coder", spawnedAt: 1, state: "removed", removedAt: 9 },
				{ sessionDirName: "d2", agentId: "d2", profileId: "coder", spawnedAt: 1, state: "live" },
			],
			truncated: false,
		});
	});

	it("answers undefined for a root the log does not hold", async () => {
		expect(await (await open()).resolveState("nothing")).toBeUndefined();
	});

	it("reports a chain it could not walk to the end", async () => {
		const storage = await open();
		const root = await storage.appendRecord(spawned("d1"), "an-object-that-was-never-written");
		const membership = await storage.resolveState(root);
		expect(membership?.truncated).toBe(true);
		expect(states(membership?.members ?? [])).toEqual([["d1", "live"]]);
	});

	it("names one child per spawn on the chain, removals included", async () => {
		const storage = await open();
		const first = await storage.appendRecord(spawned("d1"), null);
		const second = await storage.appendRecord(removed("d1"), first);

		expect(await storage.listSessionDependencies(first)).toEqual([[...OWNER, "d1"]]);
		expect(await storage.listSessionDependencies(second)).toEqual([]);
	});

	it("places a member's session under the session that owns the tree", async () => {
		const storage = await open();
		const root = await storage.appendRecord(spawned("d1"), null);
		const member = (await storage.resolveState(root))?.members[0] as SubagentMember;
		expect(storage.childKeyOf(member)).toEqual([...OWNER, "d1"]);
	});
});

// -- one agent's store ----------------------------------------------------

/**
 * The orchestrator's side of the port, reduced to what it means: a list of
 * committed roots, the last one being the one in force.
 */
class FakeBranch implements SubagentBranchPort {
	committed: (string | null)[] = [];
	failNextCommit = false;

	async projection(): Promise<NamespaceProjection | undefined> {
		if (this.committed.length === 0) return undefined;
		return {
			namespace: SUBAGENT_NAMESPACE,
			stateRoot: this.committed[this.committed.length - 1] ?? null,
			refs: [],
			provenance: "current",
		};
	}

	async commit(stateRoot: string | null): Promise<void> {
		if (this.failNextCommit) {
			this.failNextCommit = false;
			throw new Error("the harness refused this write");
		}
		this.committed.push(stateRoot);
	}

	/** Drop the last `count` refs, as rewinding the conversation would. */
	rewind(count: number): void {
		this.committed = this.committed.slice(0, Math.max(0, this.committed.length - count));
	}
}

describe("SessionSubagentStore", () => {
	let fs: MemoryFileSystem;
	let branch: FakeBranch;

	async function openStore(): Promise<SessionSubagentStore> {
		return await SessionSubagentStore.open({
			storage: await SubagentTreeStorage.open({
				fs,
				dirPath: DIR,
				sessionKey: OWNER,
				diagnostics: new PersistenceDiagnostics(),
			}),
			branch,
		});
	}

	async function spawn(store: SessionSubagentStore, dir: string, agentId = dir, spawnedAt = 1): Promise<string> {
		return await store.recordSpawn({ sessionDirName: dir, agentId, profileId: "coder", spawnedAt });
	}

	beforeEach(() => {
		fs = new MemoryFileSystem();
		branch = new FakeBranch();
	});

	it("starts empty on a branch that never spawned anyone", async () => {
		const store = await openStore();
		expect(store.members()).toEqual([]);
		expect(store.carriedOverMembers()).toEqual([]);
		expect(store.stateRoot).toBeNull();
	});

	it("puts one ref on the branch per record", async () => {
		const store = await openStore();
		await spawn(store, "d1");
		await store.recordRemoval("d1");
		expect(branch.committed).toHaveLength(2);
		expect(states(store.members())).toEqual([["d1", "removed"]]);
	});

	it("reads back the members an earlier run left live", async () => {
		const first = await openStore();
		await spawn(first, "d1");
		await spawn(first, "d2");
		await first.recordRemoval("d2");

		const second = await openStore();
		expect(second.carriedOverMembers().map((member) => member.sessionDirName)).toEqual(["d1"]);
		expect(second.members()).toHaveLength(2);
	});

	it("does not see a member whose spawn the branch was rewound past", async () => {
		const first = await openStore();
		await spawn(first, "d1");
		branch.rewind(1);

		const second = await openStore();
		expect(second.members()).toEqual([]);
		expect(second.stateRoot).toBeNull();
	});

	it("keeps a carried-over set frozen at open, not tracking later spawns", async () => {
		const first = await openStore();
		await spawn(first, "d1");

		const second = await openStore();
		await spawn(second, "d2");
		expect(second.carriedOverMembers().map((member) => member.sessionDirName)).toEqual(["d1"]);
	});

	it("chains each record onto the root the branch currently names", async () => {
		const store = await openStore();
		const rootA = await spawn(store, "d1");
		const rootB = await spawn(store, "d2");
		expect(rootB).not.toBe(rootA);
		expect(branch.committed).toEqual([rootA, rootB]);
	});

	it("serializes concurrent spawns without losing either branch ref", async () => {
		const store = await openStore();
		const roots = await Promise.all([spawn(store, "d1"), spawn(store, "d2")]);

		expect(new Set(roots).size).toBe(2);
		expect(branch.committed).toEqual(roots);
		expect((await openStore()).members().map((member) => member.sessionDirName)).toEqual(["d1", "d2"]);
	});

	it("writes nothing for a removal the branch cannot act on", async () => {
		const store = await openStore();
		await spawn(store, "d1");
		await store.recordRemoval("d1");
		const before = branch.committed.length;

		expect(await store.recordRemoval("d1")).toBeUndefined();
		expect(await store.recordRemoval("never-spawned")).toBeUndefined();
		expect(branch.committed).toHaveLength(before);
	});

	it("records one removal when two arrive at once", async () => {
		const store = await openStore();
		await spawn(store, "d1");
		const before = branch.committed.length;

		const roots = await Promise.all([store.recordRemoval("d1"), store.recordRemoval("d1")]);
		expect(roots.filter((root) => root !== undefined)).toHaveLength(1);
		expect(branch.committed).toHaveLength(before + 1);
	});

	it("answers with the newest live member when one AgentId was reused", async () => {
		const store = await openStore();
		await spawn(store, "d1", "coder-1", 1);
		await spawn(store, "d2", "coder-1", 5);
		expect(store.liveMemberOf("coder-1")?.sessionDirName).toBe("d2");

		await store.recordRemoval("d2");
		expect(store.liveMemberOf("coder-1")?.sessionDirName).toBe("d1");
		await store.recordRemoval("d1");
		expect(store.liveMemberOf("coder-1")).toBeUndefined();
	});

	it("places a member's session under the session that owns the tree", async () => {
		const store = await openStore();
		await spawn(store, "d1");
		const member = store.members()[0] as SubagentMember;
		expect(store.childKeyOf(member)).toEqual([...OWNER, "d1"]);
	});
});

describe("SessionSubagentStore under a failing branch", () => {
	let fs: MemoryFileSystem;
	let branch: FakeBranch;

	async function openStore(): Promise<SessionSubagentStore> {
		return await SessionSubagentStore.open({
			storage: await SubagentTreeStorage.open({ fs, dirPath: DIR, sessionKey: OWNER }),
			branch,
		});
	}

	async function spawn(store: SessionSubagentStore, dir: string): Promise<string> {
		return await store.recordSpawn({ sessionDirName: dir, agentId: dir, profileId: "coder", spawnedAt: 1 });
	}

	beforeEach(() => {
		fs = new MemoryFileSystem();
		branch = new FakeBranch();
	});

	it("rejects and leaves the branch's root where it was", async () => {
		const store = await openStore();
		const root = await spawn(store, "d1");
		branch.failNextCommit = true;
		await expect(spawn(store, "d2")).rejects.toThrow(/refused/);
		expect(store.stateRoot).toBe(root);
		expect(branch.committed).toHaveLength(1);
	});

	it("keeps this process's own view of the member it failed to record", async () => {
		const store = await openStore();
		branch.failNextCommit = true;
		await expect(spawn(store, "d1")).rejects.toThrow(/refused/);
		expect(store.members().map((member) => member.sessionDirName)).toEqual(["d1"]);
		expect((await openStore()).members()).toEqual([]);
	});

	it("goes on recording after a refused write instead of wedging", async () => {
		const store = await openStore();
		branch.failNextCommit = true;
		await expect(spawn(store, "d1")).rejects.toThrow(/refused/);
		await spawn(store, "d2");
		expect((await openStore()).members().map((member) => member.sessionDirName)).toEqual(["d2"]);
	});
});

// -- through the repository -----------------------------------------------

/** The real port: a ref entry on a real session, projected back off the branch. */
class SessionBranch implements SubagentBranchPort {
	private readonly _target: PersistedSession;

	constructor(target: PersistedSession) {
		this._target = target;
	}

	async projection(): Promise<NamespaceProjection | undefined> {
		const branch = await this._target.session.getFullBranch();
		return projectBranch(branch).namespaces.get(SUBAGENT_NAMESPACE);
	}

	async commit(stateRoot: string | null): Promise<void> {
		await this._target.session.appendEntry({
			type: "custom",
			id: await this._target.session.createEntryId(),
			parentId: await this._target.session.getLeafId(),
			timestamp: new Date().toISOString(),
			customType: PERSISTENCE_REF_CUSTOM_TYPE,
			data: createPersistenceRefData({ namespace: SUBAGENT_NAMESPACE, stateRoot }),
		});
	}
}

describe("core:subagent through the repository", () => {
	let fs: MemoryFileSystem;
	let repo: JsonlPersistenceRepo;

	async function storeOf(session: PersistedSession): Promise<SessionSubagentStore> {
		const storage = await openSubagentTreeStorage(repo, session.address);
		if (!storage) throw new Error("core:subagent is not registered");
		return await SessionSubagentStore.open({ storage, branch: new SessionBranch(session) });
	}

	/**
	 * Spawn as the orchestrator will: create the child session, then record the
	 * directory it landed in.
	 */
	async function spawnChild(parent: PersistedSession, sessionId: string): Promise<PersistedSession> {
		const child = await repo.create({ cwd: CWD, sessionId, parent: parent.address.key });
		const dirName = child.address.key[child.address.key.length - 1] as string;
		await (await storeOf(parent)).recordSpawn({ sessionDirName: dirName, agentId: sessionId, profileId: "coder" });
		return child;
	}

	async function say(target: PersistedSession, text: string): Promise<string> {
		const entry: SessionTreeEntry = {
			type: "message",
			id: await target.session.createEntryId(),
			parentId: await target.session.getLeafId(),
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
		};
		await target.session.appendEntry(entry);
		return entry.id;
	}

	beforeEach(() => {
		fs = new MemoryFileSystem();
		const registry = new PersistenceRegistry();
		registry.register(createSubagentNamespace());
		repo = new JsonlPersistenceRepo({ fs, root: ROOT, registry });
	});

	it("carries the tree into a fork and stands on its own once the source is gone", async () => {
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		const child = await spawnChild(root, "coder");
		await say(child, "child work");

		const forked = await repo.fork(root.address, { sessionId: "forked" });
		expect(forked.diagnostics.entries).toEqual([]);

		await repo.delete(root.address);
		expect([...fs.files.keys()].some((path) => path.includes(`/${root.address.key[0]}/`))).toBe(false);

		const store = await storeOf(forked.session);
		expect(store.carriedOverMembers().map((member) => member.agentId)).toEqual(["coder"]);
		// The record still names a directory, and after the fork it is a directory
		// of the new tree - which is the whole point of storing a name and not a key.
		const key = store.childKeyOf(store.members()[0] as SubagentMember);
		expect(key[0]).toBe(forked.session.address.key[0]);
		expect(key[1]).toBe(child.address.key[1]);
		expect((await repo.open({ cwd: CWD, key })).metadata.id).toBe("coder");
	});

	it("marks an inherited tree as forked until the new session spawns its own", async () => {
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await spawnChild(root, "coder");

		const forked = await repo.fork(root.address, { sessionId: "forked" });
		const inherited = await repo.resolveState(forked.session.address);
		expect(inherited.states.get(SUBAGENT_NAMESPACE)?.provenance).toBe("forked");

		await spawnChild(forked.session, "reviewer");
		const own = await repo.resolveState(forked.session.address);
		expect(own.states.get(SUBAGENT_NAMESPACE)?.provenance).toBe("current");
		// The inherited member is still there: writing its own ref replaced what the
		// branch names, not what the chain under it holds.
		const store = await storeOf(forked.session);
		expect(store.members().map((member) => member.agentId)).toEqual(["coder", "reviewer"]);
	});

	it("does not carry a member spawned after the fork point", async () => {
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await spawnChild(root, "early");
		const midpoint = await say(root, "fork here");
		await spawnChild(root, "late");

		const forked = await repo.fork(root.address, { sessionId: "forked", entryId: midpoint });
		expect((await repo.listChildren(forked.session.address)).map((info) => info.metadata.id)).toEqual(["early"]);
		expect((await storeOf(forked.session)).members()).toHaveLength(1);
	});

	it("carries a removed member's directory, so a rewind in the fork still finds it", async () => {
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		const child = await spawnChild(root, "coder");
		await (await storeOf(root)).recordRemoval(child.address.key[1] as string);

		const forked = await repo.fork(root.address, { sessionId: "forked" });
		await repo.delete(root.address);

		expect(states((await storeOf(forked.session)).members())).toEqual([[child.address.key[1] as string, "removed"]]);
		expect((await repo.listChildren(forked.session.address)).map((info) => info.metadata.id)).toEqual(["coder"]);
	});

	it("writes nothing into the source when a fork carries a tree", async () => {
		const root = await repo.create({ cwd: CWD, sessionId: "root" });
		await spawnChild(root, "coder");
		const prefix = `/runs/--root-projs-widi--/${root.address.key[0]}`;
		const before = new Map([...fs.files].filter(([path]) => path.startsWith(prefix)));

		await repo.fork(root.address, { sessionId: "forked" });

		expect(new Map([...fs.files].filter(([path]) => path.startsWith(prefix)))).toEqual(before);
	});
});

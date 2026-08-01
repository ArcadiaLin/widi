/**
 * Which state each namespace has at a point on the conversation tree.
 *
 * This is the whole recovery rule, and it is deliberately small: walk the
 * branch, keep the last ref per namespace, and that is what the namespace is.
 * Everything a session persists inherits rewind semantics from that walk
 * instead of defining its own.
 *
 * The walk is over the *complete* root-to-leaf path. The path pi builds for
 * model context stops at a compaction checkpoint, and a ref older than the
 * checkpoint is still in force - the model forgetting a fact does not make the
 * fact untrue.
 *
 * Pure over entries, so every rewind, override and rejection case is testable
 * without a filesystem.
 */

import type { SessionTreeEntry } from "@widi/agent-core";
import type {
	PersistenceRef,
	PersistenceRefRejection,
} from "./persistence-ref.ts";
import { parsePersistenceRef } from "./persistence-ref.ts";

export interface NamespaceProjection {
	readonly namespace: string;
	/** Null when the branch's last word on this namespace was to clear it. */
	readonly stateRoot: string | null;
	/** Every ref that applied, oldest first. Diagnostics and audit only. */
	readonly refs: readonly PersistenceRef[];
}

export interface BranchProjection {
	readonly namespaces: ReadonlyMap<string, NamespaceProjection>;
	readonly rejected: readonly PersistenceRefRejection[];
}

/**
 * Project a full root-to-leaf path onto per-namespace state.
 *
 * Later refs win. A namespace that wants to reduce its whole ref sequence
 * instead builds that reduction into the state root it writes - the framework
 * keeps one rule so that resolution never depends on which namespaces happen to
 * be registered in this build.
 */
export function projectBranch(
	branch: readonly SessionTreeEntry[],
): BranchProjection {
	const namespaces = new Map<string, NamespaceProjection>();
	const rejected: PersistenceRefRejection[] = [];
	for (const entry of branch) {
		const result = parsePersistenceRef(entry);
		if (result === undefined) continue;
		if (!result.ok) {
			rejected.push(result.rejection);
			continue;
		}
		const { ref } = result;
		const previous = namespaces.get(ref.namespace);
		namespaces.set(ref.namespace, {
			namespace: ref.namespace,
			stateRoot: ref.stateRoot,
			refs: previous ? [...previous.refs, ref] : [ref],
		});
	}
	return { namespaces, rejected };
}

/**
 * The state roots a fork has to carry, per namespace.
 *
 * Cleared namespaces drop out here rather than being copied and then ignored.
 */
export function projectionToForkRoots(
	projection: BranchProjection,
): ReadonlyMap<string, string> {
	const roots = new Map<string, string>();
	for (const [namespace, entry] of projection.namespaces) {
		if (entry.stateRoot !== null) roots.set(namespace, entry.stateRoot);
	}
	return roots;
}

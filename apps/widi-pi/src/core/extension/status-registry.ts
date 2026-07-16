import {
	cloneExtensionStatus,
	type ExtensionStatus,
	type ExtensionStatusSnapshot,
} from "./presentation.ts";

export class ExtensionStatusRegistry {
	private readonly agents = new Map<
		string,
		Map<string, Map<string, ExtensionStatusSnapshot>>
	>();

	set(
		agentId: string,
		extensionId: string,
		key: string,
		status: ExtensionStatus,
		updatedAt: string,
	): ExtensionStatusSnapshot {
		const extensions = this.agents.get(agentId) ?? new Map();
		this.agents.set(agentId, extensions);
		const statuses = extensions.get(extensionId) ?? new Map();
		extensions.set(extensionId, statuses);
		const snapshot: ExtensionStatusSnapshot = {
			agentId,
			extensionId,
			key,
			status: cloneExtensionStatus(status),
			updatedAt,
		};
		statuses.set(key, snapshot);
		return cloneSnapshot(snapshot);
	}

	clear(agentId: string, extensionId: string, key: string): boolean {
		const extensions = this.agents.get(agentId);
		const statuses = extensions?.get(extensionId);
		if (!statuses?.delete(key)) return false;
		if (statuses.size === 0) extensions?.delete(extensionId);
		if (extensions?.size === 0) this.agents.delete(agentId);
		return true;
	}

	clearAgent(agentId: string): ExtensionStatusSnapshot[] {
		const snapshots = this.list(agentId);
		this.agents.delete(agentId);
		return snapshots;
	}

	list(agentId: string): ExtensionStatusSnapshot[] {
		const extensions = this.agents.get(agentId);
		if (!extensions) return [];
		const snapshots: ExtensionStatusSnapshot[] = [];
		for (const statuses of extensions.values()) {
			for (const snapshot of statuses.values()) {
				snapshots.push(cloneSnapshot(snapshot));
			}
		}
		return snapshots;
	}
}

function cloneSnapshot(
	snapshot: ExtensionStatusSnapshot,
): ExtensionStatusSnapshot {
	return {
		...snapshot,
		status: cloneExtensionStatus(snapshot.status),
	};
}

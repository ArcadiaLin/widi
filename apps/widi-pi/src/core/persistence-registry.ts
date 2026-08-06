/**
 * The persistence namespaces this build ships.
 *
 * One function rather than a registration scattered over the runtime, because
 * the registry is what decides whether a state root found on a branch can be
 * read at all: a namespace missing here leaves its ref and its directory
 * untouched and its state unresolved. Which namespaces exist is therefore a
 * fact about the build, and it belongs in one place.
 *
 * Extensions do not register here yet. When they do, the bar for admission is
 * "is this state a function of the conversation" - see `orchestrator-refactor.md`
 * section 2 and `persistence-ref-writer.md` section 3.1.
 */

import { createJobsNamespace } from "./background/index.ts";
import { PersistenceRegistry } from "./persistence/index.ts";

export function createCorePersistenceRegistry(): PersistenceRegistry {
	const registry = new PersistenceRegistry();
	registry.register(createJobsNamespace());
	return registry;
}

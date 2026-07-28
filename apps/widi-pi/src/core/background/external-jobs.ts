/**
 * Cross-table view of jobs whose settler is not their owner.
 *
 * A `BackgroundJobTable` only ever sees its own jobs, so no single table can
 * answer "the settler is gone, which jobs can no longer settle?". This holds
 * exactly that lookup and nothing else: every entry is derived from a live job
 * and retired when that job settles.
 */

import type { BackgroundJob } from "./job.ts";

/** One job that a settler outside its owning table still owes an outcome. */
export interface ExternalJobDependency {
	/** Identifier of the table the job lives in. */
	readonly ownerId: string;
	/** The job's id within that table. */
	readonly jobId: string;
}

/**
 * Reverse index from an external settler to the jobs waiting on it.
 *
 * A `BackgroundJobTable` only sees its own jobs, but an `external` job
 * lives in the owner's table while its outcome depends on a settler that is not
 * the owner. Answering "the settler is gone, which jobs can no longer settle?"
 * therefore needs a view across tables, which is what this holds - nothing more.
 * The owner's job stays the only state; every entry here is derived from a live
 * job and dropped when that job settles.
 *
 * Ids are opaque strings so this stays a lookup structure: it does not know what
 * a settler is, only that jobs are keyed by one.
 */
export class ExternalJobDependencyIndex {
	private readonly _bySettler = new Map<string, Set<ExternalJobDependency>>();

	/** Index a job whose settler is external. Local jobs are ignored. */
	track(ownerId: string, job: BackgroundJob): void {
		if (job.origin.kind !== "external") return;
		const dependents = this._bySettler.get(job.origin.settlerId) ?? new Set();
		dependents.add({ ownerId, jobId: job.id });
		this._bySettler.set(job.origin.settlerId, dependents);
	}

	/** Drop a settled job's entry. */
	untrack(ownerId: string, job: BackgroundJob): void {
		if (job.origin.kind !== "external") return;
		const dependents = this._bySettler.get(job.origin.settlerId);
		if (!dependents) return;
		for (const dependency of dependents) {
			if (dependency.ownerId === ownerId && dependency.jobId === job.id) {
				dependents.delete(dependency);
			}
		}
		if (dependents.size === 0) this._bySettler.delete(job.origin.settlerId);
	}

	/**
	 * Drop every entry owned by `ownerId`, whatever it was waiting on. Used when
	 * an owner goes away without its jobs reporting their own settlement - a
	 * stale entry would otherwise match a job id that a later table reuses.
	 */
	forgetOwner(ownerId: string): void {
		for (const [settlerId, dependents] of this._bySettler) {
			for (const dependency of dependents) {
				if (dependency.ownerId === ownerId) dependents.delete(dependency);
			}
			if (dependents.size === 0) this._bySettler.delete(settlerId);
		}
	}

	/**
	 * Remove and return everything waiting on `settlerId`. Taking rather than
	 * reading keeps the caller from acting on the same entry twice: settling the
	 * returned jobs is what retires them.
	 */
	takeDependentsOf(settlerId: string): readonly ExternalJobDependency[] {
		const dependents = this._bySettler.get(settlerId);
		if (!dependents) return [];
		this._bySettler.delete(settlerId);
		return [...dependents];
	}
}

import { log } from "../platform/index.ts";
import { dropFromLimits } from "./store.ts";

// The limits of an agent, for a Durable Object that owns the members of a resource. The object of a shared
// drive owns its members, and the directory owns the limits of an agent. The limits must not name a resource
// that the agent is not a member of: a later add by a person who does not manage the agent would then give
// it access. So the object takes the resource out of the limits in one step with the remove of the member.
//
// Each function that writes holds the object with `blockConcurrencyWhile`, or its caller does. So no add and
// no remove of the object runs between the read of the members and the write of the directory, and the
// object gives the order of the two stores.

/** The table of the principals whose limits still name the resource after a remove, because the directory failed. */
export const LIMIT_DROPS_TABLE = "CREATE TABLE IF NOT EXISTS limit_drops (principal_id TEXT PRIMARY KEY) WITHOUT ROWID";

/** The parts of a Durable Object that these functions use. */
export interface LimitDropsHost {
	ctx: DurableObjectState;
	/** The directory at the time of the call. */
	directory: () => D1Database;
	kind: "room" | "drive";
	/** The id of the resource of the object. */
	resourceId: string;
	isMember: (principalId: string) => boolean;
}

function waits(host: LimitDropsHost, principalId: string): boolean {
	return (
		host.ctx.storage.sql.exec("SELECT 1 FROM limit_drops WHERE principal_id = ?", principalId).toArray().length > 0
	);
}

/**
 * Takes the resource out of the limits of a principal that is not a member now. The caller holds the object
 * with `blockConcurrencyWhile`. Returns true when the limits named the resource. The statement changes only
 * an agent or a service account, so a person needs no check here.
 *
 * When the directory fails, the object keeps the principal in `limit_drops`, and `afterLimitDrops` completes
 * the write before that principal is a member again.
 */
export async function dropLimits(host: LimitDropsHost, principalId: string): Promise<boolean> {
	const { sql } = host.ctx.storage;
	try {
		const dropped = (await dropFromLimits(host.directory(), principalId, host.kind, host.resourceId)) !== null;
		sql.exec("DELETE FROM limit_drops WHERE principal_id = ?", principalId);
		return dropped;
	} catch (error) {
		sql.exec("INSERT OR IGNORE INTO limit_drops (principal_id) VALUES (?)", principalId);
		log("warn", `${host.kind}: the limits of an agent still name the ${host.kind} after a remove`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/**
 * Runs `write`, which makes these principals members, after the object completed the write of the limits for
 * each of them that has a row in `limit_drops`. The limits of such an agent still name the resource. Without
 * this, a person who does not manage the agent adds it, and the agent has access from the old limits. When
 * the directory fails again, the result is `unsettled`: `write` did not run.
 *
 * The writes of the directory and `write` are one step of the object. So no remove puts a row into
 * `limit_drops` between them, and no write of an earlier call deletes a later row. `write` has no wait.
 */
export async function afterLimitDrops<T>(
	host: LimitDropsHost,
	principalIds: readonly string[],
	write: () => T,
): Promise<{ written: T } | { unsettled: true }> {
	// No row: `write` runs with no wait after this read, so it needs no step of its own.
	if (!principalIds.some((id) => waits(host, id))) return { written: write() };
	return host.ctx.blockConcurrencyWhile(async () => {
		for (const id of principalIds) {
			if (!waits(host, id)) continue;
			await dropLimits(host, id);
			if (waits(host, id)) return { unsettled: true as const };
		}
		return { written: write() };
	});
}

/**
 * Takes the resource out of the limits of a principal that is not a member now. The handler of an add calls
 * this after it put the resource into the limits: a remove can come between the write of the object and that
 * write. The object reads its members and writes the directory in one step. Returns true when the principal
 * is not a member, so the access that the handler wrote is gone.
 */
export async function releaseLimits(host: LimitDropsHost, principalId: string): Promise<boolean> {
	return host.ctx.blockConcurrencyWhile(async () => {
		if (host.isMember(principalId)) return false;
		await dropLimits(host, principalId);
		return true;
	});
}

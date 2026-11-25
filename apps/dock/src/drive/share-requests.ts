import type { DriveShareRequest } from "@asterra/contracts";
import { newId } from "../platform/index.ts";

// The requests of agents and service accounts to share a Drive item with a different agent or service account
// (`drive_share_requests` in D1). An agent cannot give such an account a grant itself. It asks, and a person
// who manages that account decides. A request is about the access of an account, and its list goes across
// drives, so the directory has it, as it has the requests of the rooms of Chat. The object of the drive still
// decides the grant: an approval calls it, as the agent that asked.

/** One request as the directory has it. */
export interface ShareRequestRow extends DriveShareRequest {
	/** The person who got the request in the activity list of Chat, or null. */
	notified_id: string | null;
}

const COLUMNS =
	"r.id, r.space_id, r.item_id, r.item_name, r.principal_id, r.requested_by, r.role, r.notified_id, r.created_at";

/** The request as an operation returns it. */
export function toShareRequest({ notified_id: _, ...request }: ShareRequestRow): DriveShareRequest {
	return request;
}

/** The id of the activity item of a request, in the activity list of the person who decides. */
export function shareRequestActivityId(requestId: string): string {
	return `act_${requestId}`;
}

export async function getShareRequest(db: D1Database, id: string): Promise<ShareRequestRow | null> {
	return db.prepare(`SELECT ${COLUMNS} FROM drive_share_requests r WHERE r.id = ?`).bind(id).first<ShareRequestRow>();
}

/**
 * Stores a request, or returns the request that the item has for that account. `created` is false for a
 * request from an earlier call. Returns null when the item has `most` requests and this one is new.
 */
export async function createShareRequest(
	db: D1Database,
	input: Omit<DriveShareRequest, "id" | "created_at"> & { notifiedId: string | null },
	most: number,
): Promise<{ request: ShareRequestRow; created: boolean } | null> {
	const id = newId("srq");
	// A request for an account that is archived or deleted cannot complete, and nobody sees it. It must not use a
	// place of the item, so the call removes such requests of the item first.
	await db
		.prepare(
			`DELETE FROM drive_share_requests WHERE space_id = ?1 AND item_id = ?2 AND principal_id IN (
				SELECT p.id FROM principals p WHERE p.deleted_at IS NOT NULL OR p.archived_at IS NOT NULL
			)`,
		)
		.bind(input.space_id, input.item_id)
		.run();
	// One statement: the count and the insert have no other request between them.
	const inserted = await db
		.prepare(
			`INSERT INTO drive_share_requests (id, space_id, item_id, item_name, principal_id, requested_by, role, notified_id, created_at)
			SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
			WHERE (SELECT COUNT(*) FROM drive_share_requests WHERE space_id = ?2 AND item_id = ?3) < ?10
			ON CONFLICT (space_id, item_id, principal_id) DO NOTHING`,
		)
		.bind(
			id,
			input.space_id,
			input.item_id,
			input.item_name,
			input.principal_id,
			input.requested_by,
			input.role,
			input.notifiedId,
			new Date().toISOString(),
			most,
		)
		.run();
	const row = await db
		.prepare(
			`SELECT ${COLUMNS} FROM drive_share_requests r WHERE r.space_id = ? AND r.item_id = ? AND r.principal_id = ?`,
		)
		.bind(input.space_id, input.item_id, input.principal_id)
		.first<ShareRequestRow>();
	if (!row) return null;
	return { request: row, created: inserted.meta.changes === 1 && row.id === id };
}

/** Deletes a request. Returns false when a different call deleted it first. */
export async function deleteShareRequest(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare("DELETE FROM drive_share_requests WHERE id = ?").bind(id).run();
	return result.meta.changes === 1;
}

/** Records a different person as the one who got the request in the activity list. */
export async function setShareRequestNotified(db: D1Database, id: string, personId: string | null): Promise<void> {
	await db.prepare("UPDATE drive_share_requests SET notified_id = ? WHERE id = ?").bind(personId, id).run();
}

/** The most requests that one list returns. */
const LIST_MAX = 200;

/**
 * The requests that a person can decide, the newest first: the requests for each agent that the person
 * sponsors, and with `admin` the requests for each agent and each service account. A deleted or archived
 * account has no request in the list. With `principalId`, only the requests for that account.
 */
export async function listShareRequestsFor(
	db: D1Database,
	input: { personId: string; admin: boolean; principalId: string | null },
): Promise<ShareRequestRow[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM drive_share_requests r JOIN principals p ON p.id = r.principal_id
			WHERE p.kind = 'agent' AND p.deleted_at IS NULL AND p.archived_at IS NULL
				AND (?1 = 1 OR (p.service = 0 AND p.sponsor_id = ?2))
				AND (?3 IS NULL OR r.principal_id = ?3)
			ORDER BY r.created_at DESC, r.id DESC LIMIT ?4`,
		)
		.bind(input.admin ? 1 : 0, input.personId, input.principalId, LIST_MAX)
		.all<ShareRequestRow>();
	return results;
}

/**
 * The requests that an agent or a service account made, the newest first. A request for an account that is
 * archived or deleted cannot complete, so the list leaves it out.
 */
export async function listShareRequestsBy(
	db: D1Database,
	requesterId: string,
	principalId: string | null,
): Promise<ShareRequestRow[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM drive_share_requests r JOIN principals p ON p.id = r.principal_id
			WHERE r.requested_by = ?1 AND (?2 IS NULL OR r.principal_id = ?2)
				AND p.deleted_at IS NULL AND p.archived_at IS NULL
			ORDER BY r.created_at DESC, r.id DESC LIMIT ?3`,
		)
		.bind(requesterId, principalId, LIST_MAX)
		.all<ShareRequestRow>();
	return results;
}

/**
 * The ids of the list that are requests that this person can decide now (as `listShareRequestsFor`). The
 * activity list drops each other item.
 */
export async function liveShareRequestIds(
	db: D1Database,
	ids: readonly string[],
	person: { id: string; admin: boolean },
): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const { results } = await db
		.prepare(
			`SELECT r.id FROM drive_share_requests r JOIN json_each(?1) wanted ON wanted.value = r.id
			JOIN principals p ON p.id = r.principal_id
			WHERE p.kind = 'agent' AND p.deleted_at IS NULL AND p.archived_at IS NULL
				AND (?2 = 1 OR (p.service = 0 AND p.sponsor_id = ?3))`,
		)
		.bind(JSON.stringify([...new Set(ids)]), person.admin ? 1 : 0, person.id)
		.all<{ id: string }>();
	return new Set(results.map((row) => row.id));
}

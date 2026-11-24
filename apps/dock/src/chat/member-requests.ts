import type { ChatMemberRequest, RoomMemberScope } from "@asterra/contracts";
import { newId } from "../platform/index.ts";

// The requests of agents and service accounts to make a different agent or service account a member of a
// room (`chat_member_requests` in D1). An agent cannot put an agent into a room itself. It asks, and a person
// who manages that account decides. A request is about the access of an account, and its list goes across
// rooms, so the directory has it, as it has the OAuth requests. The room object still decides who is a
// member: an approval calls the room.

/** One request as the directory has it. */
export interface MemberRequestRow extends ChatMemberRequest {
	/** The person who got the request in the activity list of Chat, or null. */
	notified_id: string | null;
}

interface StoredRow {
	id: string;
	room_id: string;
	room_name: string | null;
	principal_id: string;
	requested_by: string;
	scopes: string;
	notified_id: string | null;
	created_at: string;
}

const COLUMNS = "r.id, r.room_id, r.room_name, r.principal_id, r.requested_by, r.scopes, r.notified_id, r.created_at";

function toRow(row: StoredRow): MemberRequestRow {
	return { ...row, scopes: JSON.parse(row.scopes) as RoomMemberScope[] };
}

/** The request as an operation returns it. */
export function toMemberRequest({ notified_id: _, ...request }: MemberRequestRow): ChatMemberRequest {
	return request;
}

/** The id of the activity item of a request, in the activity list of the person who decides. */
export function memberRequestActivityId(requestId: string): string {
	return `act_${requestId}`;
}

export async function getMemberRequest(db: D1Database, id: string): Promise<MemberRequestRow | null> {
	const row = await db
		.prepare(`SELECT ${COLUMNS} FROM chat_member_requests r WHERE r.id = ?`)
		.bind(id)
		.first<StoredRow>();
	return row ? toRow(row) : null;
}

/**
 * Stores a request, or returns the request that the room has for that account. `created` is false for a
 * request from an earlier call. Returns null when the room has `most` requests and this one is new.
 */
export async function createMemberRequest(
	db: D1Database,
	input: {
		roomId: string;
		roomName: string | null;
		principalId: string;
		requestedBy: string;
		scopes: readonly RoomMemberScope[];
		notifiedId: string | null;
	},
	most: number,
): Promise<{ request: MemberRequestRow; created: boolean } | null> {
	const id = newId("mrq");
	// One statement: the count and the insert have no other request between them.
	const inserted = await db
		.prepare(
			`INSERT INTO chat_member_requests (id, room_id, room_name, principal_id, requested_by, scopes, notified_id, created_at)
			SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
			WHERE (SELECT COUNT(*) FROM chat_member_requests WHERE room_id = ?2) < ?9
			ON CONFLICT (room_id, principal_id) DO NOTHING`,
		)
		.bind(
			id,
			input.roomId,
			input.roomName,
			input.principalId,
			input.requestedBy,
			JSON.stringify(input.scopes),
			input.notifiedId,
			new Date().toISOString(),
			most,
		)
		.run();
	const row = await db
		.prepare(`SELECT ${COLUMNS} FROM chat_member_requests r WHERE r.room_id = ? AND r.principal_id = ?`)
		.bind(input.roomId, input.principalId)
		.first<StoredRow>();
	if (!row) return null;
	return { request: toRow(row), created: inserted.meta.changes === 1 && row.id === id };
}

/** Deletes a request. Returns false when a different call deleted it first. */
export async function deleteMemberRequest(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare("DELETE FROM chat_member_requests WHERE id = ?").bind(id).run();
	return result.meta.changes === 1;
}

/** The most requests that one list returns. */
const LIST_MAX = 200;

/**
 * The requests that a person can decide, the newest first: the requests for each agent that the person
 * sponsors, and with `admin` the requests for each agent and each service account. A deleted or archived
 * account has no request in the list. With `principalId`, only the requests for that account.
 */
export async function listMemberRequestsFor(
	db: D1Database,
	input: { personId: string; admin: boolean; principalId: string | null },
): Promise<MemberRequestRow[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM chat_member_requests r JOIN principals p ON p.id = r.principal_id
			WHERE p.kind = 'agent' AND p.deleted_at IS NULL AND p.archived_at IS NULL
				AND (?1 = 1 OR (p.service = 0 AND p.sponsor_id = ?2))
				AND (?3 IS NULL OR r.principal_id = ?3)
			ORDER BY r.created_at DESC, r.id DESC LIMIT ?4`,
		)
		.bind(input.admin ? 1 : 0, input.personId, input.principalId, LIST_MAX)
		.all<StoredRow>();
	return results.map(toRow);
}

/** The requests that an agent or a service account made, the newest first. */
export async function listMemberRequestsBy(db: D1Database, requesterId: string): Promise<MemberRequestRow[]> {
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM chat_member_requests r WHERE r.requested_by = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
		)
		.bind(requesterId, LIST_MAX)
		.all<StoredRow>();
	return results.map(toRow);
}

/** The ids of the list that are requests now. The activity list drops an item of a request that is gone. */
export async function liveMemberRequestIds(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const { results } = await db
		.prepare("SELECT r.id FROM chat_member_requests r JOIN json_each(?) wanted ON wanted.value = r.id")
		.bind(JSON.stringify([...new Set(ids)]))
		.all<{ id: string }>();
	return new Set(results.map((row) => row.id));
}

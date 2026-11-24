import type { ChatAdminRoom, PostingPolicy, RoomKind, RoomRole } from "@asterra/contracts";
import { decodeCursor, encodeCursor, log } from "../platform/index.ts";
import { type ActorRecord, nameKey, type RoomRecord } from "./room.ts";

// Reads of the Chat index in D1 (`chat_rooms`, `chat_members`). Each `ChatRoomDO` writes its own rows.
// The index is a copy for the public list. The room object decides each access. The joined list comes
// from the `PrincipalDO` of the caller (principal-rooms.ts).

interface IndexRow {
	id: string;
	kind: RoomKind;
	name: string | null;
	name_key: string | null;
	topic: string;
	created_at: number;
	created_by_json: string;
	member_count: number;
	last_seq: number;
	last_message_at: number | null;
	activity_at: number;
	version: number;
	archived_at: number | null;
	posting_policy: PostingPolicy;
	retention_days: number | null;
	owner_count: number;
	role: RoomRole | null;
	last_read_seq: number | null;
	peer_json: string | null;
}

export interface RoomPage {
	rooms: RoomRecord[];
	nextCursor: string | null;
}

const COLUMNS = `r.id, r.kind, r.name, r.name_key, r.topic, r.created_at, r.created_by_json, r.member_count, r.last_seq,
	r.last_message_at, r.activity_at, r.version, r.archived_at, r.posting_policy, r.retention_days, r.owner_count,
	m.role, m.last_read_seq, m.peer_json`;

function toRecord(row: IndexRow): RoomRecord {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		topic: row.topic,
		peer: row.peer_json === null ? null : (JSON.parse(row.peer_json) as ActorRecord),
		peers: [],
		created_at: row.created_at,
		created_by: JSON.parse(row.created_by_json) as ActorRecord,
		member_count: row.member_count,
		role: row.role,
		last_seq: row.last_seq,
		last_message_at: row.last_message_at,
		// The read marker of a member comes from its `PrincipalDO`. The index has only the marker of the join.
		last_read_seq: row.last_read_seq ?? 0,
		unread: false,
		unread_count: 0,
		mention_count: 0,
		version: row.version,
		// The star of a member is in its `PrincipalDO`. The index has no stars.
		starred: false,
		archived_at: row.archived_at,
		posting_policy: row.posting_policy,
		can_post: row.archived_at === null && (row.posting_policy === "members" || row.role === "owner"),
		retention_days: row.retention_days,
	};
}

export interface ListInput {
	query: string | null;
	cursor: string | null;
	limit: number;
}

function page(rows: IndexRow[], limit: number, cursorOf: (row: IndexRow) => (string | number)[]): RoomPage {
	const shown = rows.slice(0, limit);
	const last = shown[shown.length - 1];
	return {
		rooms: shown.map(toRecord),
		nextCursor: rows.length > limit && last ? encodeCursor(cursorOf(last)) : null,
	};
}

/**
 * Each public room, in the order of the names, with the role of the principal in the rooms that it
 * joined. Returns null for a cursor that is not from this list.
 */
export async function listPublicRooms(db: D1Database, principalId: string, input: ListInput): Promise<RoomPage | null> {
	const cursor = input.cursor === null ? null : decodeCursor<[string, string]>(input.cursor, ["string", "string"]);
	if (input.cursor !== null && cursor === null) return null;
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM chat_rooms r
			LEFT JOIN chat_members m ON m.room_id = r.id AND m.principal_id = ?1
			WHERE r.kind = 'public' AND r.archived_at IS NULL
				AND (?2 IS NULL OR instr(r.name_key, ?2) > 0)
				AND (?3 IS NULL OR r.name_key > ?3 OR (r.name_key = ?3 AND r.id > ?4))
			ORDER BY r.name_key, r.id LIMIT ?5`,
		)
		.bind(
			principalId,
			input.query === null ? null : nameKey(input.query),
			cursor?.[0] ?? null,
			cursor?.[1] ?? null,
			input.limit + 1,
		)
		.all<IndexRow>();
	return page(results, input.limit, (row) => [row.name_key ?? "", row.id]);
}

/** Lists all rooms in the organization (metadata only) for admins and owners. */
export async function adminListRooms(
	db: D1Database,
	callerId: string,
	isOrgOwner: boolean,
	input: {
		kind: "all" | "public" | "private";
		ownerless: boolean;
		archived: "all" | "active" | "archived";
		query: string | null;
		cursor: string | null;
		limit: number;
	},
): Promise<{ rooms: ChatAdminRoom[]; nextCursor: string | null } | null> {
	const cursor = input.cursor === null ? null : decodeCursor<[number, string]>(input.cursor, ["number", "string"]);
	if (input.cursor !== null && cursor === null) return null;
	const clauses: string[] = [];
	const params: (string | number | null)[] = [callerId];
	if (input.kind === "all") {
		clauses.push("r.kind IN ('public', 'private')");
	} else {
		clauses.push("r.kind = ?");
		params.push(input.kind);
	}
	if (input.ownerless) {
		clauses.push("r.owner_count = 0");
	}
	if (input.archived === "archived") {
		clauses.push("r.archived_at IS NOT NULL");
	} else if (input.archived === "active") {
		clauses.push("r.archived_at IS NULL");
	}
	if (input.query !== null) {
		clauses.push("instr(COALESCE(r.name_key, ''), ?) > 0");
		params.push(nameKey(input.query));
	}
	if (cursor !== null) {
		clauses.push("(r.activity_at < ? OR (r.activity_at = ? AND r.id < ?))");
		params.push(cursor[0], cursor[0], cursor[1]);
	}
	params.push(input.limit + 1);
	const { results } = await db
		.prepare(
			`SELECT r.id, r.kind, r.name, r.topic, r.created_at, r.created_by_json, r.member_count,
				r.owner_count, r.last_seq, r.last_message_at, r.activity_at, r.archived_at,
				r.posting_policy, r.retention_days, (m.principal_id IS NOT NULL) AS is_member
			FROM chat_rooms r
			LEFT JOIN chat_members m ON m.room_id = r.id AND m.principal_id = ?1
			WHERE ${clauses.join(" AND ")}
			ORDER BY r.activity_at DESC, r.id DESC LIMIT ?`,
		)
		.bind(...params)
		.all<{
			id: string;
			kind: RoomKind;
			name: string | null;
			topic: string;
			created_at: number;
			created_by_json: string;
			member_count: number;
			owner_count: number;
			last_seq: number;
			last_message_at: number | null;
			activity_at: number;
			archived_at: number | null;
			posting_policy: PostingPolicy;
			retention_days: number | null;
			is_member: number;
		}>();
	const shown = results.slice(0, input.limit);
	const last = shown[shown.length - 1];
	const iso = (ms: number) => new Date(ms).toISOString();
	return {
		rooms: shown.map((row) => {
			const isMember = row.is_member === 1;
			return {
				id: row.id,
				kind: row.kind,
				name: row.name,
				topic: row.topic,
				created_at: iso(row.created_at),
				created_by: JSON.parse(row.created_by_json) as ActorRecord,
				member_count: row.member_count,
				owner_count: row.owner_count,
				last_seq: row.last_seq,
				last_message_at: row.last_message_at === null ? null : iso(row.last_message_at),
				archived_at: row.archived_at === null ? null : iso(row.archived_at),
				posting_policy: row.posting_policy,
				retention_days: row.retention_days,
				is_member: isMember,
				exportable: isOrgOwner && (row.kind === "public" || isMember),
			};
		}),
		nextCursor: results.length > input.limit && last ? encodeCursor([last.activity_at, last.id]) : null,
	};
}

/** Removes a deleted principal from rooms it belonged to (bounded per call). Idempotent. */
export async function removeDeletedPrincipalFromRooms(
	env: Pick<Env, "DIRECTORY" | "CHAT_ROOM">,
	principalId: string,
	maxRooms = 500,
): Promise<{ roomsCleaned: number; failedRoomIds: string[] }> {
	const { results } = await env.DIRECTORY.prepare("SELECT room_id FROM chat_members WHERE principal_id = ? LIMIT ?")
		.bind(principalId, maxRooms)
		.all<{ room_id: string }>();
	let roomsCleaned = 0;
	const failedRoomIds: string[] = [];
	const PARALLEL = 25;
	for (let i = 0; i < results.length; i += PARALLEL) {
		const chunk = results.slice(i, i + PARALLEL);
		const settled = await Promise.allSettled(
			chunk.map(async ({ room_id }) => {
				const res = await env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room_id)).forceRemoveMember(principalId);
				if (res.removed) roomsCleaned += 1;
				else {
					await env.DIRECTORY.prepare("DELETE FROM chat_members WHERE principal_id = ? AND room_id = ?")
						.bind(principalId, room_id)
						.run();
					roomsCleaned += 1;
				}
			}),
		);
		settled.forEach((item, index) => {
			if (item.status === "rejected") {
				const roomId = chunk[index]?.room_id;
				if (roomId) failedRoomIds.push(roomId);
				log("warn", "failed to remove deleted principal from room", {
					principalId,
					roomId,
					error: item.reason instanceof Error ? item.reason.message : String(item.reason),
				});
			}
		});
	}
	return { roomsCleaned, failedRoomIds };
}

/**
 * The rooms of the list that the index has the principal as a member of. The index can be a moment
 * behind a room, so this is a first filter only: the object of the room decides each access.
 */
export async function joinedRoomIds(
	db: D1Database,
	principalId: string,
	roomIds: readonly string[],
): Promise<Set<string>> {
	if (roomIds.length === 0) return new Set();
	const { results } = await db
		.prepare(
			`SELECT m.room_id FROM chat_members m JOIN json_each(?2) wanted ON wanted.value = m.room_id
			WHERE m.principal_id = ?1`,
		)
		.bind(principalId, JSON.stringify([...new Set(roomIds)]))
		.all<{ room_id: string }>();
	return new Set(results.map((row) => row.room_id));
}

/**
 * The service accounts that the index has as members of a room. A delete of the room reads them first,
 * for the activity log of each account.
 */
export async function serviceMemberIds(db: D1Database, roomId: string): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT m.principal_id FROM chat_members m JOIN principals p ON p.id = m.principal_id
			WHERE m.room_id = ? AND p.service = 1 AND p.deleted_at IS NULL`,
		)
		.bind(roomId)
		.all<{ principal_id: string }>();
	return results.map((row) => row.principal_id);
}

/** A room of a principal for the access view: `peer_name` is the other member of a direct message. */
interface PrincipalRoom {
	id: string;
	kind: string;
	name: string | null;
	peer_name: string | null;
	role: string;
}

/**
 * The rooms that the index has the principal as a member of, with its role: the named rooms first, in the
 * order of their names, then the direct messages. At most `limit` rooms. `truncated` is true when the
 * principal has more. The access view of a service account reads it. The index can be a moment behind a
 * room, and the room object still decides each access.
 */
export async function roomsOfPrincipal(
	db: D1Database,
	principalId: string,
	limit: number,
): Promise<{ rooms: PrincipalRoom[]; truncated: boolean }> {
	const { results } = await db
		.prepare(
			`SELECT r.id, r.kind, r.name, json_extract(m.peer_json, '$.display_name') AS peer_name, m.role
			FROM chat_members m JOIN chat_rooms r ON r.id = m.room_id
			WHERE m.principal_id = ?1 ORDER BY r.name_key IS NULL, r.name_key, r.id LIMIT ?2`,
		)
		.bind(principalId, limit + 1)
		.all<PrincipalRoom>();
	return { rooms: results.slice(0, limit), truncated: results.length > limit };
}

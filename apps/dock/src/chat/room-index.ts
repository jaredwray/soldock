import type { RoomKind, RoomRole } from "@soldock/contracts";
import { type ActorRecord, nameKey, type RoomRecord } from "./room.ts";

// Reads of the Chat index in D1 (`chat_rooms`, `chat_members`). Each `ChatRoomDO` writes its own rows.
// The index is a copy for the lists. The room object decides each access.

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
	role: RoomRole | null;
	last_read_seq: number | null;
	peer_json: string | null;
}

export interface RoomPage {
	rooms: RoomRecord[];
	nextCursor: string | null;
}

const COLUMNS = `r.id, r.kind, r.name, r.name_key, r.topic, r.created_at, r.created_by_json, r.member_count, r.last_seq,
	r.last_message_at, r.activity_at, r.version, m.role, m.last_read_seq, m.peer_json`;

function toRecord(row: IndexRow): RoomRecord {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		topic: row.topic,
		peer: row.peer_json === null ? null : (JSON.parse(row.peer_json) as ActorRecord),
		created_at: row.created_at,
		created_by: JSON.parse(row.created_by_json) as ActorRecord,
		member_count: row.member_count,
		role: row.role,
		last_seq: row.last_seq,
		last_message_at: row.last_message_at,
		last_read_seq: row.last_read_seq ?? 0,
		unread: row.role !== null && row.last_seq > (row.last_read_seq ?? 0),
		version: row.version,
	};
}

/** A cursor is base64url of the UTF-8 bytes of JSON. A name in a cursor can have characters of each script. */
function encodeCursor(values: (string | number)[]): string {
	const bytes = new TextEncoder().encode(JSON.stringify(values));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/** The values of a cursor, or null when the text is not a cursor with these value types. */
function decodeCursor<T extends (string | number)[]>(cursor: string, types: ("string" | "number")[]): T | null {
	try {
		const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const values: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		if (!Array.isArray(values) || values.length !== types.length) return null;
		if (values.some((value, index) => typeof value !== types[index])) return null;
		return values as T;
	} catch {
		return null;
	}
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
 * The rooms that a principal is a member of, with the newest message first. Returns null for a cursor
 * that is not from this list.
 */
export async function listJoinedRooms(db: D1Database, principalId: string, input: ListInput): Promise<RoomPage | null> {
	const cursor = input.cursor === null ? null : decodeCursor<[number, string]>(input.cursor, ["number", "string"]);
	if (input.cursor !== null && cursor === null) return null;
	const { results } = await db
		.prepare(
			`SELECT ${COLUMNS} FROM chat_members m JOIN chat_rooms r ON r.id = m.room_id
			WHERE m.principal_id = ?1
				AND (?2 IS NULL OR instr(r.name_key, ?2) > 0)
				AND (?3 IS NULL OR r.activity_at < ?3 OR (r.activity_at = ?3 AND r.id < ?4))
			ORDER BY r.activity_at DESC, r.id DESC LIMIT ?5`,
		)
		.bind(
			principalId,
			input.query === null ? null : nameKey(input.query),
			cursor?.[0] ?? null,
			cursor?.[1] ?? null,
			input.limit + 1,
		)
		.all<IndexRow>();
	return page(results, input.limit, (row) => [row.activity_at, row.id]);
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
			WHERE r.kind = 'public'
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

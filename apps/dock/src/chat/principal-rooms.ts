import type { ChatRoomEntry, ChatRoomState } from "../identity/index.ts";
import { log } from "../platform/index.ts";
import { type ActorRecord, nameKey, type RoomRecord } from "./room.ts";
import { decodeCursor, encodeCursor, type ListInput, type RoomPage } from "./room-index.ts";

// The joined rooms of a principal, from its `PrincipalDO`. Each room sends its state to the objects of
// its members after each change (room.ts, `sendStates`). The room object decides each access.

/** The rooms that the first fill asks at the same time. */
const SEED_PARALLEL = 25;
/** The most rooms that the first fill asks in one request. */
const SEED_MAX = 200;

function principalStub(env: Pick<Env, "PRINCIPAL">, principalId: string) {
	return env.PRINCIPAL.get(env.PRINCIPAL.idFromName(principalId));
}

function toRecord(entry: ChatRoomEntry): RoomRecord {
	return {
		id: entry.room_id,
		kind: entry.kind,
		name: entry.name,
		topic: entry.topic,
		peer: entry.peer_json === null ? null : (JSON.parse(entry.peer_json) as ActorRecord),
		created_at: entry.created_at,
		created_by: JSON.parse(entry.created_by_json) as ActorRecord,
		member_count: entry.member_count,
		role: entry.role,
		last_seq: entry.last_seq,
		last_message_at: entry.last_message_at,
		last_read_seq: entry.last_read_seq,
		unread: entry.unread_count > 0,
		unread_count: entry.unread_count,
		version: entry.version,
		starred: entry.starred,
	};
}

/**
 * Fills a `PrincipalDO` that has no Chat state yet. The rooms that the principal joined before the
 * object existed are in the index in D1 only, so the fill asks each of those rooms for its state.
 *
 * - The fill asks only the rooms that sent no state to the object yet.
 * - It asks at most `SEED_MAX` rooms in one call, so one request has a limit of calls. The next list
 *   continues the fill.
 * - It asks the rooms in the order of the joined list: the newest activity in the index first. So a
 *   page of a fill that is not complete has the newest rooms, and the rooms of a later part come
 *   after the cursor of that page.
 * - It keeps the states of each part when the part ends. A room that does not answer does not stop
 *   the fill. The next list asks it again.
 * - The fill is complete when each room answered. A room that sent a newer state first keeps it:
 *   see `stamp`.
 *
 * Returns null when the fill is complete. Else it returns the place in the list of the last room
 * that the fill asked, by the index. Each room that the fill did not ask comes after that place.
 */
async function seed(env: Env, principalId: string): Promise<Position | null> {
	const principal = principalStub(env, principalId);
	const { results } = await env.DIRECTORY.prepare(
		`SELECT m.room_id, r.activity_at FROM chat_members m JOIN chat_rooms r ON r.id = m.room_id
		WHERE m.principal_id = ? ORDER BY r.activity_at DESC, r.id DESC`,
	)
		.bind(principalId)
		.all<{ room_id: string; activity_at: number }>();
	const activity = new Map(results.map((row) => [row.room_id, row.activity_at]));
	const unknown = await principal.unknownChatRooms(results.map((row) => row.room_id));
	const asked = unknown.slice(0, SEED_MAX);
	let failed = 0;
	for (let start = 0; start < asked.length; start += SEED_PARALLEL) {
		const part = asked.slice(start, start + SEED_PARALLEL);
		const answers = await Promise.allSettled(
			part.map((roomId) => env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId)).stateFor(principalId)),
		);
		const states: ChatRoomState[] = [];
		for (const answer of answers) {
			if (answer.status === "rejected") failed += 1;
			else if (answer.value) states.push(answer.value);
		}
		await principal.seedChat(states, false);
	}
	if (failed > 0) log("warn", "chat principal fill: rooms did not answer", { rooms: failed });
	if (failed === 0 && asked.length === unknown.length) {
		await principal.seedChat([], true);
		return null;
	}
	const last = asked[asked.length - 1] as string;
	return { activityAt: activity.get(last) ?? 0, roomId: last };
}

/** A place in the joined list: the newest activity first, then the highest id. */
interface Position {
	activityAt: number;
	roomId: string;
}

/** True when `a` comes after `b` in the joined list. */
function isAfter(a: Position, b: Position): boolean {
	return a.activityAt < b.activityAt || (a.activityAt === b.activityAt && a.roomId < b.roomId);
}

/**
 * The rooms that a principal is a member of, with the newest message first. With `starred`, only the
 * rooms with the star of the principal. Returns null for a cursor that is not from this list.
 */
export async function listJoinedRooms(
	env: Env,
	principalId: string,
	input: ListInput,
	starred = false,
): Promise<RoomPage | null> {
	const cursor = input.cursor === null ? null : decodeCursor<[number, string]>(input.cursor, ["number", "string"]);
	if (input.cursor !== null && cursor === null) return null;
	const principal = principalStub(env, principalId);
	const after = cursor === null ? null : { activityAt: cursor[0], roomId: cursor[1] };
	const query = {
		nameKey: input.query === null ? null : nameKey(input.query),
		after,
		until: null,
		starred,
		limit: input.limit,
	};
	let listed = await principal.listChatRooms(query);
	// While the fill is not complete, the page ends at the place that the fill reached. The rooms after
	// it can come in a later part, so the page gives a cursor to that place. The next list continues
	// the fill, and then the list after that place. A search then finds an old room too.
	let reached: Position | null = null;
	if (!listed.seeded) {
		reached = await seed(env, principalId);
		if (reached !== null && after !== null && !isAfter(reached, after)) reached = null;
		listed = await principal.listChatRooms({ ...query, until: reached });
	}
	const shown = listed.rooms.slice(0, input.limit);
	const last = shown[shown.length - 1];
	let nextCursor = listed.rooms.length > input.limit && last ? encodeCursor([last.activity_at, last.room_id]) : null;
	if (nextCursor === null && reached !== null) nextCursor = encodeCursor([reached.activityAt, reached.roomId]);
	return { rooms: shown.map(toRecord), nextCursor };
}

/**
 * The rooms of a page with the state of the principal in each room that it joined: the role, the read
 * marker and the unread count. The index in D1 has no read marker. A room that the `PrincipalDO` does
 * not have yet keeps the values of the index. The first fill of the object runs here too, as for the
 * joined list.
 */
export async function withOwnState(env: Env, principalId: string, page: RoomPage): Promise<RoomPage> {
	const ids = page.rooms.map((room) => room.id);
	if (ids.length === 0) return page;
	const principal = principalStub(env, principalId);
	let found = await principal.chatRoomsOf(ids);
	if (!found.seeded) {
		await seed(env, principalId);
		found = await principal.chatRoomsOf(ids);
	}
	const own = new Map(found.rooms.map((entry) => [entry.room_id, toRecord(entry)]));
	return { ...page, rooms: page.rooms.map((room) => own.get(room.id) ?? room) };
}

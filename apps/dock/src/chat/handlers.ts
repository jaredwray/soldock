import {
	CHAT_LIMITS,
	type ChatRoom,
	type ChatSearchResult,
	type ChatSearchRoom,
	type ChatThreadFollow,
	defaultRoomMemberScopes,
	isCustomEmoji,
	mentionDirectory,
	type OperationName,
	prefixedId,
	RoomId,
} from "@asterra/contracts";
import { filesForMessage } from "../drive/index.ts";
import {
	type CallContext,
	canManageAgent,
	chatPresenceHandlers,
	getPrincipal,
	getPrincipals,
	isAdmin,
	mentionCandidates,
	type PrincipalRecord,
	recordServiceMemberships,
} from "../identity/index.ts";
import {
	audit,
	decodeCursor,
	encodeCursor,
	type HandlerMap,
	log,
	newId,
	OperationError,
	sha256Hex,
} from "../platform/index.ts";
import { bodyMarkdown, type MessageContent, messageContent, textBody } from "./body.ts";
import { hasCustomEmoji } from "./custom-emoji.ts";
import { downloadChatFile, downloadLinkImage } from "./files.ts";
import { chatLayer8Handlers } from "./layer8-handlers.ts";
import {
	createMemberRequest,
	deleteMemberRequest,
	getMemberRequest,
	listMemberRequestsBy,
	listMemberRequestsFor,
	type MemberRequestRow,
	memberRequestActivityId,
	memberRequestsOfRoom,
	setMemberRequestNotified,
	toMemberRequest,
} from "./member-requests.ts";
import { chatNotificationHandlers } from "./notification-handlers.ts";
import {
	joinedRoomRefs,
	listAddressedChanges,
	listFollowedThreads,
	listJoinedRooms,
	withOwnState,
} from "./principal-rooms.ts";
import {
	type ActorRecord,
	messageOutput,
	nameKey,
	type Refusal,
	type RoomCall,
	type RoomRecord,
	type SearchHitRecord,
	type ThreadFollowRecord,
} from "./room.ts";
import { listPublicRooms } from "./room-index.ts";
import { type ParsedSearch, parseSearch, type SearchFilter } from "./search.ts";
import { type SearchHit, searchIndex } from "./search-index.ts";
import { chatWebhookHandlers } from "./webhooks.ts";

type ChatOperation = Extract<OperationName, `chat.${string}`>;

const DEFAULT_PAGE = 50;
/** The results of a page of a search without `limit`. */
const SEARCH_PAGE = 20;
/** The rooms that a search reads at the same time: the rooms of the hits, and the rooms that the index does not know. */
const SEARCH_PARALLEL = 25;
/** The most times that one search asks the index: again after a room refused the caller. */
const SEARCH_ATTEMPTS = 3;
const PrincipalId = prefixedId("prn");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function roomStub(env: Pick<Env, "CHAT_ROOM">, roomId: string) {
	return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
}

function actorOf(call: CallContext): ActorRecord {
	const { principal } = call.caller;
	return { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name };
}

/** The object of a room, with the caller for it. The object decides what the caller can do. */
function openRoom(call: CallContext, roomId: string): { room: ReturnType<typeof roomStub>; ctx: RoomCall } {
	return { room: roomStub(call.env, roomId), ctx: { roomId, actor: actorOf(call) } };
}

/**
 * The rooms of the list that each room confirms, for an agent or a service account without chat.read on its
 * account. Such an account could not read a room before the memberships decided the access of agents, and a
 * room that did not wake since then still has its membership from before in the list. Each room narrows that
 * membership when it wakes (`narrowAgentMembers`), so the list asks each room and shows its answer. Each
 * other caller gets the list as it is.
 */
async function confirmedRooms<T extends { id: string }>(call: CallContext, rooms: readonly T[]): Promise<T[]> {
	if (call.caller.principal.kind !== "agent" || call.caller.scopes.has("chat.read")) return [...rooms];
	const answers = await Promise.all(
		rooms.map(async (room) => {
			const opened = openRoom(call, room.id);
			const found = await opened.room.get(opened.ctx);
			return "error" in found || found.room.role === null ? null : room;
		}),
	);
	return answers.filter((room): room is Awaited<T> => room !== null);
}

/** Turns a refusal from an object into an OperationError, and returns any other result. */
function accept<T extends object>(value: T): Exclude<T, { error: unknown }> {
	if ("error" in value) {
		const { error } = value as unknown as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, { error: unknown }>;
}

/** The content of a new or changed message. A message with files can have no text. */
function contentOf(input: {
	text?: string | undefined;
	markdown?: string | undefined;
	body?: unknown;
}): MessageContent | null {
	if (input.text === undefined && input.markdown === undefined && input.body === undefined) return null;
	return messageContent(input as Parameters<typeof messageContent>[0]);
}

/** The state of a thread for the caller, as the operations return it. */
function followOutput(follow: ThreadFollowRecord): ChatThreadFollow {
	return { following: follow.following, last_read_seq: follow.lastReadSeq, unread_count: follow.unreadCount };
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function toRoom(record: RoomRecord): ChatRoom {
	return {
		...record,
		peers: record.peers ?? [],
		archived_at: record.archived_at == null ? null : iso(record.archived_at),
		posting_policy: record.posting_policy ?? "members",
		can_post: record.can_post ?? true,
		retention_days: record.retention_days ?? null,
		created_at: iso(record.created_at),
		last_message_at: record.last_message_at === null ? null : iso(record.last_message_at),
	};
}

function auditOk(call: CallContext, op: string, target: string): void {
	audit({
		op,
		actor: call.caller.id,
		actorKind: call.caller.kind,
		credential: call.caller.credential,
		target,
		result: "ok",
		requestId: call.requestId,
	});
}

/** The principals of a list of ids, as a room stores its members. Each id must be in the directory. */
async function principalsOf(call: CallContext, ids: readonly string[]): Promise<PrincipalRecord[]> {
	const principals = await getPrincipals(call.env.DIRECTORY, ids);
	const known = new Set(principals.map((principal) => principal.id));
	const unknown = ids.find((id) => !known.has(id));
	if (unknown !== undefined) throw new OperationError("not_found", `No person or agent has the id ${unknown}.`);
	return principals;
}

function toActor(principal: PrincipalRecord): ActorRecord {
	return { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name };
}

const NO_REQUEST = "No request has that id, or you cannot decide it.";

/**
 * The person who gets a request for this account in the activity list of Chat. For an agent: its sponsor.
 * Only an owner or an admin manages a service account, so its sponsor gets the request only with one of
 * these roles. If not, the owner of the organization gets it. Each owner and admin also sees the request on
 * the page of the account in Admin, Members.
 */
async function deciderOf(call: CallContext, target: PrincipalRecord): Promise<string | null> {
	const db = call.env.DIRECTORY;
	if (target.sponsor_id !== null) {
		if (!target.service) return target.sponsor_id;
		const sponsor = await getPrincipal(db, target.sponsor_id);
		if (sponsor?.archived_at === null && (sponsor.org_role === "owner" || sponsor.org_role === "admin")) {
			return sponsor.id;
		}
	}
	const owner = await db
		.prepare(
			"SELECT id FROM principals WHERE org_role = 'owner' AND deleted_at IS NULL AND archived_at IS NULL LIMIT 1",
		)
		.first<{ id: string }>();
	return owner?.id ?? null;
}

/** Puts a request into the activity list of the person who decides it. A second call changes nothing. */
async function notifyDecider(call: CallContext, request: MemberRequestRow, target: PrincipalRecord): Promise<void> {
	if (request.notified_id === null) return;
	const room = request.room_name === null ? "a room" : request.room_name;
	await call.env.PRINCIPAL.get(call.env.PRINCIPAL.idFromName(request.notified_id)).recordChatActivity([
		{
			id: memberRequestActivityId(request.id),
			kind: "member_request",
			room_id: request.room_id,
			room_name: request.room_name,
			// The item is not about a message. The field has the id of the request, for the two answers.
			message_id: request.id,
			parent_id: null,
			seq: 0,
			parent_seq: null,
			actor: actorOf(call),
			emoji: null,
			preview: `Asks to add ${target.display_name} to ${room}`,
			// The agent that asked chose the name of the room, and an agent chose the name of each account.
			untrusted: true,
			subject: toActor(target),
			created_at: Date.parse(request.created_at),
		},
	]);
}

/** Removes a request, and its item from the activity list of the person who got it. */
async function removeMemberRequest(call: CallContext, request: MemberRequestRow): Promise<boolean> {
	const removed = await deleteMemberRequest(call.env.DIRECTORY, request.id);
	if (request.notified_id !== null) {
		try {
			await call.env.PRINCIPAL.get(call.env.PRINCIPAL.idFromName(request.notified_id)).deleteChatActivities([
				memberRequestActivityId(request.id),
			]);
		} catch (error) {
			// The activity list drops the item at its next read: the request is gone.
			log("warn", "chat: the activity item of a member request stays until the next read of the list", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return removed;
}

/**
 * Removes the requests of a room for accounts that are members now. A person can add the account, or a new
 * request can come between the delete of an approval and the write of the room. Such a request has nothing
 * to decide, and it must not use a place of the room.
 */
async function settleMemberRequests(
	call: CallContext,
	roomId: string,
	principalIds: readonly string[],
	until: string,
): Promise<void> {
	for (const request of await memberRequestsOfRoom(call.env.DIRECTORY, roomId, principalIds, until)) {
		await removeMemberRequest(call, request);
	}
}

/**
 * The request that the caller can decide, with its account. The caller must manage the account: its sponsor,
 * an owner or an admin. Each other caller gets the answer for a request that does not exist.
 */
async function requestToDecide(
	call: CallContext,
	requestId: string,
): Promise<{ request: MemberRequestRow; target: PrincipalRecord }> {
	const request = await getMemberRequest(call.env.DIRECTORY, requestId);
	const target = request ? await getPrincipal(call.env.DIRECTORY, request.principal_id) : null;
	if (!request || !target || target.archived_at !== null || !canManageAgent(call.caller, target)) {
		throw new OperationError("not_found", NO_REQUEST);
	}
	return { request, target };
}

/**
 * The id of the direct message room of two principals: `dm_` and 26 characters from the SHA-256 of
 * the two ids in order. Two principals have one such id, so they have one such room, and two first
 * calls at the same time reach the same object.
 */
export async function dmRoomId(a: string, b: string): Promise<string> {
	const [low, high] = a < b ? [a, b] : [b, a];
	let value = BigInt(`0x${(await sha256Hex(`chat-dm:${low}:${high}`)).slice(0, 32)}`);
	let out = "";
	for (let i = 0; i < 26; i++) {
		out = CROCKFORD[Number(value & 31n)] + out;
		value >>= 5n;
	}
	return `dm_${out}`;
}

/**
 * The idempotency key of a call, for the object of a room. Each key belongs to its caller, so the key
 * of one principal can never return the message of a different principal. The hash binds the key to
 * the request, so a reused key with another request is a conflict.
 */
async function idempotencyOf(
	call: CallContext,
	operation: string,
	input: { idempotency_key?: string | undefined },
): Promise<{ key: string; requestHash: string } | undefined> {
	if (input.idempotency_key === undefined) return undefined;
	const { idempotency_key: key, ...request } = input;
	return {
		key: `${call.caller.id}:${key}`,
		requestHash: await sha256Hex(JSON.stringify([operation, request])),
	};
}

/** The input of chat.search_messages, after its checks. */
interface SearchInput {
	room_id?: string | undefined;
	sort?: "rank" | "time" | undefined;
	cursor?: string | undefined;
	limit?: number | undefined;
}

interface SearchOutput {
	results: ChatSearchResult[];
	next_cursor: string | null;
	sort: "rank" | "time";
}

/** A principal id that no principal has: the id of a handle that the caller must not learn about. */
const NO_PRINCIPAL = "prn_00000000000000000000000000";

/** True for the offset of a cursor of a read by rank: a whole number below the most results of that read. */
function isRankOffset(offset: number, most: number): boolean {
	return Number.isInteger(offset) && offset >= 0 && offset < most;
}

const BAD_SEARCH_CURSOR = "The cursor is not valid. Use next_cursor from the last page of the same search.";

/**
 * The principal id of each value of the filters `from:` and `mentions:`, and of an `in:` filter with an
 * "@": `me`, a principal id, or a handle or a name alias with the rules of a mention. One read of the
 * directory finds the handles of the query.
 *
 * A handle of no principal gets `invalid` only for a caller that can read the directory
 * (`directory.read`). For each other caller it is the id of no principal, which finds nothing. So a
 * credential with only the scopes of Chat does not learn which addresses the organization has.
 */
async function searchPrincipals(call: CallContext, values: readonly string[]): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	const keyOf = (value: string) => value.toLowerCase().replace(/^@/, "");
	const keys: string[] = [];
	for (const value of values) {
		if (keyOf(value) === "me") ids.set(value, call.caller.id);
		else if (PrincipalId.safeParse(value).success) ids.set(value, value);
		else keys.push(keyOf(value));
	}
	if (keys.length === 0) return ids;
	const directory = mentionDirectory(await mentionCandidates(call.env.DIRECTORY, keys, []));
	for (const value of values) {
		if (ids.has(value)) continue;
		const person = directory.byHandle.get(keyOf(value));
		if (!person && !call.caller.scopes.has("directory.read")) {
			ids.set(value, NO_PRINCIPAL);
			continue;
		}
		if (!person) {
			throw new OperationError(
				"invalid",
				`No person or agent has the handle @${keyOf(value)}. Use a handle as in a mention, me, or a principal id.`,
			);
		}
		ids.set(value, person.id);
	}
	return ids;
}

/** The filter of a query for a room and for the index: each principal of the query has its id. */
async function searchFilter(
	call: CallContext,
	parsed: ParsedSearch,
): Promise<{ filter: SearchFilter; ids: Map<string, string> }> {
	const ids = await searchPrincipals(call, [
		...parsed.from,
		...parsed.mentions,
		...parsed.in.filter((value) => value.startsWith("@")),
	]);
	const idOf = (value: string) => ids.get(value) as string;
	return {
		filter: {
			match: parsed.match,
			from: [...new Set(parsed.from.map(idOf))],
			mentions: [...new Set(parsed.mentions.map(idOf))],
			hasLink: parsed.hasLink,
			hasFile: parsed.hasFile,
			isThread: parsed.isThread,
			before: parsed.before,
			after: parsed.after,
		},
		ids,
	};
}

function searchResult(room: ChatSearchRoom, hit: SearchHitRecord): ChatSearchResult {
	return { room, message: messageOutput(hit.message), parent_seq: hit.parentSeq, highlights: hit.highlights };
}

/** Runs `task` for each item, `SEARCH_PARALLEL` at the same time. A task that fails gives `null`. */
async function inParts<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<(R | null)[]> {
	const out: (R | null)[] = [];
	for (let start = 0; start < items.length; start += SEARCH_PARALLEL) {
		const answers = await Promise.allSettled(items.slice(start, start + SEARCH_PARALLEL).map(task));
		for (const answer of answers) out.push(answer.status === "fulfilled" ? answer.value : null);
	}
	return out;
}

/**
 * chat.search_messages in one room. The room reads its own search tables in the same step as its member
 * check, so the result is always current.
 */
async function searchRoom(
	call: CallContext,
	input: SearchInput & { room_id: string },
	parsed: ParsedSearch,
): Promise<SearchOutput> {
	if (parsed.in.length > 0) {
		throw new OperationError(
			"invalid",
			"The search is in the room of room_id. Remove the in: filter, or remove room_id.",
		);
	}
	const ranked = (input.sort ?? "rank") === "rank" && parsed.match !== null;
	// A cursor is the offset of a read by rank, or the seq of the last message of a read by time.
	const cursor = input.cursor === undefined ? null : decodeCursor<[string, number]>(input.cursor, ["string", "number"]);
	const most = CHAT_LIMITS.searchRankResults;
	if (cursor !== null && (cursor[0] !== (ranked ? "r" : "s") || (ranked && !isRankOffset(cursor[1], most)))) {
		throw new OperationError("invalid", BAD_SEARCH_CURSOR);
	}
	if (input.cursor !== undefined && cursor === null) throw new OperationError("invalid", BAD_SEARCH_CURSOR);
	const offset = ranked ? (cursor?.[1] ?? 0) : 0;
	// A read by rank ends at `most` results, also when a cursor near the end comes with a larger page.
	const limit = Math.min(input.limit ?? SEARCH_PAGE, ranked ? most - offset : CHAT_LIMITS.searchPageSize);
	const { filter } = await searchFilter(call, parsed);
	const opened = openRoom(call, input.room_id);
	const page = accept(
		await opened.room.search(opened.ctx, filter, {
			sort: ranked ? "rank" : "time",
			before: ranked ? null : (cursor?.[1] ?? null),
			offset,
			limit,
		}),
	);
	const last = page.results[page.results.length - 1];
	let nextCursor: string | null = null;
	if (page.hasMore && ranked && offset + limit < CHAT_LIMITS.searchRankResults)
		nextCursor = encodeCursor(["r", offset + limit]);
	if (page.hasMore && !ranked && last) nextCursor = encodeCursor(["s", last.message.seq]);
	return {
		results: page.results.map((hit) => searchResult(page.room, hit)),
		next_cursor: nextCursor,
		sort: ranked ? "rank" : "time",
	};
}

/**
 * chat.search_messages in each room of the caller. The index of the organization finds the hits in the
 * rooms that the `PrincipalDO` of the caller has: a room and a seq for each, the newest first. The room of
 * each hit then returns the message as it is now, and makes the member check and the filter again. So a
 * member that left, a deleted message and a changed text never show, also when the index or the list of
 * the caller is behind.
 *
 * The index gives no rank: its word counts have the words of rooms that the caller cannot read. For
 * `sort: "rank"`, the index gives the newest `CHAT_LIMITS.searchRankCandidates` hits, each room gives the
 * rank of its own messages, and the handler puts them in order. So the order reads only rooms of the caller.
 */
async function searchRooms(call: CallContext, input: SearchInput, parsed: ParsedSearch): Promise<SearchOutput> {
	const limit = input.limit ?? SEARCH_PAGE;
	const ranked = (input.sort ?? "rank") === "rank" && parsed.match !== null;
	const sort = ranked ? "rank" : "time";
	let offset = 0;
	let after: { createdAt: number; roomId: string; seq: number } | null = null;
	if (input.cursor !== undefined) {
		const rank = decodeCursor<[string, number]>(input.cursor, ["string", "number"]);
		const time = decodeCursor<[string, number, string, number]>(input.cursor, ["string", "number", "string", "number"]);
		if (ranked && rank?.[0] === "r" && isRankOffset(rank[1], CHAT_LIMITS.searchRankCandidates)) offset = rank[1];
		else if (!ranked && time?.[0] === "t") after = { createdAt: time[1], roomId: time[2], seq: time[3] };
		else throw new OperationError("invalid", BAD_SEARCH_CURSOR);
	}
	const { filter, ids } = await searchFilter(call, parsed);
	const joined = await joinedRoomRefs(call.env, call.caller.id);
	const byId = new Map(joined.map((room) => [room.room_id, room]));
	let roomIds = [...byId.keys()];
	if (parsed.in.length > 0) {
		const named = new Set<string>();
		for (const value of parsed.in) {
			let found: string[];
			if (value.startsWith("@")) found = [await dmRoomId(call.caller.id, ids.get(value) as string)];
			else if (RoomId.safeParse(value).success) found = [value];
			else {
				const key = nameKey(value.replace(/^#/, ""));
				found = joined.filter((room) => room.name_key === key).map((room) => room.room_id);
			}
			found = found.filter((roomId) => byId.has(roomId));
			if (found.length === 0) {
				throw new OperationError(
					"invalid",
					`You are a member of no room for in:${value}. Use the name or the id of a room of yours, or @ and a handle for a direct message.`,
				);
			}
			for (const roomId of found) named.add(roomId);
		}
		roomIds = [...named];
	}

	const index = searchIndex(call.env);
	// A read by rank reads the newest hits again for each page, and puts all of them in order.
	const wanted = ranked ? CHAT_LIMITS.searchRankCandidates : limit;
	let hits: SearchHit[] = [];
	let more = false;
	const shown = new Map<string, SearchHitRecord>();
	const keyOf = (roomId: string, seq: number) => `${roomId}:${seq}`;
	for (let attempt = 0; attempt < SEARCH_ATTEMPTS && roomIds.length > 0; attempt++) {
		const query = { rooms: roomIds, filter, after, limit: wanted };
		let found = await index.search(query);
		if (attempt === 0 && found.unknown.length > 0) {
			// A room with no change since the version with search sent nothing to the index. Each such room
			// sends its messages now, and the search runs again.
			await inParts(found.unknown, async (roomId) => await roomStub(call.env, roomId).fillSearch());
			found = await index.search(query);
		}
		hits = found.hits.slice(0, wanted);
		more = found.hits.length > wanted;
		const seqsOf = new Map<string, number[]>();
		for (const hit of hits) seqsOf.set(hit.room_id, [...(seqsOf.get(hit.room_id) ?? []), hit.seq]);
		const rooms = [...seqsOf.keys()];
		const answers = await inParts(rooms, async (roomId) => {
			const opened = openRoom(call, roomId);
			return await opened.room.searchHits(opened.ctx, filter, seqsOf.get(roomId) ?? []);
		});
		shown.clear();
		const refused = new Set<string>();
		let failed = 0;
		answers.forEach((answer, position) => {
			const roomId = rooms[position] as string;
			if (answer === null) failed += 1;
			else if ("error" in answer) refused.add(roomId);
			else for (const hit of answer.results) shown.set(keyOf(roomId, hit.message.seq), hit);
		});
		if (failed > 0) log("warn", "chat search: rooms did not answer", { rooms: failed });
		if (refused.size === 0) break;
		// A room that refuses is a room that the caller left: the list of its `PrincipalDO` was behind. The
		// search runs again without that room. So no result, no count and no cursor comes from its hits.
		roomIds = roomIds.filter((roomId) => !refused.has(roomId));
		hits = [];
		more = false;
	}

	const roomOf = (roomId: string): ChatSearchRoom | null => {
		const room = byId.get(roomId);
		if (!room) return null;
		const peer = room.peer_json === null ? null : (JSON.parse(room.peer_json) as ActorRecord);
		const peers = room.peers_json ? (JSON.parse(room.peers_json) as ActorRecord[]) : undefined;
		return {
			id: room.room_id,
			kind: room.kind,
			name: room.name,
			peer,
			...(peers === undefined ? {} : { peers }),
		};
	};
	const found = hits.flatMap((hit) => {
		const record = shown.get(keyOf(hit.room_id, hit.seq));
		const room = roomOf(hit.room_id);
		return record && room ? [{ hit, record, room }] : [];
	});
	if (ranked) {
		// The best match first: the lowest score. Two messages with one score keep the order of the time.
		const ordered = found
			.map((entry, position) => ({ entry, position }))
			.sort((a, b) => a.entry.record.score - b.entry.record.score || a.position - b.position)
			.map(({ entry }) => entry);
		return {
			results: ordered.slice(offset, offset + limit).map(({ room, record }) => searchResult(room, record)),
			next_cursor: offset + limit < ordered.length ? encodeCursor(["r", offset + limit]) : null,
			sort,
		};
	}
	const last = hits[hits.length - 1];
	return {
		results: found.map(({ room, record }) => searchResult(room, record)),
		next_cursor: more && last ? encodeCursor(["t", last.created_at, last.room_id, last.seq]) : null,
		sort,
	};
}

export const chatHandlers: Pick<HandlerMap<CallContext>, ChatOperation> = {
	...chatWebhookHandlers,
	...chatNotificationHandlers,
	...chatPresenceHandlers,
	...chatLayer8Handlers,
	async "chat.list_rooms"(call, input) {
		const list = {
			query: input.query ?? null,
			cursor: input.cursor ?? null,
			limit: input.limit ?? DEFAULT_PAGE,
		};
		const page =
			input.view === "public"
				? await listPublicRooms(call.env.DIRECTORY, call.caller.id, list)
				: await listJoinedRooms(call.env, call.caller.id, list, input.view === "starred");
		if (page === null) {
			throw new OperationError(
				"invalid",
				"The cursor is not valid. Use next_cursor from the last page of the same list.",
			);
		}
		const shown = input.view === "public" ? await withOwnState(call.env, call.caller.id, page) : page;
		const rooms = input.view === "public" ? shown.rooms : await confirmedRooms(call, shown.rooms);
		return { rooms: rooms.map(toRoom), next_cursor: shown.nextCursor };
	},

	async "chat.list_threads"(call, input) {
		const page = await listFollowedThreads(call.env, call.caller.id, {
			unread: input.filter === "unread",
			cursor: input.cursor ?? null,
			limit: input.limit ?? DEFAULT_PAGE,
		});
		if (page === null) {
			throw new OperationError(
				"invalid",
				"The cursor is not valid. Use next_cursor from the last page of the same list.",
			);
		}
		return {
			threads: page.threads.map((thread) => ({
				room: toRoom(thread.room),
				message_id: thread.parentId,
				last_reply_at: iso(thread.lastReplyAt),
				unread_count: thread.unreadCount,
			})),
			next_cursor: page.nextCursor,
			unread_threads: page.unreadThreads,
		};
	},

	async "chat.list_addressed"(call, input) {
		const page = await listAddressedChanges(call.env, call.caller.id, {
			cursor: input.cursor ?? null,
			limit: input.limit ?? DEFAULT_PAGE,
		});
		if (page === null) {
			throw new OperationError(
				"invalid",
				"The cursor is not valid. Use next_cursor from the last page of the same list.",
			);
		}
		return {
			changes: page.changes.map(({ room, change }) => ({ ...change, room: toRoom(room), at: iso(change.at) })),
			next_cursor: page.nextCursor,
		};
	},

	async "chat.search_messages"(call, input) {
		const parsed = parseSearch(input.query);
		const roomId = input.room_id;
		return roomId === undefined
			? searchRooms(call, input, parsed)
			: searchRoom(call, { ...input, room_id: roomId }, parsed);
	},

	async "chat.create_room"(call, input) {
		const principals = await principalsOf(call, input.member_ids ?? []);
		const members = principals.map(toActor);
		const opened = openRoom(call, newId("rm"));
		const room = accept(
			await opened.room.create(opened.ctx, {
				kind: input.kind,
				name: input.name,
				topic: input.topic ?? "",
				members,
			}),
		);
		auditOk(call, "chat.create_room", room.id);
		recordServiceMemberships(
			call,
			members.map((member) => member.principal_id),
			"chat.create_room",
			room.id,
		);
		return { room: toRoom(room) };
	},

	async "chat.open_dm"(call, input) {
		if (input.principal_id === call.caller.id) {
			throw new OperationError("invalid", "A direct message needs a different person or agent than you.");
		}
		const principals = await principalsOf(call, [input.principal_id]);
		const roomId = await dmRoomId(call.caller.id, input.principal_id);
		const opened = openRoom(call, roomId);
		const result = accept(await opened.room.openDm(opened.ctx, toActor(principals[0] as PrincipalRecord)));
		if (result.created) {
			auditOk(call, "chat.open_dm", result.room.id);
			recordServiceMemberships(call, [input.principal_id], "chat.open_dm", result.room.id);
		}
		return { room: toRoom(result.room) };
	},

	async "chat.get_room"(call, input) {
		const opened = openRoom(call, input.room_id);
		const found = accept(await opened.room.get(opened.ctx));
		return {
			room: toRoom(found.room),
			members: found.members.map((member) => ({ ...member, joined_at: iso(member.joined_at) })),
			post_allowed_ids: found.post_allowed_ids,
			pin_count: found.pin_count,
		};
	},

	async "chat.update_room"(call, input) {
		const opened = openRoom(call, input.room_id);
		const room = accept(await opened.room.update(opened.ctx, { name: input.name, topic: input.topic }));
		auditOk(call, "chat.update_room", input.room_id);
		return { room: toRoom(room) };
	},

	async "chat.join_room"(call, input) {
		const opened = openRoom(call, input.room_id);
		const result = accept(await opened.room.join(opened.ctx));
		if (result.joined) auditOk(call, "chat.join_room", input.room_id);
		return { room: toRoom(result.room) };
	},

	async "chat.add_members"(call, input) {
		const opened = openRoom(call, input.room_id);
		// The room comes first. A caller without access gets the same answer for each principal id.
		accept(await opened.room.checkAddMembers(opened.ctx, input.scopes));
		const principals = await principalsOf(call, input.principal_ids);
		const result = accept(await opened.room.addMembers(opened.ctx, principals.map(toActor), input.scopes));
		// The room gives the time of its write. A request from before it has nothing to decide. A later request
		// can follow a remove, so it stays.
		const written = new Date(result.at).toISOString();
		if (result.added.length > 0) auditOk(call, "chat.add_members", `${input.room_id}:${result.added.join(",")}`);
		recordServiceMemberships(call, result.added, "chat.add_members", input.room_id);
		// A request for an account that is a member now has nothing to decide.
		await settleMemberRequests(
			call,
			input.room_id,
			result.members.map((member) => member.principal_id),
			written,
		);
		return { members_added: result.added.length, room: toRoom(result.room) };
	},

	async "chat.set_member_scopes"(call, input) {
		const opened = openRoom(call, input.room_id);
		// A principal that left the directory can still be a member. The room decides if the member exists.
		const result = accept(
			await opened.room.setMemberScopes(opened.ctx, {
				principalId: input.principal_id,
				scopes: input.scopes,
				allowAdmin: isAdmin(call.caller),
			}),
		);
		if (result.changed) {
			const scopes = result.member.scopes.join(",");
			auditOk(call, "chat.set_member_scopes", `${input.room_id}:${input.principal_id}:${scopes}`);
			recordServiceMemberships(call, [input.principal_id], "chat.set_member_scopes", input.room_id);
		}
		return { member: { ...result.member, joined_at: iso(result.member.joined_at) } };
	},

	async "chat.request_member"(call, input) {
		const opened = openRoom(call, input.room_id);
		const scopes = input.scopes ?? defaultRoomMemberScopes("agent");
		// The room comes first. A caller without access gets the same answer for each principal id.
		accept(await opened.room.checkAddMembers(opened.ctx, scopes));
		const [target] = await principalsOf(call, [input.principal_id]);
		if (target?.kind !== "agent") {
			throw new OperationError(
				"invalid",
				"A request is for an agent or a service account. Add a person with chat.add_members.",
			);
		}
		if (target.archived_at !== null) throw new OperationError("invalid", "That account is archived.");
		const checked = accept(await opened.room.checkMemberRequest(opened.ctx, target.id, scopes));
		const decider = await deciderOf(call, target);
		const stored = await createMemberRequest(
			call.env.DIRECTORY,
			{
				roomId: input.room_id,
				roomName: checked.room_name,
				principalId: target.id,
				requestedBy: call.caller.id,
				scopes,
				notifiedId: decider,
			},
			CHAT_LIMITS.memberRequestsPerRoom,
		);
		if (!stored) {
			throw new OperationError(
				"conflict",
				`This room has ${CHAT_LIMITS.memberRequestsPerRoom} requests that wait for an answer, the most. Try again after a person decides one.`,
			);
		}
		// The line comes first: the request is in the directory, so the log must have it when a later step fails.
		if (stored.created) auditOk(call, "chat.request_member", `${input.room_id}:${target.id}`);
		// A request from an earlier call can name a person who no longer decides, for example after a change of
		// the sponsor. The item then goes to the person of now. The old item leaves the list of the other person.
		let request = stored.request;
		if (request.notified_id !== decider) {
			await setMemberRequestNotified(call.env.DIRECTORY, request.id, decider);
			request = { ...request, notified_id: decider };
		}
		// Each call sends the item again. The write has the id of the request, so a second one changes nothing,
		// and it completes a write that failed.
		await notifyDecider(call, request, target);
		return { request: toMemberRequest(request), created: stored.created };
	},

	async "chat.list_member_requests"(call, input) {
		const db = call.env.DIRECTORY;
		if (call.caller.kind !== "human") {
			// An agent or a service account sees the requests that it made.
			const made = await listMemberRequestsBy(db, call.caller.id, input.principal_id ?? null);
			return { requests: made.map(toMemberRequest) };
		}
		const requests = await listMemberRequestsFor(db, {
			personId: call.caller.id,
			admin: isAdmin(call.caller),
			principalId: input.principal_id ?? null,
		});
		return { requests: requests.map(toMemberRequest) };
	},

	async "chat.approve_member_request"(call, input) {
		const { request, target } = await requestToDecide(call, input.request_id);
		// The delete of the request is the decision. Only one answer deletes it, so a denial and an approval at
		// the same time cannot both succeed. The room writes the member only after the approval won.
		if (!(await removeMemberRequest(call, request))) throw new OperationError("not_found", NO_REQUEST);
		const room = roomStub(call.env, request.room_id);
		const admitted = await room.admitMember(request.requested_by, toActor(target), request.scopes, call.caller.id);
		if ("error" in admitted) {
			// The room is gone, or the agent that asked cannot add this member now. The request cannot complete.
			throw new OperationError("conflict", `${admitted.error.message} The request is gone.`);
		}
		// A new request can come between the delete above and the write of the room. The account is a member now,
		// so such a request has nothing to decide. The room gives the time of its write: a later request can
		// follow a remove, so it stays.
		await settleMemberRequests(call, request.room_id, [target.id], new Date(admitted.at).toISOString());
		// The account was a member before the approval: a person added it in the meantime. The room keeps that
		// membership as it is.
		if (!admitted.added) return { request: toMemberRequest(request) };
		auditOk(call, "chat.approve_member_request", `${request.room_id}:${target.id}`);
		recordServiceMemberships(call, [target.id], "chat.approve_member_request", request.room_id);
		return { request: toMemberRequest(request) };
	},

	async "chat.deny_member_request"(call, input) {
		const { request, target } = await requestToDecide(call, input.request_id);
		// Only one answer deletes the request. A different answer that came first gives `not_found`.
		if (!(await removeMemberRequest(call, request))) throw new OperationError("not_found", NO_REQUEST);
		auditOk(call, "chat.deny_member_request", `${request.room_id}:${target.id}`);
		return { denied: true };
	},

	async "chat.remove_member"(call, input) {
		const opened = openRoom(call, input.room_id);
		const result = accept(await opened.room.removeMember(opened.ctx, input.principal_id));
		if (result.removed) {
			auditOk(call, "chat.remove_member", `${input.room_id}:${input.principal_id}`);
			recordServiceMemberships(call, [input.principal_id], "chat.remove_member", input.room_id);
		}
		return { removed: result.removed };
	},

	async "chat.list_messages"(call, input) {
		const opened = openRoom(call, input.room_id);
		const page = accept(
			await opened.room.listMessages(opened.ctx, {
				before: input.before ?? null,
				after: input.after ?? null,
				changedAfter: input.changed_after ?? null,
				limit: input.limit ?? DEFAULT_PAGE,
			}),
		);
		return { messages: page.messages.map(messageOutput), version: page.version, has_more: page.hasMore };
	},

	async "chat.post_message"(call, input) {
		const opened = openRoom(call, input.room_id);
		const idempotency = await idempotencyOf(call, "chat.post_message", input);
		// A retry gets the message of its first call, also when a file of that call is not in the drive now.
		if (idempotency && input.file_ids !== undefined) {
			const earlier = await opened.room.postedMessage(opened.ctx, idempotency);
			if (earlier !== null) return { message: messageOutput(accept(earlier).message) };
		}
		// The files come before the post: a call without access to them posts nothing.
		const files = await filesForMessage(call, input.file_ids ?? []);
		const posted = accept(
			await opened.room.postMessage(opened.ctx, {
				id: newId("cmsg"),
				content: contentOf(input) ?? { body: textBody(""), text: "" },
				files,
				linkOrigin: call.origin,
				idempotency,
				clientKey: input.idempotency_key ?? null,
				parentId: input.parent_id ?? null,
				alsoInRoom: input.also_in_room ?? false,
				...(input.cards === undefined ? {} : { cards: input.cards }),
			}),
		);
		if (!posted.duplicate) auditOk(call, "chat.post_message", `${input.room_id}:${posted.message.id}`);
		return { message: messageOutput(posted.message) };
	},

	async "chat.list_replies"(call, input) {
		const opened = openRoom(call, input.room_id);
		const page = accept(
			await opened.room.listReplies(opened.ctx, input.message_id, {
				// The newest replies are the replies before a seq that no reply has.
				before: input.newest === "true" ? Number.MAX_SAFE_INTEGER : (input.before ?? null),
				after: input.after ?? null,
				changedAfter: input.changed_after ?? null,
				limit: input.limit ?? DEFAULT_PAGE,
			}),
		);
		return {
			parent: messageOutput(page.parent),
			replies: page.replies.map(messageOutput),
			version: page.version,
			has_more: page.hasMore,
			follow: followOutput(page.follow),
		};
	},

	// A follow and a read marker of a thread change the view of the caller, not the data of the room. So they
	// write no audit line, as for the read marker of the room.
	async "chat.follow_thread"(call, input) {
		const opened = openRoom(call, input.room_id);
		return {
			follow: followOutput(accept(await opened.room.followThread(opened.ctx, input.message_id, input.following))),
		};
	},

	async "chat.mark_thread_read"(call, input) {
		const opened = openRoom(call, input.room_id);
		return {
			follow: followOutput(accept(await opened.room.markThreadRead(opened.ctx, input.message_id, input.seq ?? null))),
		};
	},

	async "chat.edit_message"(call, input) {
		const opened = openRoom(call, input.room_id);
		let files: { order: string[]; added: Awaited<ReturnType<typeof filesForMessage>> } | null = null;
		if (input.file_ids !== undefined) {
			// Only a file that the edit adds needs the checks in Drive. A file that the message holds stays.
			const held = new Set(accept(await opened.room.messageFileIds(opened.ctx, input.message_id)).itemIds);
			const added = await filesForMessage(
				call,
				input.file_ids.filter((itemId) => !held.has(itemId)),
			);
			files = { order: input.file_ids, added };
		}
		const edited = accept(
			await opened.room.editMessage(
				opened.ctx,
				input.message_id,
				contentOf(input),
				files,
				call.origin,
				input.cards ?? null,
			),
		);
		if (edited.changed) auditOk(call, "chat.edit_message", `${input.room_id}:${input.message_id}`);
		return { message: messageOutput(edited.message) };
	},

	async "chat.delete_message"(call, input) {
		const opened = openRoom(call, input.room_id);
		const result = accept(await opened.room.deleteMessage(opened.ctx, input.message_id));
		if (result.deleted) auditOk(call, "chat.delete_message", `${input.room_id}:${input.message_id}`);
		return result;
	},

	"chat.download_file": downloadChatFile,
	"chat.download_link_image": downloadLinkImage,

	async "chat.remove_link_preview"(call, input) {
		const opened = openRoom(call, input.room_id);
		const result = accept(await opened.room.removeLinkPreview(opened.ctx, input.message_id, input.url ?? null));
		auditOk(call, "chat.remove_link_preview", `${input.room_id}:${input.message_id}`);
		return { message: messageOutput(result.message) };
	},

	async "chat.list_message_edits"(call, input) {
		// The check comes first, so a caller without the role learns nothing about the room. The invoker
		// audits the refusal (`auditDenied`), as it audits a refused kind of caller or a missing scope.
		if (!isAdmin(call.caller)) {
			throw new OperationError(
				"forbidden",
				"Only owners and admins of the organization can read the earlier versions of a message.",
			);
		}
		const opened = openRoom(call, input.room_id);
		const target = `${input.room_id}:${input.message_id}`;
		const result = await opened.room.listEdits(opened.ctx, input.message_id);
		// A read of the earlier content of a different person is an access to keep in the audit log. A room
		// that refuses the read (a private room of a non-member) gets a line too. The answer stays not_found.
		if ("error" in result) {
			audit({
				op: "chat.list_message_edits",
				actor: call.caller.id,
				actorKind: call.caller.kind,
				credential: call.caller.credential,
				target,
				result: "denied",
				code: result.error.code,
				requestId: call.requestId,
			});
		}
		const { edits } = accept(result);
		auditOk(call, "chat.list_message_edits", target);
		return {
			edits: edits.map((edit) => ({
				...edit,
				markdown: bodyMarkdown(edit.body),
				written_at: iso(edit.written_at),
				replaced_at: iso(edit.replaced_at),
			})),
		};
	},

	async "chat.add_reaction"(call, input) {
		const opened = openRoom(call, input.room_id);
		accept(await opened.room.checkMember(opened.ctx));
		if (isCustomEmoji(input.emoji)) {
			const name = input.emoji.slice(1, -1);
			if (!(await hasCustomEmoji(call.env.DIRECTORY, name))) {
				throw new OperationError("invalid", `No custom emoji ${input.emoji} exists.`);
			}
		}
		const result = accept(await opened.room.react(opened.ctx, input.message_id, input.emoji, true));
		if (result.changed) auditOk(call, "chat.add_reaction", `${input.room_id}:${input.message_id}`);
		return { message: messageOutput(result.message) };
	},

	async "chat.remove_reaction"(call, input) {
		const opened = openRoom(call, input.room_id);
		const result = accept(await opened.room.react(opened.ctx, input.message_id, input.emoji, false));
		if (result.changed) auditOk(call, "chat.remove_reaction", `${input.room_id}:${input.message_id}`);
		return { message: messageOutput(result.message) };
	},

	async "chat.mark_read"(call, input) {
		const opened = openRoom(call, input.room_id);
		const result = accept(await opened.room.markRead(opened.ctx, input.seq ?? null));
		return { last_read_seq: result.lastReadSeq, unread: result.unread };
	},

	// A star changes the view of the caller, not the data of the room. So it writes no audit line, as
	// for the read marker.
	async "chat.star_room"(call, input) {
		const opened = openRoom(call, input.room_id);
		const room = accept(await opened.room.star(opened.ctx, input.starred));
		return { room: toRoom(room) };
	},
};

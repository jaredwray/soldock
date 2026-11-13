import type { ChatMessage, ChatRoom, OperationName } from "@soldock/contracts";
import { type CallContext, getPrincipals } from "../identity/index.ts";
import { audit, type HandlerMap, newId, OperationError, sha256Hex } from "../platform/index.ts";
import type { ActorRecord, MessageRecord, Refusal, RoomCall, RoomRecord } from "./room.ts";
import { listJoinedRooms, listPublicRooms } from "./room-index.ts";

type ChatOperation = Extract<OperationName, `chat.${string}`>;

const DEFAULT_PAGE = 50;
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

/** Turns a refusal from an object into an OperationError, and returns any other result. */
function accept<T extends object>(value: T): Exclude<T, { error: unknown }> {
	if ("error" in value) {
		const { error } = value as unknown as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, { error: unknown }>;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function toRoom(record: RoomRecord): ChatRoom {
	return {
		...record,
		created_at: iso(record.created_at),
		last_message_at: record.last_message_at === null ? null : iso(record.last_message_at),
	};
}

function toMessage(record: MessageRecord): ChatMessage {
	return {
		...record,
		created_at: iso(record.created_at),
		edited_at: record.edited_at === null ? null : iso(record.edited_at),
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
async function actorsOf(call: CallContext, ids: readonly string[]): Promise<ActorRecord[]> {
	const principals = await getPrincipals(call.env.DIRECTORY, ids);
	const known = new Set(principals.map((principal) => principal.id));
	const unknown = ids.find((id) => !known.has(id));
	if (unknown !== undefined) throw new OperationError("not_found", `No person or agent has the id ${unknown}.`);
	return principals.map((principal) => ({
		principal_id: principal.id,
		kind: principal.kind,
		display_name: principal.display_name,
	}));
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

export const chatHandlers: Pick<HandlerMap<CallContext>, ChatOperation> = {
	async "chat.list_rooms"(call, input) {
		const list = input.view === "public" ? listPublicRooms : listJoinedRooms;
		const page = await list(call.env.DIRECTORY, call.caller.id, {
			query: input.query ?? null,
			cursor: input.cursor ?? null,
			limit: input.limit ?? DEFAULT_PAGE,
		});
		if (page === null) {
			throw new OperationError(
				"invalid",
				"The cursor is not valid. Use next_cursor from the last page of the same list.",
			);
		}
		return { rooms: page.rooms.map(toRoom), next_cursor: page.nextCursor };
	},

	async "chat.create_room"(call, input) {
		const members = await actorsOf(call, input.member_ids ?? []);
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
		return { room: toRoom(room) };
	},

	async "chat.open_dm"(call, input) {
		if (input.principal_id === call.caller.id) {
			throw new OperationError("invalid", "A direct message needs a different person or agent than you.");
		}
		const [peer] = await actorsOf(call, [input.principal_id]);
		const opened = openRoom(call, await dmRoomId(call.caller.id, input.principal_id));
		const result = accept(await opened.room.openDm(opened.ctx, peer as ActorRecord));
		if (result.created) auditOk(call, "chat.open_dm", result.room.id);
		return { room: toRoom(result.room) };
	},

	async "chat.get_room"(call, input) {
		const opened = openRoom(call, input.room_id);
		const found = accept(await opened.room.get(opened.ctx));
		return {
			room: toRoom(found.room),
			members: found.members.map((member) => ({ ...member, joined_at: iso(member.joined_at) })),
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
		accept(await opened.room.checkAddMembers(opened.ctx));
		const members = await actorsOf(call, input.principal_ids);
		const result = accept(await opened.room.addMembers(opened.ctx, members));
		if (result.added.length > 0) auditOk(call, "chat.add_members", `${input.room_id}:${result.added.join(",")}`);
		return { members_added: result.added.length, room: toRoom(result.room) };
	},

	async "chat.remove_member"(call, input) {
		const opened = openRoom(call, input.room_id);
		const result = accept(await opened.room.removeMember(opened.ctx, input.principal_id));
		if (result.removed) auditOk(call, "chat.remove_member", `${input.room_id}:${input.principal_id}`);
		return result;
	},

	async "chat.list_messages"(call, input) {
		const opened = openRoom(call, input.room_id);
		const page = accept(
			await opened.room.listMessages(opened.ctx, {
				before: input.before ?? null,
				changedAfter: input.changed_after ?? null,
				limit: input.limit ?? DEFAULT_PAGE,
			}),
		);
		return { messages: page.messages.map(toMessage), version: page.version, has_more: page.hasMore };
	},

	async "chat.post_message"(call, input) {
		const opened = openRoom(call, input.room_id);
		const posted = accept(
			await opened.room.postMessage(opened.ctx, {
				id: newId("cmsg"),
				text: input.text,
				idempotency: await idempotencyOf(call, "chat.post_message", input),
			}),
		);
		if (!posted.duplicate) auditOk(call, "chat.post_message", `${input.room_id}:${posted.message.id}`);
		return { message: toMessage(posted.message) };
	},

	async "chat.edit_message"(call, input) {
		const opened = openRoom(call, input.room_id);
		const edited = accept(await opened.room.editMessage(opened.ctx, input.message_id, input.text));
		if (edited.changed) auditOk(call, "chat.edit_message", `${input.room_id}:${input.message_id}`);
		return { message: toMessage(edited.message) };
	},

	async "chat.delete_message"(call, input) {
		const opened = openRoom(call, input.room_id);
		const result = accept(await opened.room.deleteMessage(opened.ctx, input.message_id));
		if (result.deleted) auditOk(call, "chat.delete_message", `${input.room_id}:${input.message_id}`);
		return result;
	},

	async "chat.mark_read"(call, input) {
		const opened = openRoom(call, input.room_id);
		const result = accept(await opened.room.markRead(opened.ctx, input.seq ?? null));
		return { last_read_seq: result.lastReadSeq, unread: result.unread };
	},
};

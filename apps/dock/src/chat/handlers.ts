import type { ChatRoom, ChatThreadFollow, OperationName } from "@asterra/contracts";
import { filesForMessage } from "../drive/index.ts";
import { type CallContext, getPrincipals, isAdmin } from "../identity/index.ts";
import { audit, type HandlerMap, newId, OperationError, sha256Hex } from "../platform/index.ts";
import { bodyMarkdown, type MessageContent, messageContent, textBody } from "./body.ts";
import { downloadChatFile, downloadLinkImage } from "./files.ts";
import { listFollowedThreads, listJoinedRooms, withOwnState } from "./principal-rooms.ts";
import {
	type ActorRecord,
	messageOutput,
	type Refusal,
	type RoomCall,
	type RoomRecord,
	type ThreadFollowRecord,
} from "./room.ts";
import { listPublicRooms } from "./room-index.ts";

import { chatWebhookHandlers } from "./webhooks.ts";

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
	...chatWebhookHandlers,
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
		return { rooms: shown.rooms.map(toRoom), next_cursor: shown.nextCursor };
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
			}),
		);
		if (!posted.duplicate) auditOk(call, "chat.post_message", `${input.room_id}:${posted.message.id}`);
		return { message: messageOutput(posted.message) };
	},

	async "chat.list_replies"(call, input) {
		const opened = openRoom(call, input.room_id);
		const page = accept(
			await opened.room.listReplies(opened.ctx, input.message_id, {
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
			await opened.room.editMessage(opened.ctx, input.message_id, contentOf(input), files, call.origin),
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

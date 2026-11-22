import {
	ALL_SCOPES,
	CHAT_LIMITS,
	type ChatActivityItem,
	type ChatDraft,
	type ChatPin,
	type ChatReminder,
	type ChatRoom,
	type ChatSavedMessage,
	type ChatScheduledMessage,
	type ChatSection,
	type OperationName,
} from "@asterra/contracts";
import {
	type ActivityRecord,
	type CallContext,
	credentialBinding,
	type DraftRecord,
	getPrincipals,
	isAdmin,
	type ReminderRecord,
	recordServiceMemberships,
	type ScheduledRecord,
	type SectionRecord,
} from "../identity/index.ts";
import {
	audit,
	decodeCursor,
	encodeCursor,
	type HandlerMap,
	newId,
	OperationError,
	sha256Hex,
} from "../platform/index.ts";
import { bodyMarkdown, type MessageContent, messageContent, textBody } from "./body.ts";
import { createCustomEmoji, deleteCustomEmoji, listCustomEmoji } from "./custom-emoji.ts";
import { dmRoomId } from "./handlers.ts";
import {
	createIncomingWebhook,
	deleteIncomingWebhook,
	getIncomingWebhookRoom,
	listIncomingWebhooks,
} from "./incoming-webhooks.ts";
import {
	type ActorRecord,
	messageOutput,
	type PinRecord,
	type Refusal,
	type RoomCall,
	type RoomRecord,
} from "./room.ts";
import { adminListRooms, removeDeletedPrincipalFromRooms, serviceMemberIds } from "./room-index.ts";
import { createSlashCommand, deleteSlashCommand, listSlashCommands } from "./slash-commands.ts";

export type Layer8ChatOperation = Extract<
	OperationName,
	| "chat.list_activity"
	| "chat.mark_activity_read"
	| "chat.list_sections"
	| "chat.create_section"
	| "chat.update_section"
	| "chat.delete_section"
	| "chat.set_room_section"
	| "chat.pin_message"
	| "chat.unpin_message"
	| "chat.list_pins"
	| "chat.save_message"
	| "chat.unsave_message"
	| "chat.list_saved_messages"
	| "chat.schedule_message"
	| "chat.list_scheduled_messages"
	| "chat.update_scheduled_message"
	| "chat.cancel_scheduled_message"
	| "chat.create_reminder"
	| "chat.list_reminders"
	| "chat.complete_reminder"
	| "chat.delete_reminder"
	| "chat.list_drafts"
	| "chat.save_draft"
	| "chat.delete_draft"
	| "chat.list_custom_emoji"
	| "chat.create_custom_emoji"
	| "chat.delete_custom_emoji"
	| "chat.forward_message"
	| "chat.open_group_dm"
	| "chat.archive_room"
	| "chat.unarchive_room"
	| "chat.delete_room"
	| "chat.set_posting_rules"
	| "chat.set_room_retention"
	| "chat.admin_list_rooms"
	| "chat.admin_assign_owner"
	| "chat.admin_remove_deleted_principal"
	| "chat.export_room"
	| "chat.create_incoming_webhook"
	| "chat.list_incoming_webhooks"
	| "chat.delete_incoming_webhook"
	| "chat.list_slash_commands"
	| "chat.create_slash_command"
	| "chat.delete_slash_command"
	| "chat.invoke_slash_command"
	| "chat.trigger_card_action"
	| "chat.list_card_actions"
>;

const DEFAULT_PAGE = 50;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function roomStub(env: Pick<Env, "CHAT_ROOM">, roomId: string) {
	return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(roomId));
}

function principalStub(env: Pick<Env, "PRINCIPAL">, principalId: string) {
	return env.PRINCIPAL.get(env.PRINCIPAL.idFromName(principalId));
}

function actorOf(call: CallContext): ActorRecord {
	const { principal } = call.caller;
	return { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name };
}

function openRoom(call: CallContext, roomId: string): { room: ReturnType<typeof roomStub>; ctx: RoomCall } {
	return { room: roomStub(call.env, roomId), ctx: { roomId, actor: actorOf(call) } };
}

function accept<T extends object>(value: T): Exclude<T, { error: unknown }> {
	if ("error" in value) {
		const { error } = value as unknown as Refusal;
		throw new OperationError(error.code, error.message);
	}
	return value as Exclude<T, { error: unknown }>;
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

function toPin(record: PinRecord): ChatPin {
	return {
		message: messageOutput(record.message),
		pinned_by: record.pinned_by,
		pinned_at: iso(record.pinned_at),
	};
}

function toActivity(record: ActivityRecord): ChatActivityItem {
	return {
		id: record.id,
		kind: record.kind,
		room_id: record.room_id,
		room_name: record.room_name,
		message_id: record.message_id,
		seq: record.seq,
		parent_id: record.parent_id,
		parent_seq: record.parent_seq,
		actor: record.actor,
		preview: record.preview,
		emoji: record.emoji,
		untrusted: record.untrusted,
		read_at: record.read_at === null ? null : iso(record.read_at),
		created_at: iso(record.created_at),
	};
}

function toSection(record: SectionRecord): ChatSection {
	return {
		id: record.id,
		name: record.name,
		position: record.position,
		room_ids: record.room_ids,
		created_at: iso(record.created_at),
	};
}

function toDraft(record: DraftRecord): ChatDraft {
	return {
		room_id: record.room_id,
		parent_id: record.parent_id,
		text: record.text,
		markdown: record.markdown,
		body: JSON.parse(record.body_json),
		updated_at: iso(record.updated_at),
	};
}

function toScheduled(record: ScheduledRecord): ChatScheduledMessage {
	return {
		id: record.id,
		room_id: record.room_id,
		parent_id: record.parent_id,
		also_in_room: record.also_in_room,
		text: record.text,
		body: JSON.parse(record.body_json),
		markdown: record.markdown,
		send_at: iso(record.send_at),
		status: record.status,
		sent_message_id: record.sent_message_id,
		error: record.error,
		created_at: iso(record.created_at),
	};
}

function toReminder(record: ReminderRecord): ChatReminder {
	return {
		id: record.id,
		room_id: record.room_id,
		message_id: record.message_id,
		seq: record.seq,
		parent_id: record.parent_id,
		parent_seq: record.parent_seq,
		note: record.note,
		preview: record.preview,
		untrusted: record.untrusted,
		remind_at: iso(record.remind_at),
		triggered_at: record.triggered_at === null ? null : iso(record.triggered_at),
		completed_at: record.completed_at === null ? null : iso(record.completed_at),
		created_at: iso(record.created_at),
	};
}

function contentOf(input: {
	text?: string | undefined;
	markdown?: string | undefined;
	body?: unknown;
}): MessageContent | null {
	if (input.text === undefined && input.markdown === undefined && input.body === undefined) return null;
	return messageContent(input as Parameters<typeof messageContent>[0]);
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

/** Deterministic ID for a group DM from sorted unique member IDs. */
export async function groupDmRoomId(memberIds: readonly string[]): Promise<string> {
	const sorted = [...new Set(memberIds)].sort();
	let value = BigInt(`0x${(await sha256Hex(`chat-gdm:${sorted.join(":")}`)).slice(0, 32)}`);
	let out = "";
	for (let i = 0; i < 26; i++) {
		out = CROCKFORD[Number(value & 31n)] + out;
		value >>= 5n;
	}
	return `dm_${out}`;
}

function parseFutureIso(raw: string, field: string, maxDays?: number): number {
	const ms = Date.parse(raw);
	if (!Number.isFinite(ms)) throw new OperationError("invalid", `${field} must be a valid ISO-8601 timestamp.`);
	const now = Date.now();
	if (ms <= now) throw new OperationError("invalid", `${field} must be in the future.`);
	if (maxDays !== undefined && ms > now + maxDays * 86_400_000) {
		throw new OperationError("invalid", `${field} cannot be more than ${maxDays} days ahead.`);
	}
	return ms;
}

async function assertWebhookRoomAccess(call: CallContext, roomId: string): Promise<void> {
	const opened = openRoom(call, roomId);
	const found = accept(await opened.room.get(opened.ctx));
	if (found.room.kind === "dm" || found.room.kind === "group_dm") {
		throw new OperationError("invalid", "Direct messages cannot have incoming webhooks.");
	}
	const isRoomOwner = found.room.role === "owner";
	const isOrgAdminWithAccess = isAdmin(call.caller) && (found.room.kind === "public" || found.room.role !== null);
	if (!isRoomOwner && !isOrgAdminWithAccess) {
		throw new OperationError("forbidden", "Only the room owner or an organization admin can manage incoming webhooks.");
	}
}

export const chatLayer8Handlers: Pick<HandlerMap<CallContext>, Layer8ChatOperation> = {
	// --- Activity -------------------------------------------------------------------------------
	async "chat.list_activity"(call, input) {
		const limit = input.limit ?? DEFAULT_PAGE;
		const cursor =
			input.cursor === undefined ? null : decodeCursor<[number, string]>(input.cursor, ["number", "string"]);
		if (input.cursor !== undefined && cursor === null) {
			throw new OperationError("invalid", "The cursor is not valid.");
		}
		const principal = principalStub(call.env, call.caller.id);
		await principal.processDuePersonalWork();
		const listed = await principal.listChatActivity({
			filter: input.filter ?? "all",
			after: cursor === null ? null : { createdAt: cursor[0], id: cursor[1] },
			limit,
		});
		const shown = listed.items.slice(0, limit);
		const last = shown[shown.length - 1];

		// Verify current room membership and message liveness against each authoritative ChatRoomDO
		// so previews from left rooms or deleted/retention-pruned messages are never exposed.
		const byRoom = new Map<string, string[]>();
		for (const item of shown) {
			const list = byRoom.get(item.room_id);
			if (list) list.push(item.message_id);
			else byRoom.set(item.room_id, [item.message_id]);
		}
		const liveByRoom = new Map<string, Set<string>>();
		await Promise.all(
			[...byRoom.entries()].map(async ([roomId, msgIds]) => {
				const opened = openRoom(call, roomId);
				const res = await opened.room.getMessagesByIds(opened.ctx, [...new Set(msgIds)]);
				if (!("error" in res)) {
					liveByRoom.set(roomId, new Set(res.messages.map((m) => m.id)));
				}
			}),
		);
		const liveItems: ActivityRecord[] = [];
		const staleIds: string[] = [];
		for (const item of shown) {
			const live = liveByRoom.get(item.room_id);
			if (live?.has(item.message_id)) {
				liveItems.push(item);
			} else {
				staleIds.push(item.id);
			}
		}
		let unreadCount = listed.unreadCount;
		if (staleIds.length > 0) {
			unreadCount = await principal.deleteChatActivities(staleIds);
		}
		return {
			items: liveItems.map(toActivity),
			unread_count: unreadCount,
			next_cursor: listed.items.length > limit && last ? encodeCursor([last.created_at, last.id]) : null,
		};
	},

	async "chat.mark_activity_read"(call, input) {
		const unread = await principalStub(call.env, call.caller.id).markChatActivityRead(input.activity_id);
		return { unread_count: unread };
	},

	// --- Sidebar sections -----------------------------------------------------------------------
	async "chat.list_sections"(call) {
		const sections = await principalStub(call.env, call.caller.id).listChatSections();
		return { sections: sections.map(toSection) };
	},

	async "chat.create_section"(call, input) {
		const created = await principalStub(call.env, call.caller.id).createChatSection(newId("csec"), input.name);
		if (created === "full") {
			throw new OperationError("conflict", `You can create ${CHAT_LIMITS.sectionsPerPrincipal} sections at most.`);
		}
		return { section: toSection(created) };
	},

	async "chat.update_section"(call, input) {
		const updated = await principalStub(call.env, call.caller.id).updateChatSection(input.section_id, {
			name: input.name,
			position: input.position,
		});
		if (!updated) throw new OperationError("not_found", "No section has that id.");
		return { section: toSection(updated) };
	},

	async "chat.delete_section"(call, input) {
		const deleted = await principalStub(call.env, call.caller.id).deleteChatSection(input.section_id);
		return { deleted };
	},

	async "chat.set_room_section"(call, input) {
		const opened = openRoom(call, input.room_id);
		const found = accept(await opened.room.get(opened.ctx));
		if (found.room.role === null) {
			throw new OperationError("forbidden", "You must be a member of the room to assign it to a section.");
		}
		const result = await principalStub(call.env, call.caller.id).setChatRoomSection(input.room_id, input.section_id);
		if (result === "no_section") throw new OperationError("not_found", "No section has that id.");
		return { room_id: input.room_id, section_id: input.section_id };
	},

	// --- Pins -----------------------------------------------------------------------------------
	async "chat.pin_message"(call, input) {
		const opened = openRoom(call, input.room_id);
		const res = accept(await opened.room.pinMessage(opened.ctx, input.message_id));
		if (res.pinned) auditOk(call, "chat.pin_message", `${input.room_id}:${input.message_id}`);
		const pin = toPin(res.pin);
		return { pin, message: pin.message };
	},

	async "chat.unpin_message"(call, input) {
		const opened = openRoom(call, input.room_id);
		const res = accept(await opened.room.unpinMessage(opened.ctx, input.message_id));
		if (res.unpinned) auditOk(call, "chat.unpin_message", `${input.room_id}:${input.message_id}`);
		return { unpinned: res.unpinned, message: messageOutput(res.message) };
	},

	async "chat.list_pins"(call, input) {
		const opened = openRoom(call, input.room_id);
		const res = accept(await opened.room.listPins(opened.ctx));
		return { pins: res.pins.map(toPin) };
	},

	// --- Saved messages -------------------------------------------------------------------------
	async "chat.save_message"(call, input) {
		const opened = openRoom(call, input.room_id);
		accept(await opened.room.verifyMessageForPersonal(opened.ctx, input.message_id));
		const saved = await principalStub(call.env, call.caller.id).saveChatMessage(input.room_id, input.message_id);
		if (saved === "full") {
			throw new OperationError("conflict", `You can save ${CHAT_LIMITS.savedMessages} messages at most.`);
		}
		return { saved: true, saved_at: iso(saved.savedAt) };
	},

	async "chat.unsave_message"(call, input) {
		const removed = await principalStub(call.env, call.caller.id).unsaveChatMessage(input.room_id, input.message_id);
		return { removed };
	},

	async "chat.list_saved_messages"(call, input) {
		const limit = input.limit ?? DEFAULT_PAGE;
		const cursor =
			input.cursor === undefined
				? null
				: decodeCursor<[number, string, string]>(input.cursor, ["number", "string", "string"]);
		if (input.cursor !== undefined && cursor === null) {
			throw new OperationError("invalid", "The cursor is not valid.");
		}
		const refs = await principalStub(call.env, call.caller.id).listSavedChatMessages({
			after: cursor === null ? null : { savedAt: cursor[0], roomId: cursor[1], messageId: cursor[2] },
			limit,
		});
		const shownRefs = refs.slice(0, limit);
		const byRoom = new Map<string, string[]>();
		for (const ref of shownRefs) {
			const list = byRoom.get(ref.room_id);
			if (list) list.push(ref.message_id);
			else byRoom.set(ref.room_id, [ref.message_id]);
		}
		const roomResults = await Promise.all(
			[...byRoom.entries()].map(async ([roomId, ids]) => {
				const opened = openRoom(call, roomId);
				const res = await opened.room.getMessagesByIds(opened.ctx, ids);
				if ("error" in res) return [roomId, null] as const;
				return [roomId, res] as const;
			}),
		);
		const hydrated = new Map(roomResults);
		const items: ChatSavedMessage[] = [];
		for (const ref of shownRefs) {
			const data = hydrated.get(ref.room_id);
			if (!data) continue;
			const msg = data.messages.find((m) => m.id === ref.message_id);
			if (!msg) continue;
			items.push({
				room: data.room,
				message: messageOutput(msg),
				saved_at: iso(ref.saved_at),
			});
		}
		const last = shownRefs[shownRefs.length - 1];
		return {
			items,
			next_cursor: refs.length > limit && last ? encodeCursor([last.saved_at, last.room_id, last.message_id]) : null,
		};
	},

	// --- Scheduled messages ---------------------------------------------------------------------
	async "chat.schedule_message"(call, input) {
		const sendAt = parseFutureIso(input.send_at, "send_at", CHAT_LIMITS.scheduledMaxDays);
		const content = contentOf(input);
		if (!content || content.text.trim() === "") {
			throw new OperationError("invalid", "A scheduled message needs text.");
		}
		const opened = openRoom(call, input.room_id);
		const found = accept(await opened.room.get(opened.ctx));
		if (found.room.role === null) {
			throw new OperationError("forbidden", "You are not a member of this room.");
		}
		if (found.room.archived_at != null) {
			throw new OperationError("conflict", "This room is archived and read-only.");
		}
		if (found.room.can_post === false) {
			throw new OperationError("forbidden", "You do not have permission to post in this room.");
		}
		const scheduled = await principalStub(call.env, call.caller.id).scheduleChatMessage({
			id: newId("csch"),
			principalId: call.caller.id,
			actor: actorOf(call),
			roomId: input.room_id,
			parentId: input.parent_id ?? null,
			alsoInRoom: input.also_in_room ?? false,
			text: content.text,
			bodyJson: JSON.stringify(content.body),
			markdown: bodyMarkdown(content.body),
			sendAt,
			credentialBindingJson: JSON.stringify(credentialBinding(call.caller)),
		});
		if (scheduled === "full") {
			throw new OperationError(
				"conflict",
				`You can have ${CHAT_LIMITS.scheduledMessages} pending scheduled messages at most.`,
			);
		}
		auditOk(call, "chat.schedule_message", `${input.room_id}:${scheduled.id}`);
		return { scheduled: toScheduled(scheduled) };
	},

	async "chat.list_scheduled_messages"(call, input) {
		const rows = await principalStub(call.env, call.caller.id).listScheduledChatMessages(
			input.room_id,
			input.status ?? "pending",
		);
		return { scheduled: rows.map(toScheduled) };
	},

	async "chat.update_scheduled_message"(call, input) {
		const content = contentOf(input);
		const sendAt =
			input.send_at === undefined ? undefined : parseFutureIso(input.send_at, "send_at", CHAT_LIMITS.scheduledMaxDays);
		const updated = await principalStub(call.env, call.caller.id).updateScheduledChatMessage(input.scheduled_id, {
			...(content
				? { text: content.text, bodyJson: JSON.stringify(content.body), markdown: bodyMarkdown(content.body) }
				: {}),
			...(sendAt === undefined ? {} : { sendAt }),
		});
		if (updated === "not_found") throw new OperationError("not_found", "No scheduled message has that id.");
		if (updated === "not_pending") {
			throw new OperationError("conflict", "Only a pending scheduled message can be changed.");
		}
		return { scheduled: toScheduled(updated) };
	},

	async "chat.cancel_scheduled_message"(call, input) {
		const deleted = await principalStub(call.env, call.caller.id).cancelScheduledChatMessage(input.scheduled_id);
		return { deleted };
	},

	// --- Reminders ------------------------------------------------------------------------------
	async "chat.create_reminder"(call, input) {
		const remindAt = parseFutureIso(input.remind_at, "remind_at");
		const opened = openRoom(call, input.room_id);
		const verified = accept(await opened.room.verifyMessageForPersonal(opened.ctx, input.message_id));
		const created = await principalStub(call.env, call.caller.id).createChatReminder({
			id: newId("crem"),
			roomId: verified.roomId,
			messageId: verified.message.id,
			seq: verified.message.seq,
			parentId: verified.message.parent_id,
			parentSeq: verified.parentSeq,
			note: input.note ?? "",
			preview: verified.message.text.replace(/\s+/g, " ").trim().slice(0, 200),
			untrusted: verified.message.untrusted,
			remindAt,
			actor: actorOf(call),
		});
		if (created === "full") {
			throw new OperationError("conflict", `You can have ${CHAT_LIMITS.reminders} active reminders at most.`);
		}
		return { reminder: toReminder(created) };
	},

	async "chat.list_reminders"(call, input) {
		const rows = await principalStub(call.env, call.caller.id).listChatReminders(input.include_completed === "true");
		return { reminders: rows.map(toReminder) };
	},

	async "chat.complete_reminder"(call, input) {
		const updated = await principalStub(call.env, call.caller.id).completeChatReminder(input.reminder_id);
		if (!updated) throw new OperationError("not_found", "No reminder has that id.");
		return { reminder: toReminder(updated) };
	},

	async "chat.delete_reminder"(call, input) {
		const deleted = await principalStub(call.env, call.caller.id).deleteChatReminder(input.reminder_id);
		return { deleted };
	},

	// --- Drafts ---------------------------------------------------------------------------------
	async "chat.list_drafts"(call, input) {
		const drafts = await principalStub(call.env, call.caller.id).listChatDrafts(input.room_id);
		return { drafts: drafts.map(toDraft) };
	},

	async "chat.save_draft"(call, input) {
		const opened = openRoom(call, input.room_id);
		const found = accept(await opened.room.get(opened.ctx));
		if (found.room.role === null) {
			throw new OperationError("forbidden", "You are not a member of this room.");
		}
		const content = contentOf(input) ?? { body: textBody(""), text: "" };
		const saved = await principalStub(call.env, call.caller.id).saveChatDraft({
			roomId: input.room_id,
			parentId: input.parent_id ?? null,
			bodyJson: JSON.stringify(content.body),
			text: content.text,
			markdown: bodyMarkdown(content.body),
		});
		return { draft: toDraft(saved) };
	},

	async "chat.delete_draft"(call, input) {
		const deleted = await principalStub(call.env, call.caller.id).deleteChatDraft(
			input.room_id,
			input.parent_id ?? null,
		);
		return { deleted };
	},

	// --- Custom emoji ---------------------------------------------------------------------------
	async "chat.list_custom_emoji"(call) {
		return { emoji: await listCustomEmoji(call.env.DIRECTORY) };
	},

	async "chat.create_custom_emoji"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only organization owners and admins can add custom emoji.");
		}
		const emoji = await createCustomEmoji(call, input);
		return { emoji };
	},

	async "chat.delete_custom_emoji"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only organization owners and admins can delete custom emoji.");
		}
		const deleted = await deleteCustomEmoji(call, input.name);
		return { deleted };
	},

	// --- Forward message ------------------------------------------------------------------------
	async "chat.forward_message"(call, input) {
		const src = openRoom(call, input.room_id);
		const snapshot = accept(await src.room.messageForForward(src.ctx, input.message_id));
		const dst = openRoom(call, input.target_room_id);
		const content = contentOf(input) ?? { body: textBody(""), text: "" };
		const idempotency =
			input.idempotency_key === undefined
				? undefined
				: {
						key: `${call.caller.id}:${input.idempotency_key}`,
						requestHash: await sha256Hex(
							JSON.stringify([
								"chat.forward_message",
								input.room_id,
								input.message_id,
								input.target_room_id,
								content.text,
								content.body,
							]),
						),
					};
		const posted = accept(
			await dst.room.postMessage(dst.ctx, {
				id: newId("cmsg"),
				content,
				idempotency,
				clientKey: input.idempotency_key ?? null,
				parentId: null,
				alsoInRoom: false,
				linkOrigin: call.origin,
				forwarded: snapshot,
				untrusted: snapshot.untrusted,
			}),
		);
		if (!posted.duplicate) {
			auditOk(
				call,
				"chat.forward_message",
				`${input.room_id}:${input.message_id}->${input.target_room_id}:${posted.message.id}`,
			);
		}
		return { message: messageOutput(posted.message) };
	},

	// --- Group DM -------------------------------------------------------------------------------
	async "chat.open_group_dm"(call, input) {
		const uniqueOthers = [...new Set(input.principal_ids)].filter((id) => id !== call.caller.id);
		if (uniqueOthers.length < 1) {
			throw new OperationError("invalid", "A direct message needs at least 1 other person or agent.");
		}
		if (uniqueOthers.length > CHAT_LIMITS.groupDmOthersMax) {
			throw new OperationError(
				"invalid",
				`A group direct message can have ${CHAT_LIMITS.groupDmOthersMax} other members at most.`,
			);
		}
		const peers = await actorsOf(call, uniqueOthers);
		if (peers.length === 1) {
			const peer = peers[0] as ActorRecord;
			const opened = openRoom(call, await dmRoomId(call.caller.id, peer.principal_id));
			const res = accept(await opened.room.openDm(opened.ctx, peer));
			if (res.created) {
				auditOk(call, "chat.open_dm", res.room.id);
				recordServiceMemberships(call, [peer.principal_id], "chat.open_dm", res.room.id);
			}
			return { room: toRoom(res.room) };
		}
		const roomId = await groupDmRoomId([call.caller.id, ...uniqueOthers]);
		const opened = openRoom(call, roomId);
		const res = accept(await opened.room.openGroupDm(opened.ctx, peers));
		if (res.created) {
			auditOk(call, "chat.open_group_dm", res.room.id);
			recordServiceMemberships(call, uniqueOthers, "chat.open_group_dm", res.room.id);
		}
		return { room: toRoom(res.room) };
	},

	// --- Room lifecycle, posting rules, retention -----------------------------------------------
	async "chat.archive_room"(call, input) {
		const opened = openRoom(call, input.room_id);
		const room = accept(await opened.room.archiveRoom(opened.ctx, isAdmin(call.caller)));
		auditOk(call, "chat.archive_room", input.room_id);
		return { room: toRoom(room) };
	},

	async "chat.unarchive_room"(call, input) {
		const opened = openRoom(call, input.room_id);
		const room = accept(await opened.room.unarchiveRoom(opened.ctx, isAdmin(call.caller)));
		auditOk(call, "chat.unarchive_room", input.room_id);
		return { room: toRoom(room) };
	},

	async "chat.delete_room"(call, input) {
		const missing = ALL_SCOPES.filter((scope) => !call.caller.scopes.has(scope));
		if (missing.length > 0) {
			throw new OperationError(
				"forbidden",
				`Deleting a room requires a full human credential. Your credential does not hold ${missing.join(", ")}.`,
			);
		}
		const opened = openRoom(call, input.room_id);
		// The service accounts of the room lose it. The index names them before the delete, for their logs.
		const services = input.dry_run === true ? [] : await serviceMemberIds(call.env.DIRECTORY, input.room_id);
		const res = accept(
			await opened.room.deleteRoom(opened.ctx, {
				dryRun: input.dry_run === true,
				allowAdmin: isAdmin(call.caller),
			}),
		);
		if (res.deleted) {
			auditOk(call, "chat.delete_room", input.room_id);
			recordServiceMemberships(call, services, "chat.delete_room", input.room_id);
		}
		return res;
	},

	async "chat.set_posting_rules"(call, input) {
		const opened = openRoom(call, input.room_id);
		const found = accept(await opened.room.get(opened.ctx));
		const canManage = found.room.role === "owner" || (isAdmin(call.caller) && found.room.kind === "public");
		if (!canManage) {
			throw new OperationError("forbidden", "Only the room owner or an organization admin can change posting rules.");
		}
		const allowedIds = input.allowed_principal_ids ?? [];
		if (input.policy === "allowlist" && allowedIds.length > 0) {
			await actorsOf(call, allowedIds);
		}
		const res = accept(
			await opened.room.setPostingRules(opened.ctx, {
				policy: input.policy,
				allowedIds,
				allowAdmin: isAdmin(call.caller),
			}),
		);
		auditOk(call, "chat.set_posting_rules", `${input.room_id}:${input.policy}`);
		return { room: toRoom(res.room), allowed_principal_ids: res.post_allowed_ids };
	},

	async "chat.set_room_retention"(call, input) {
		const opened = openRoom(call, input.room_id);
		const res = accept(
			await opened.room.setRetention(opened.ctx, {
				retentionDays: input.retention_days,
				dryRun: input.dry_run === true,
				allowAdmin: isAdmin(call.caller),
			}),
		);
		if (!res.dry_run) auditOk(call, "chat.set_room_retention", `${input.room_id}:${input.retention_days ?? "none"}`);
		return {
			room: toRoom(res.room),
			dry_run: res.dry_run,
			purged_count: res.dry_run ? res.affected_messages : res.pruned_messages,
		};
	},

	// --- Admin tools & Export -------------------------------------------------------------------
	async "chat.admin_list_rooms"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only organization owners and admins can list all rooms.");
		}
		const isOrgOwner = call.caller.principal.kind === "human" && call.caller.principal.org_role === "owner";
		const page = await adminListRooms(call.env.DIRECTORY, call.caller.id, isOrgOwner, {
			kind: input.kind ?? "all",
			ownerless: input.ownerless === "true",
			archived: input.archived ?? "all",
			query: input.query ?? null,
			cursor: input.cursor ?? null,
			limit: input.limit ?? DEFAULT_PAGE,
		});
		if (!page) throw new OperationError("invalid", "The cursor is not valid.");
		return { rooms: page.rooms, next_cursor: page.nextCursor };
	},

	async "chat.admin_assign_owner"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only organization owners and admins can assign a room owner.");
		}
		const [target] = await actorsOf(call, [input.principal_id]);
		const opened = openRoom(call, input.room_id);
		accept(await opened.room.adminAssignOwner(call.caller.id, target as ActorRecord));
		auditOk(call, "chat.admin_assign_owner", `${input.room_id}:${input.principal_id}`);
		recordServiceMemberships(call, [input.principal_id], "chat.admin_assign_owner", input.room_id);
		return { room_id: input.room_id, principal_id: input.principal_id, role: "owner" as const };
	},

	async "chat.admin_remove_deleted_principal"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only organization owners and admins can remove a deleted principal.");
		}
		const row = await call.env.DIRECTORY.prepare("SELECT id, deleted_at FROM principals WHERE id = ?")
			.bind(input.principal_id)
			.first<{ id: string; deleted_at: string | null }>();
		if (!row) throw new OperationError("not_found", `No person or agent has the id ${input.principal_id}.`);
		if (row.deleted_at === null) {
			throw new OperationError("invalid", "That principal is not deleted. Delete the principal first.");
		}
		const res = await removeDeletedPrincipalFromRooms(call.env, input.principal_id);
		auditOk(call, "chat.admin_remove_deleted_principal", `${input.principal_id}:${res.roomsCleaned}`);
		return {
			principal_id: input.principal_id,
			rooms_cleaned: res.roomsCleaned,
			failed_room_ids: res.failedRoomIds,
		};
	},

	async "chat.export_room"(call, input) {
		if (call.caller.principal.kind !== "human" || call.caller.principal.org_role !== "owner") {
			throw new OperationError("forbidden", "Only an organization owner can export a room.");
		}
		const limit = input.limit ?? 200;
		const opened = openRoom(call, input.room_id);
		const result = await opened.room.exportPage(opened.ctx, {
			allowNonMemberPublic: true,
			afterSeq: input.after_seq ?? 0,
			limit,
		});
		if ("error" in result) {
			audit({
				op: "chat.export_room",
				actor: call.caller.id,
				actorKind: call.caller.kind,
				credential: call.caller.credential,
				target: input.room_id,
				result: "denied",
				code: result.error.code,
				requestId: call.requestId,
			});
		}
		const page = accept(result);
		auditOk(call, "chat.export_room", input.room_id);
		return {
			room: toRoom(page.room),
			members: page.members.map((m) => ({ ...m, joined_at: iso(m.joined_at) })),
			pins: page.pins.map(toPin),
			messages: page.messages.map(messageOutput),
			exported_at: new Date().toISOString(),
			next_after_seq: page.nextAfterSeq,
		};
	},

	// --- Incoming webhooks ----------------------------------------------------------------------
	async "chat.create_incoming_webhook"(call, input) {
		await assertWebhookRoomAccess(call, input.room_id);
		return await createIncomingWebhook(call, input);
	},

	async "chat.list_incoming_webhooks"(call, input) {
		await assertWebhookRoomAccess(call, input.room_id);
		return { webhooks: await listIncomingWebhooks(call.env.DIRECTORY, input.room_id) };
	},

	async "chat.delete_incoming_webhook"(call, input) {
		const roomId = await getIncomingWebhookRoom(call.env.DIRECTORY, input.webhook_id);
		if (!roomId) throw new OperationError("not_found", "No incoming webhook has that id.");
		await assertWebhookRoomAccess(call, roomId);
		return { deleted: await deleteIncomingWebhook(call, roomId, input.webhook_id) };
	},

	// --- Slash commands -------------------------------------------------------------------------
	async "chat.list_slash_commands"(call) {
		return { commands: await listSlashCommands(call.env.DIRECTORY, isAdmin(call.caller)) };
	},

	async "chat.create_slash_command"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only organization owners and admins can manage slash commands.");
		}
		const command = await createSlashCommand(call, {
			command: input.command,
			description: input.description,
			usage_hint: input.usage_hint ?? "",
			operation: input.operation,
			input_template: input.input_template,
		});
		return { command };
	},

	async "chat.delete_slash_command"(call, input) {
		if (!isAdmin(call.caller)) {
			throw new OperationError("forbidden", "Only organization owners and admins can manage slash commands.");
		}
		return { deleted: await deleteSlashCommand(call, input.command_id) };
	},

	// Wired in `apps/dock/src/handlers.ts` where the full operation handler map is composed.
	async "chat.invoke_slash_command"() {
		throw new OperationError("invalid", "Slash command dispatcher is not configured.");
	},

	// --- Cards & interactive actions ------------------------------------------------------------
	async "chat.trigger_card_action"(call, input) {
		const opened = openRoom(call, input.room_id);
		const res = accept(
			await opened.room.triggerCardAction(opened.ctx, {
				id: newId("cact"),
				messageId: input.message_id,
				cardId: input.card_id,
				actionId: input.action_id,
				idempotencyKey: input.idempotency_key,
			}),
		);
		auditOk(call, "chat.trigger_card_action", `${input.room_id}:${input.message_id}:${input.action_id}`);
		return res;
	},

	async "chat.list_card_actions"(call, input) {
		const cursor =
			input.cursor === undefined ? null : decodeCursor<[number, string]>(input.cursor, ["number", "string"]);
		if (input.cursor !== undefined && cursor === null) {
			throw new OperationError("invalid", "The cursor is not from this list.");
		}
		const opened = openRoom(call, input.room_id);
		const res = accept(await opened.room.listCardActions(opened.ctx, input.message_id, cursor, input.limit ?? 50));
		return {
			actions: res.actions,
			next_cursor: res.nextCursor ? encodeCursor(res.nextCursor) : null,
		};
	},
};

import {
	CHAT_LIMITS,
	ChatBody,
	ChatCardAction,
	ChatMember,
	ChatMessage,
	ChatRoom,
	ChatSearchRoom,
	CustomEmojiName,
	MESSAGE_FORMS,
	MessageId,
	POSTING_POLICIES,
	PrincipalId,
	ROOM_KINDS,
	RoomId,
} from "./chat.ts";
import { prefixedId, Timestamp } from "./common.ts";
import { Actor } from "./drive.ts";
import { defineOperation } from "./operation.ts";
import { AgentAccessChange } from "./restrictions.ts";
import { z } from "./zod.ts";

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const CREATE = { readOnly: false, destructive: false, idempotent: false, openWorld: false } as const;
const CHANGE = { readOnly: false, destructive: false, idempotent: true, openWorld: false } as const;
const REMOVE = { readOnly: false, destructive: true, idempotent: true, openWorld: false } as const;

const SectionId = prefixedId("csec");
const ScheduledId = prefixedId("csch");
const ReminderId = prefixedId("crem");
const IncomingWebhookId = prefixedId("iwh");
const SlashCommandId = prefixedId("cmd");

const NO_CTRL = (value: string) => !/\p{Cc}/u.test(value);

// ---------------------------------------------------------------------------
// Activity feed (mentions, replies, reactions, reminders, card actions)
// ---------------------------------------------------------------------------

export const CHAT_ACTIVITY_KINDS = ["mention", "reply", "reaction", "reminder", "card_action"] as const;
export type ChatActivityKind = (typeof CHAT_ACTIVITY_KINDS)[number];

export const ChatActivityItem = z.object({
	id: z.string(),
	kind: z.enum(CHAT_ACTIVITY_KINDS),
	room_id: z.string(),
	room_name: z.string().nullable(),
	message_id: z.string(),
	parent_id: z.string().nullable(),
	seq: z.number().int().nonnegative(),
	parent_seq: z.number().int().nonnegative().nullable(),
	actor: Actor,
	emoji: z.string().nullable(),
	preview: z.string(),
	untrusted: z.boolean().default(false),
	created_at: Timestamp,
	read_at: Timestamp.nullable(),
});
export type ChatActivityItem = z.infer<typeof ChatActivityItem>;

export const listActivity = defineOperation({
	name: "chat.list_activity",
	summary: "List your activity: mentions, replies, reactions, reminders and card clicks",
	description:
		"Returns recent activity items for you, newest first. Filter by kind or by unread. Pass next_cursor as cursor for the next page.",
	http: { method: "GET", path: "/api/v1/chat/activity" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		filter: z.enum(["all", "unread", ...CHAT_ACTIVITY_KINDS]).default("all"),
		cursor: z.string().max(500).optional(),
		limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional(),
	}),
	output: z.object({
		items: z.array(ChatActivityItem),
		unread_count: z.number().int().nonnegative(),
		next_cursor: z.string().nullable(),
	}),
	errors: ["invalid"],
});

export const markActivityRead = defineOperation({
	name: "chat.mark_activity_read",
	summary: "Mark one activity item or all activity items as read",
	description: "Marks one activity item as read when activity_id is set. Otherwise marks all unread items as read.",
	http: { method: "POST", path: "/api/v1/chat/activity/read" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({
		activity_id: z.string().min(1).max(200).optional(),
	}),
	output: z.object({
		unread_count: z.number().int().nonnegative(),
	}),
	errors: [],
});

// ---------------------------------------------------------------------------
// Custom sidebar sections
// ---------------------------------------------------------------------------

const SectionName = z
	.string()
	.trim()
	.min(1)
	.max(CHAT_LIMITS.sectionNameChars)
	.refine(NO_CTRL, "must not contain control characters");

export const ChatSection = z.object({
	id: z.string(),
	name: z.string(),
	position: z.number().int().nonnegative(),
	room_ids: z.array(z.string()),
	created_at: Timestamp,
});
export type ChatSection = z.infer<typeof ChatSection>;

export const listSections = defineOperation({
	name: "chat.list_sections",
	summary: "List your custom sidebar sections",
	description: "Returns your sidebar sections in display order, each with the ids of the rooms in it.",
	http: { method: "GET", path: "/api/v1/chat/sections" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({}),
	output: z.object({ sections: z.array(ChatSection) }),
	errors: [],
});

export const createSection = defineOperation({
	name: "chat.create_section",
	summary: "Create a custom sidebar section",
	description: `Creates a personal sidebar section to group your rooms. You can have at most ${CHAT_LIMITS.sectionsPerPrincipal} sections.`,
	http: { method: "POST", path: "/api/v1/chat/sections" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CREATE,
	input: z.strictObject({ name: SectionName }),
	output: z.object({ section: ChatSection }),
	errors: ["conflict"],
});

export const updateSection = defineOperation({
	name: "chat.update_section",
	summary: "Rename or reorder a custom sidebar section",
	description: "Changes the name or position of one of your sidebar sections.",
	http: { method: "POST", path: "/api/v1/chat/sections/{section_id}" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z
		.strictObject({
			section_id: SectionId,
			name: SectionName.optional(),
			position: z.number().int().min(0).max(CHAT_LIMITS.sectionsPerPrincipal).optional(),
		})
		.refine((input) => input.name !== undefined || input.position !== undefined, "set name or position"),
	output: z.object({ section: ChatSection }),
	errors: ["not_found"],
});

export const deleteSection = defineOperation({
	name: "chat.delete_section",
	summary: "Delete a custom sidebar section",
	description: "Deletes a sidebar section. Rooms in that section return to the default lists.",
	http: { method: "DELETE", path: "/api/v1/chat/sections/{section_id}" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({ section_id: SectionId }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

export const setRoomSection = defineOperation({
	name: "chat.set_room_section",
	summary: "Move a room into or out of a custom sidebar section",
	description:
		"Puts a joined room into one of your sidebar sections, or removes it from its section when section_id is null.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/section" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({
		room_id: RoomId,
		section_id: SectionId.nullable(),
	}),
	output: z.object({
		room_id: z.string(),
		section_id: z.string().nullable(),
	}),
	errors: ["not_found", "forbidden"],
});

// ---------------------------------------------------------------------------
// Pins for a room
// ---------------------------------------------------------------------------

export const ChatPin = z.object({
	message: ChatMessage,
	pinned_by: Actor,
	pinned_at: Timestamp,
});
export type ChatPin = z.infer<typeof ChatPin>;

export const pinMessage = defineOperation({
	name: "chat.pin_message",
	summary: "Pin a message in a room",
	description: `Pins a message in the room. A room can have at most ${CHAT_LIMITS.pinsPerRoom} pins. A deleted message cannot be pinned. You must be a member of the room.`,
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/pin" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId }),
	output: z.object({ pin: ChatPin, message: ChatMessage }),
	errors: ["not_found", "invalid", "conflict"],
});

export const unpinMessage = defineOperation({
	name: "chat.unpin_message",
	summary: "Remove a pin from a message",
	description: "Removes the pin from a message in the room. You must be a member of the room.",
	http: { method: "DELETE", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/pin" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId }),
	output: z.object({ unpinned: z.boolean(), message: ChatMessage }),
	errors: ["not_found", "conflict"],
});

export const listPins = defineOperation({
	name: "chat.list_pins",
	summary: "List pinned messages in a room",
	description: "Returns the pinned messages of the room, newest pin first. You must be a member of the room.",
	http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}/pins" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({ room_id: RoomId }),
	output: z.object({ pins: z.array(ChatPin) }),
	errors: ["not_found"],
});

// ---------------------------------------------------------------------------
// Saved messages for a person or agent
// ---------------------------------------------------------------------------

export const ChatSavedMessage = z.object({
	room: ChatSearchRoom,
	message: ChatMessage,
	saved_at: Timestamp,
});
export type ChatSavedMessage = z.infer<typeof ChatSavedMessage>;

export const saveMessage = defineOperation({
	name: "chat.save_message",
	summary: "Save a message for later",
	description: `Adds a message to your personal saved list. You can save at most ${CHAT_LIMITS.savedMessages} messages. You must be a member of the room.`,
	http: { method: "POST", path: "/api/v1/chat/saved" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId }),
	output: z.object({ saved: z.boolean(), saved_at: Timestamp }),
	errors: ["not_found", "invalid", "conflict"],
});

export const unsaveMessage = defineOperation({
	name: "chat.unsave_message",
	summary: "Remove a message from your saved list",
	description: "Removes a message from your personal saved list. Safe to call again.",
	http: { method: "DELETE", path: "/api/v1/chat/saved/{room_id}/{message_id}" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId }),
	output: z.object({ removed: z.boolean() }),
	errors: [],
});

export const listSavedMessages = defineOperation({
	name: "chat.list_saved_messages",
	summary: "List your saved messages",
	description:
		"Returns messages that you saved, newest save first. Messages that were deleted or belong to rooms that you left are omitted.",
	http: { method: "GET", path: "/api/v1/chat/saved" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		cursor: z.string().max(500).optional(),
		limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional(),
	}),
	output: z.object({
		items: z.array(ChatSavedMessage),
		next_cursor: z.string().nullable(),
	}),
	errors: ["invalid"],
});

// ---------------------------------------------------------------------------
// Scheduled messages
// ---------------------------------------------------------------------------

export const ChatScheduledMessage = z.object({
	id: z.string(),
	room_id: z.string(),
	parent_id: z.string().nullable(),
	also_in_room: z.boolean(),
	text: z.string(),
	body: ChatBody,
	markdown: z.string(),
	send_at: Timestamp,
	created_at: Timestamp,
	status: z.enum(["pending", "sent", "failed"]),
	sent_message_id: z.string().nullable(),
	error: z.string().nullable(),
});
export type ChatScheduledMessage = z.infer<typeof ChatScheduledMessage>;

function oneTextForm(input: { text?: unknown; markdown?: unknown; body?: unknown }): boolean {
	return [input.text, input.markdown, input.body].filter((value) => value !== undefined).length === 1;
}

export const scheduleMessage = defineOperation({
	name: "chat.schedule_message",
	summary: "Schedule a message to be sent later",
	description: `Queues a message to post in a room at send_at (UTC ISO 8601 timestamp up to ${CHAT_LIMITS.scheduledMaxDays} days ahead). You must be a member and permitted to post in the room.`,
	http: { method: "POST", path: "/api/v1/chat/scheduled" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CREATE,
	input: z
		.strictObject({
			room_id: RoomId,
			...MESSAGE_FORMS,
			parent_id: MessageId.optional(),
			also_in_room: z.boolean().optional(),
			send_at: Timestamp,
		})
		.refine(oneTextForm, "set exactly one of text, markdown and body")
		.refine((input) => input.also_in_room !== true || input.parent_id !== undefined, {
			message: "also_in_room needs parent_id",
		}),
	output: z.object({ scheduled: ChatScheduledMessage }),
	errors: ["not_found", "invalid", "conflict", "forbidden"],
});

export const listScheduledMessages = defineOperation({
	name: "chat.list_scheduled_messages",
	summary: "List your scheduled messages",
	description: "Returns your scheduled messages ordered by send_at. Filter by room_id or status.",
	http: { method: "GET", path: "/api/v1/chat/scheduled" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		room_id: RoomId.optional(),
		status: z.enum(["pending", "sent", "failed", "all"]).default("pending"),
	}),
	output: z.object({ scheduled: z.array(ChatScheduledMessage) }),
	errors: [],
});

export const updateScheduledMessage = defineOperation({
	name: "chat.update_scheduled_message",
	summary: "Change the content or time of a pending scheduled message",
	description: "Updates the text or send_at time of a pending scheduled message.",
	http: { method: "POST", path: "/api/v1/chat/scheduled/{scheduled_id}" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z
		.strictObject({
			scheduled_id: ScheduledId,
			...MESSAGE_FORMS,
			send_at: Timestamp.optional(),
		})
		.refine((input) => {
			const forms = [input.text, input.markdown, input.body].filter((value) => value !== undefined).length;
			return forms <= 1 && (forms === 1 || input.send_at !== undefined);
		}, "set send_at, one content form (text, markdown, or body), or both"),
	output: z.object({ scheduled: ChatScheduledMessage }),
	errors: ["not_found", "invalid", "conflict"],
});

export const cancelScheduledMessage = defineOperation({
	name: "chat.cancel_scheduled_message",
	summary: "Cancel a scheduled message",
	description: "Removes a scheduled message before it is sent, or clears a failed entry.",
	http: { method: "DELETE", path: "/api/v1/chat/scheduled/{scheduled_id}" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({ scheduled_id: ScheduledId }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

// ---------------------------------------------------------------------------
// Reminders about a message
// ---------------------------------------------------------------------------

export const ChatReminder = z.object({
	id: z.string(),
	room_id: z.string(),
	message_id: z.string(),
	seq: z.number().int(),
	parent_id: z.string().nullable(),
	parent_seq: z.number().int().nullable(),
	note: z.string(),
	preview: z.string(),
	untrusted: z.boolean().default(false),
	remind_at: Timestamp,
	created_at: Timestamp,
	triggered_at: Timestamp.nullable(),
	completed_at: Timestamp.nullable(),
});
export type ChatReminder = z.infer<typeof ChatReminder>;

export const createReminder = defineOperation({
	name: "chat.create_reminder",
	summary: "Set a reminder about a message",
	description: `Creates a personal reminder for a message at remind_at. When the time comes, the reminder appears in your Activity feed. You must be a member of the room.`,
	http: { method: "POST", path: "/api/v1/chat/reminders" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CREATE,
	input: z.strictObject({
		room_id: RoomId,
		message_id: MessageId,
		remind_at: Timestamp,
		note: z
			.string()
			.trim()
			.max(CHAT_LIMITS.reminderNoteChars)
			.refine(NO_CTRL, "must not contain control characters")
			.optional(),
	}),
	output: z.object({ reminder: ChatReminder }),
	errors: ["not_found", "invalid", "conflict"],
});

export const listReminders = defineOperation({
	name: "chat.list_reminders",
	summary: "List your message reminders",
	description: "Returns your message reminders ordered by remind_at.",
	http: { method: "GET", path: "/api/v1/chat/reminders" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		include_completed: z.enum(["true", "false"]).optional(),
	}),
	output: z.object({ reminders: z.array(ChatReminder) }),
	errors: [],
});

export const completeReminder = defineOperation({
	name: "chat.complete_reminder",
	summary: "Mark a reminder as done",
	description: "Marks one of your reminders as completed.",
	http: { method: "POST", path: "/api/v1/chat/reminders/{reminder_id}/complete" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ reminder_id: ReminderId }),
	output: z.object({ reminder: ChatReminder }),
	errors: ["not_found"],
});

export const deleteReminder = defineOperation({
	name: "chat.delete_reminder",
	summary: "Delete a reminder",
	description: "Deletes one of your reminders.",
	http: { method: "DELETE", path: "/api/v1/chat/reminders/{reminder_id}" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({ reminder_id: ReminderId }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

// ---------------------------------------------------------------------------
// Synced drafts across devices
// ---------------------------------------------------------------------------

export const ChatDraft = z.object({
	room_id: z.string(),
	parent_id: z.string().nullable(),
	body: ChatBody,
	text: z.string(),
	markdown: z.string(),
	updated_at: Timestamp,
});
export type ChatDraft = z.infer<typeof ChatDraft>;

export const listDrafts = defineOperation({
	name: "chat.list_drafts",
	summary: "List your synced drafts",
	description: "Returns your unsent drafts across rooms and threads, newest change first.",
	http: { method: "GET", path: "/api/v1/chat/drafts" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		room_id: RoomId.optional(),
	}),
	output: z.object({ drafts: z.array(ChatDraft) }),
	errors: [],
});

export const saveDraft = defineOperation({
	name: "chat.save_draft",
	summary: "Save a synced draft for a room or thread",
	description:
		"Stores your draft on the server so every device sees the same draft. Replaces any prior draft for that room or thread.",
	http: { method: "POST", path: "/api/v1/chat/drafts" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z
		.strictObject({
			room_id: RoomId,
			parent_id: MessageId.optional(),
			...MESSAGE_FORMS,
		})
		.refine(oneTextForm, "set exactly one of text, markdown and body"),
	output: z.object({ draft: ChatDraft }),
	errors: ["not_found", "invalid"],
});

export const deleteDraft = defineOperation({
	name: "chat.delete_draft",
	summary: "Delete a synced draft",
	description: "Removes your saved draft for a room or thread.",
	http: { method: "DELETE", path: "/api/v1/chat/drafts" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({
		room_id: RoomId,
		parent_id: MessageId.optional(),
	}),
	output: z.object({ deleted: z.boolean() }),
	errors: [],
});

// ---------------------------------------------------------------------------
// Custom emoji for the organization
// ---------------------------------------------------------------------------

export const ChatCustomEmoji = z.object({
	name: z.string(),
	mime_type: z.string(),
	size: z.number().int(),
	width: z.number().int(),
	height: z.number().int(),
	url_path: z.string(),
	created_by: z.string(),
	created_at: Timestamp,
});
export type ChatCustomEmoji = z.infer<typeof ChatCustomEmoji>;

export const listCustomEmoji = defineOperation({
	name: "chat.list_custom_emoji",
	summary: "List custom emoji of the organization",
	description: "Returns all custom emoji registered for this organization. Use :name: in reactions or message text.",
	http: { method: "GET", path: "/api/v1/chat/emoji" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({}),
	output: z.object({ emoji: z.array(ChatCustomEmoji) }),
	errors: [],
});

export const createCustomEmoji = defineOperation({
	name: "chat.create_custom_emoji",
	summary: "Add a custom emoji for the organization",
	description: `Owners and admins only. Uploads a PNG, JPEG, GIF or WebP image (at most ${CHAT_LIMITS.customEmojiBytes / 1024} KiB and ${CHAT_LIMITS.customEmojiPixels}x${CHAT_LIMITS.customEmojiPixels} pixels) as :name:.`,
	http: { method: "POST", path: "/api/v1/chat/emoji" },
	scopes: ["chat.write"],
	callers: ["human"],
	annotations: CREATE,
	auditDenied: true,
	input: z.strictObject({
		name: CustomEmojiName,
		content_base64: z
			.string()
			.min(1)
			.max(Math.ceil((CHAT_LIMITS.customEmojiBytes * 4) / 3) + 16),
	}),
	output: z.object({ emoji: ChatCustomEmoji }),
	errors: ["forbidden", "invalid", "conflict", "payload_too_large"],
});

export const deleteCustomEmoji = defineOperation({
	name: "chat.delete_custom_emoji",
	summary: "Delete a custom emoji of the organization",
	description: "Owners and admins only. Deletes a custom emoji and its stored image.",
	http: { method: "DELETE", path: "/api/v1/chat/emoji/{name}" },
	scopes: ["chat.write"],
	callers: ["human"],
	annotations: REMOVE,
	auditDenied: true,
	input: z.strictObject({ name: CustomEmojiName }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["forbidden", "not_found"],
});

// ---------------------------------------------------------------------------
// Forward a message to a different room
// ---------------------------------------------------------------------------

export const forwardMessage = defineOperation({
	name: "chat.forward_message",
	summary: "Forward a message to a different room",
	description:
		"Posts a message in target_room_id that carries a snapshot of message_id from room_id, with optional commentary. You must be a member of both rooms and permitted to post in target_room_id.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/forward" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CREATE,
	input: z
		.strictObject({
			room_id: RoomId,
			message_id: MessageId,
			target_room_id: RoomId,
			...MESSAGE_FORMS,
			idempotency_key: z.string().min(1).max(255).optional(),
		})
		.refine(
			(input) => [input.text, input.markdown, input.body].filter((value) => value !== undefined).length <= 1,
			"set at most one of text, markdown and body",
		),
	output: z.object({ message: ChatMessage }),
	errors: ["not_found", "invalid", "conflict", "forbidden", "rate_limited"],
});

// ---------------------------------------------------------------------------
// Group direct messages
// ---------------------------------------------------------------------------

export const openGroupDm = defineOperation({
	name: "chat.open_group_dm",
	summary: "Open a direct message room with a group of people or agents",
	description: `Returns the group direct message room for you and principal_ids (2 to ${CHAT_LIMITS.groupDmOthersMax} other principals, or 1 for a two-person DM). Creates it when it does not exist. The same set of principals always returns the same room.`,
	http: { method: "POST", path: "/api/v1/chat/group-dms" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({
		principal_ids: z.array(PrincipalId).min(1).max(CHAT_LIMITS.groupDmOthersMax),
	}),
	output: z.object({
		room: ChatRoom,
		agent_access_changes: z.array(AgentAccessChange).default([]),
		/** The agents that you manage, that are members of the room, and that did not get their access. */
		agent_access_pending: z.array(z.string()).default([]),
	}),
	errors: ["not_found", "invalid"],
});

// ---------------------------------------------------------------------------
// Archive, delete, posting rules, retention
// ---------------------------------------------------------------------------

export const archiveRoom = defineOperation({
	name: "chat.archive_room",
	summary: "Archive a room",
	description:
		"Makes a public or private room read-only. Members can still read history and leave, but nobody can post, edit, delete, react, pin or join. Room owners can archive any room they own; organization admins can also archive public rooms.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/archive" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId }),
	output: z.object({ room: ChatRoom }),
	errors: ["not_found", "forbidden", "invalid", "conflict"],
});

export const unarchiveRoom = defineOperation({
	name: "chat.unarchive_room",
	summary: "Unarchive a room",
	description:
		"Restores an archived room so members can post and join again. Room owners can unarchive any room they own; organization admins can also unarchive public rooms.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/unarchive" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId }),
	output: z.object({ room: ChatRoom }),
	errors: ["not_found", "forbidden", "invalid", "conflict"],
});

export const deleteRoom = defineOperation({
	name: "chat.delete_room",
	summary: "Delete a room and all of its messages",
	description:
		"Permanently deletes a public or private room and its messages. Cannot be undone. Set dry_run: true to preview member and message counts without deleting. Requires a full human credential; room owners can delete any room they own, and organization admins can also delete public rooms.",
	http: { method: "DELETE", path: "/api/v1/chat/rooms/{room_id}" },
	scopes: ["chat.write"],
	callers: ["human"],
	annotations: REMOVE,
	input: z.strictObject({
		room_id: RoomId,
		dry_run: z.boolean().optional(),
	}),
	output: z.object({
		deleted: z.boolean(),
		dry_run: z.boolean(),
		message_count: z.number().int().nonnegative(),
		member_count: z.number().int().nonnegative(),
	}),
	errors: ["not_found", "forbidden", "invalid"],
});

export const setPostingRules = defineOperation({
	name: "chat.set_posting_rules",
	summary: "Set who can post messages in a room",
	description:
		"Sets the posting rule of a public or private room: members (all members), owners_only (room owners only), or allowlist (room owners plus allowed_principal_ids). Room owners can change any room they own; organization admins can also change public rooms.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/posting-rules" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CHANGE,
	input: z.strictObject({
		room_id: RoomId,
		policy: z.enum(POSTING_POLICIES),
		allowed_principal_ids: z.array(PrincipalId).max(CHAT_LIMITS.membersPerRoom).optional(),
	}),
	output: z.object({
		room: ChatRoom,
		allowed_principal_ids: z.array(z.string()),
	}),
	errors: ["not_found", "forbidden", "invalid", "conflict"],
});

export const setRoomRetention = defineOperation({
	name: "chat.set_room_retention",
	summary: "Set the message retention rule for a room",
	description: `Sets how many days messages stay in the room (1 to ${CHAT_LIMITS.retentionMaxDays}), or null to keep forever. Messages older than retention_days are deleted automatically. Set dry_run: true to see how many messages would be deleted right now.`,
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/retention" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: REMOVE,
	input: z.strictObject({
		room_id: RoomId,
		retention_days: z.number().int().min(1).max(CHAT_LIMITS.retentionMaxDays).nullable(),
		dry_run: z.boolean().optional(),
	}),
	output: z.object({
		room: ChatRoom,
		dry_run: z.boolean(),
		purged_count: z.number().int().nonnegative(),
	}),
	errors: ["not_found", "forbidden", "invalid"],
});

// ---------------------------------------------------------------------------
// Admin tools & Room export
// ---------------------------------------------------------------------------

export const ChatAdminRoom = z.object({
	id: z.string(),
	kind: z.enum(ROOM_KINDS),
	name: z.string().nullable(),
	topic: z.string(),
	created_at: Timestamp,
	created_by: Actor,
	member_count: z.number().int().nonnegative(),
	owner_count: z.number().int().nonnegative(),
	last_seq: z.number().int().nonnegative(),
	last_message_at: Timestamp.nullable(),
	archived_at: Timestamp.nullable(),
	posting_policy: z.enum(POSTING_POLICIES),
	retention_days: z.number().int().nullable(),
	is_member: z.boolean(),
	exportable: z.boolean(),
});
export type ChatAdminRoom = z.infer<typeof ChatAdminRoom>;

export const adminListRooms = defineOperation({
	name: "chat.admin_list_rooms",
	summary: "List all organization rooms for administration",
	description:
		"Owners and admins of the organization only. Lists metadata of all public and private rooms, including ownerless and archived rooms. Does not expose messages of private rooms.",
	http: { method: "GET", path: "/api/v1/chat/admin/rooms" },
	scopes: ["chat.read"],
	callers: ["human"],
	annotations: READ,
	auditDenied: true,
	input: z.strictObject({
		kind: z.enum(["all", "public", "private"]).default("all"),
		archived: z.enum(["all", "active", "archived"]).default("all"),
		ownerless: z.enum(["true", "false"]).optional(),
		query: z.string().trim().min(1).max(CHAT_LIMITS.queryChars).optional(),
		cursor: z.string().max(2000).optional(),
		limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional(),
	}),
	output: z.object({
		rooms: z.array(ChatAdminRoom),
		next_cursor: z.string().nullable(),
	}),
	errors: ["forbidden", "invalid"],
});

export const adminAssignOwner = defineOperation({
	name: "chat.admin_assign_owner",
	summary: "Assign a room owner",
	description:
		"Owners and admins of the organization only. Makes principal_id an owner of room_id (adding them to the room if needed). Used to give an owner to a room without one.",
	http: { method: "POST", path: "/api/v1/chat/admin/rooms/{room_id}/owner" },
	scopes: ["chat.write"],
	callers: ["human"],
	annotations: CHANGE,
	auditDenied: true,
	input: z.strictObject({
		room_id: RoomId,
		principal_id: PrincipalId,
	}),
	output: z.object({
		room_id: z.string(),
		principal_id: z.string(),
		role: z.literal("owner"),
	}),
	errors: ["forbidden", "not_found", "invalid", "conflict"],
});

export const adminRemoveDeletedPrincipal = defineOperation({
	name: "chat.admin_remove_deleted_principal",
	summary: "Remove a deleted principal from all of its rooms",
	description:
		"Owners and admins of the organization only. Removes a deleted principal from every room it still belongs to, promoting the earliest remaining member when it was an owner.",
	http: { method: "POST", path: "/api/v1/chat/admin/deleted-principals/{principal_id}/remove" },
	scopes: ["chat.write"],
	callers: ["human"],
	annotations: REMOVE,
	auditDenied: true,
	input: z.strictObject({
		principal_id: PrincipalId,
	}),
	output: z.object({
		principal_id: z.string(),
		rooms_cleaned: z.number().int().nonnegative(),
		failed_room_ids: z.array(z.string()),
	}),
	errors: ["forbidden", "not_found", "invalid"],
});

export const exportRoom = defineOperation({
	name: "chat.export_room",
	summary: "Export a room and its messages",
	description:
		"Organization owners only. Exports metadata, members, pins and paginated messages of a public room, or of a private room or direct message where the owner is a member. Audited on every call.",
	http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}/export" },
	scopes: ["chat.read"],
	callers: ["human"],
	annotations: READ,
	auditDenied: true,
	input: z.strictObject({
		room_id: RoomId,
		after_seq: z.coerce.number().int().min(0).optional(),
		limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.exportPageSize).optional(),
	}),
	output: z.object({
		room: ChatRoom,
		members: z.array(ChatMember),
		pins: z.array(ChatPin),
		messages: z.array(ChatMessage),
		next_after_seq: z.number().int().nullable(),
		exported_at: Timestamp,
	}),
	errors: ["forbidden", "not_found"],
});

// ---------------------------------------------------------------------------
// Incoming webhooks (Slack-compatible signed payload, marked untrusted: true)
// ---------------------------------------------------------------------------

export const ChatIncomingWebhook = z.object({
	id: z.string(),
	room_id: z.string(),
	name: z.string(),
	url_path: z.string(),
	created_by: z.string(),
	created_at: Timestamp,
});
export type ChatIncomingWebhook = z.infer<typeof ChatIncomingWebhook>;

export const createIncomingWebhook = defineOperation({
	name: "chat.create_incoming_webhook",
	summary: "Create a signed incoming webhook for a room",
	description:
		"Creates a Slack-compatible incoming webhook for a room. Returns the signing_secret once. External callers POST to url_path with X-Slack-Request-Timestamp and X-Slack-Signature (v0=HMAC-SHA256). Posted messages are marked untrusted: true.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/incoming-webhooks" },
	scopes: ["chat.webhooks"],
	callers: ["human"],
	annotations: CREATE,
	input: z.strictObject({
		room_id: RoomId,
		name: z
			.string()
			.trim()
			.min(1)
			.max(CHAT_LIMITS.incomingWebhookNameChars)
			.refine(NO_CTRL, "must not contain control characters"),
	}),
	output: z.object({
		webhook: ChatIncomingWebhook,
		signing_secret: z.string(),
	}),
	errors: ["not_found", "forbidden", "invalid", "conflict"],
});

export const listIncomingWebhooks = defineOperation({
	name: "chat.list_incoming_webhooks",
	summary: "List incoming webhooks of a room",
	description: "Returns incoming webhooks configured for a room without their signing secrets.",
	http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}/incoming-webhooks" },
	scopes: ["chat.webhooks"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ room_id: RoomId }),
	output: z.object({ webhooks: z.array(ChatIncomingWebhook) }),
	errors: ["not_found"],
});

export const deleteIncomingWebhook = defineOperation({
	name: "chat.delete_incoming_webhook",
	summary: "Delete an incoming webhook",
	description: "Deletes an incoming webhook so future POST requests to its URL fail.",
	http: { method: "DELETE", path: "/api/v1/chat/incoming-webhooks/{webhook_id}" },
	scopes: ["chat.webhooks"],
	callers: ["human"],
	annotations: REMOVE,
	input: z.strictObject({ webhook_id: IncomingWebhookId }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found", "forbidden"],
});

// ---------------------------------------------------------------------------
// Slash commands that call an operation
// ---------------------------------------------------------------------------

const SlashCommandName = z
	.string()
	.trim()
	.regex(
		/^[a-z][a-z0-9_-]{0,31}$/,
		"Use 1 to 32 lowercase letters, digits, hyphens or underscores, starting with a letter.",
	);

export const ChatSlashCommand = z.object({
	id: z.string(),
	command: z.string(),
	description: z.string(),
	usage_hint: z.string(),
	operation: z.string(),
	input_template: z.record(z.string(), z.unknown()),
	created_by: z.string(),
	created_at: Timestamp,
});
export type ChatSlashCommand = z.infer<typeof ChatSlashCommand>;

export const listSlashCommands = defineOperation({
	name: "chat.list_slash_commands",
	summary: "List slash commands of the organization",
	description: "Returns all registered slash commands and the operation each command calls.",
	http: { method: "GET", path: "/api/v1/chat/commands" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({}),
	output: z.object({ commands: z.array(ChatSlashCommand) }),
	errors: [],
});

export const createSlashCommand = defineOperation({
	name: "chat.create_slash_command",
	summary: "Register a slash command that calls an operation",
	description:
		"Owners and admins only. Maps /command to an Asterra operation with an input_template supporting {{text}}, {{room_id}} and {{caller_id}}. When run, the operation executes under the caller's own scopes and permissions.",
	http: { method: "POST", path: "/api/v1/chat/commands" },
	scopes: ["chat.write"],
	callers: ["human"],
	annotations: CREATE,
	auditDenied: true,
	input: z.strictObject({
		command: SlashCommandName,
		description: z.string().trim().min(1).max(200).refine(NO_CTRL, "must not contain control characters"),
		usage_hint: z.string().trim().max(120).refine(NO_CTRL, "must not contain control characters").default(""),
		operation: z.string().regex(/^[a-z]+\.[a-z_]+$/, "must be a valid operation name"),
		input_template: z.record(z.string(), z.unknown()),
	}),
	output: z.object({ command: ChatSlashCommand }),
	errors: ["forbidden", "invalid", "conflict"],
});

export const deleteSlashCommand = defineOperation({
	name: "chat.delete_slash_command",
	summary: "Delete a slash command",
	description: "Owners and admins only. Removes a registered slash command.",
	http: { method: "DELETE", path: "/api/v1/chat/commands/{command_id}" },
	scopes: ["chat.write"],
	callers: ["human"],
	annotations: REMOVE,
	auditDenied: true,
	input: z.strictObject({ command_id: SlashCommandId }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["forbidden", "not_found"],
});

export const invokeSlashCommand = defineOperation({
	name: "chat.invoke_slash_command",
	summary: "Run a slash command in a room",
	description:
		"Runs a registered slash command in room_id. The mapped operation executes with your own credential, scopes and role.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/commands" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CREATE,
	input: z.strictObject({
		room_id: RoomId,
		command: SlashCommandName,
		text: z.string().max(CHAT_LIMITS.messageChars).default(""),
	}),
	output: z.object({
		command: z.string(),
		operation: z.string(),
		result: z.record(z.string(), z.unknown()),
	}),
	errors: ["not_found", "forbidden", "invalid", "conflict", "rate_limited"],
});

// ---------------------------------------------------------------------------
// Card actions (interactive buttons on cards)
// ---------------------------------------------------------------------------

export const triggerCardAction = defineOperation({
	name: "chat.trigger_card_action",
	summary: "Trigger a button action on a message card",
	description:
		"Records a click on an action button of a card inside message_id using the button's defined value and notifies the author (human or agent) in their Activity feed.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/actions" },
	scopes: ["chat.write"],
	callers: ["human", "agent", "service"],
	annotations: CREATE,
	input: z.strictObject({
		room_id: RoomId,
		message_id: MessageId,
		card_id: z.string().min(1).max(64),
		action_id: z.string().min(1).max(64),
		idempotency_key: z.string().min(1).max(128).optional(),
	}),
	output: z.object({ action: ChatCardAction }),
	errors: ["not_found", "invalid", "conflict"],
});

export const listCardActions = defineOperation({
	name: "chat.list_card_actions",
	summary: "List recorded button clicks on a message card",
	description:
		"Returns the button clicks recorded on the cards of message_id, newest first. Pass next_cursor as cursor for older pages. You must be a member of the room.",
	http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/actions" },
	scopes: ["chat.read"],
	callers: ["human", "agent", "service"],
	annotations: READ,
	input: z.strictObject({
		room_id: RoomId,
		message_id: MessageId,
		cursor: z.string().max(500).optional(),
		limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional(),
	}),
	output: z.object({
		actions: z.array(ChatCardAction),
		next_cursor: z.string().nullable(),
	}),
	errors: ["not_found", "invalid"],
});

export const chatExtraOperations = {
	"chat.list_activity": listActivity,
	"chat.mark_activity_read": markActivityRead,
	"chat.list_sections": listSections,
	"chat.create_section": createSection,
	"chat.update_section": updateSection,
	"chat.delete_section": deleteSection,
	"chat.set_room_section": setRoomSection,
	"chat.pin_message": pinMessage,
	"chat.unpin_message": unpinMessage,
	"chat.list_pins": listPins,
	"chat.save_message": saveMessage,
	"chat.unsave_message": unsaveMessage,
	"chat.list_saved_messages": listSavedMessages,
	"chat.schedule_message": scheduleMessage,
	"chat.list_scheduled_messages": listScheduledMessages,
	"chat.update_scheduled_message": updateScheduledMessage,
	"chat.cancel_scheduled_message": cancelScheduledMessage,
	"chat.create_reminder": createReminder,
	"chat.list_reminders": listReminders,
	"chat.complete_reminder": completeReminder,
	"chat.delete_reminder": deleteReminder,
	"chat.list_drafts": listDrafts,
	"chat.save_draft": saveDraft,
	"chat.delete_draft": deleteDraft,
	"chat.list_custom_emoji": listCustomEmoji,
	"chat.create_custom_emoji": createCustomEmoji,
	"chat.delete_custom_emoji": deleteCustomEmoji,
	"chat.forward_message": forwardMessage,
	"chat.open_group_dm": openGroupDm,
	"chat.archive_room": archiveRoom,
	"chat.unarchive_room": unarchiveRoom,
	"chat.delete_room": deleteRoom,
	"chat.set_posting_rules": setPostingRules,
	"chat.set_room_retention": setRoomRetention,
	"chat.admin_list_rooms": adminListRooms,
	"chat.admin_assign_owner": adminAssignOwner,
	"chat.admin_remove_deleted_principal": adminRemoveDeletedPrincipal,
	"chat.export_room": exportRoom,
	"chat.create_incoming_webhook": createIncomingWebhook,
	"chat.list_incoming_webhooks": listIncomingWebhooks,
	"chat.delete_incoming_webhook": deleteIncomingWebhook,
	"chat.list_slash_commands": listSlashCommands,
	"chat.create_slash_command": createSlashCommand,
	"chat.delete_slash_command": deleteSlashCommand,
	"chat.invoke_slash_command": invokeSlashCommand,
	"chat.trigger_card_action": triggerCardAction,
	"chat.list_card_actions": listCardActions,
} as const;

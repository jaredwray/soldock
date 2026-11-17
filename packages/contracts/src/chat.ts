import { prefixedId, Timestamp } from "./common.ts";
import { Actor } from "./drive.ts";
import { defineOperation } from "./operation.ts";
import { CHAT_WEBHOOK_EVENTS, ChatWebhookSubscription } from "./webhooks.ts";
import { z } from "./zod.ts";

export const CHAT_LIMITS = {
	nameChars: 80,
	topicChars: 250,
	/** The characters of the text of one message. */
	messageChars: 8000,
	/** The people and agents of one room. */
	membersPerRoom: 500,
	/** The people and agents that one call adds to a room. */
	membersPerCall: 50,
	pageSize: 100,
	queryChars: 100,
	/** The live sockets of one member in one room, with the feeds of its MCP streams. */
	socketsPerMember: 8,
	/** The new and changed messages that one member can send to one room without a wait. */
	messageBurst: 20,
	/** After that, the member can send one new or changed message to that room in each of these seconds. */
	messageRefillSeconds: 1,
	/** The different emoji of the reactions of one message. */
	reactionEmoji: 20,
} as const;

/** True for one emoji: one grapheme with a pictographic character, such as 👍, 🎉 or 👍🏽. */
function isOneEmoji(value: string): boolean {
	const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
	return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

/** One emoji, as the reactions store it. */
export const Emoji = z
	.string()
	.min(1)
	.max(32)
	.refine(isOneEmoji, { message: "Send one emoji, such as 👍." })
	.describe("One emoji character, such as 👍 or 🎉. Not a name such as :thumbsup:.");

/** The reactions of one emoji on a message. */
export const ChatReaction = z.object({
	emoji: z.string(),
	count: z.number().int(),
	/** Each principal that reacted with this emoji, oldest first. */
	principal_ids: z.array(z.string()),
});
export type ChatReaction = z.infer<typeof ChatReaction>;

/**
 * The kinds of a room. Each person and each agent can find and join a `public` room. Only its
 * members can find a `private` room. A `dm` room has two members, and it has no name.
 */
export const ROOM_KINDS = ["public", "private", "dm"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/** The owner of a room changes its name and its topic, and removes members. A `dm` room has no owner. */
export const ROOM_ROLES = ["owner", "member"] as const;
export type RoomRole = (typeof ROOM_ROLES)[number];

/** The id of a room. A `dm` room has an id that starts with `dm_`. Each other room has an id that starts with `rm_`. */
export const RoomId = z
	.string()
	.regex(/^(?:rm|dm)_[0-9A-HJKMNP-TV-Z]{26}$/, "must be the id of a room: it starts with rm_ or dm_");
const MessageId = prefixedId("cmsg");
const PrincipalId = prefixedId("prn");

/** The name of a room. It has no control characters. */
export const RoomName = z
	.string()
	.trim()
	.min(1)
	.max(CHAT_LIMITS.nameChars)
	.refine((name) => !/\p{Cc}/u.test(name), "must not contain control characters");

const RoomTopic = z
	.string()
	.trim()
	.max(CHAT_LIMITS.topicChars)
	.refine((topic) => !/\p{Cc}/u.test(topic), "must not contain control characters");

/** The text of a message. It is plain text. Line breaks stay, and a client shows the text as text. */
const MessageText = z
	.string()
	.max(CHAT_LIMITS.messageChars)
	.refine((text) => text.trim().length > 0, "must have text");

const IdempotencyKey = z
	.string()
	.min(1)
	.max(255)
	.optional()
	.describe(
		"Makes a retry safe: a second call with the same key and the same input returns the first message and posts nothing. Each member of the room sees the key on the message, so do not put private data in it. A random value is best.",
	);

export const ChatRoom = z.object({
	id: z.string(),
	kind: z.enum(ROOM_KINDS),
	/** Null for a `dm` room: show the name of `peer`. */
	name: z.string().nullable(),
	/** One line about the room. Empty when the room has no topic. */
	topic: z.string(),
	/** The other member of a `dm` room. Null for each other kind. */
	peer: Actor.nullable(),
	created_at: Timestamp,
	created_by: Actor,
	member_count: z.number().int(),
	/** Your role in the room. Null when you are not a member, which only a `public` room permits. */
	role: z.enum(ROOM_ROLES).nullable(),
	/** The seq of the newest message. 0 for a room without a message. */
	last_seq: z.number().int(),
	last_message_at: Timestamp.nullable(),
	/** The seq of the last message that you read. */
	last_read_seq: z.number().int(),
	/** True when you are a member and the room has a message of a different member after `last_read_seq`. */
	unread: z.boolean(),
	/**
	 * The messages of other members after `last_read_seq`, without deleted messages. The count stops at
	 * 100, so 100 means 100 or more. 0 when you are not a member.
	 */
	unread_count: z.number().int().nonnegative(),
	/** A number that grows with each new, changed or deleted message. Compare it to find out if you must get the changes. */
	version: z.number().int(),
});
export type ChatRoom = z.infer<typeof ChatRoom>;

export const ChatMember = z.object({
	principal_id: z.string(),
	kind: z.enum(["human", "agent"]),
	display_name: z.string(),
	role: z.enum(ROOM_ROLES),
	joined_at: Timestamp,
});
export type ChatMember = z.infer<typeof ChatMember>;

export const ChatMessage = z.object({
	id: z.string(),
	room_id: z.string(),
	/** The position of the message in the room. It starts at 1 and never changes. */
	seq: z.number().int(),
	author: Actor,
	/** Plain text. Empty for a deleted message. */
	text: z.string(),
	created_at: Timestamp,
	edited_at: Timestamp.nullable(),
	deleted: z.boolean(),
	/** The version of the room at the last change of this message. */
	version: z.number().int(),
	/**
	 * The `idempotency_key` of the call of `chat.post_message` that stored the message, or null. A
	 * client finds the message of its own send with it, also when each answer of the send got lost.
	 * A deleted message has null.
	 * Compare it with the author too: the key of a different author can have the same value. A reader
	 * that gets no value takes null, so a client reads a message of a server from before this field.
	 */
	idempotency_key: z.string().nullable().default(null),
	/**
	 * The reactions of the message, one entry for each emoji, in the order of the first reaction of
	 * each. A deleted message has none. A reader that gets no value takes an empty list.
	 */
	reactions: z.array(ChatReaction).default([]),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** The number of the room socket protocol. A change that an older client cannot read gets a new number. */
export const CHAT_SOCKET_PROTOCOL = 1;

/** The path of the socket of a room. A member opens it to get each change of the room at once. */
export function chatSocketPath(roomId: string): string {
	return `/ws/chat/rooms/${encodeURIComponent(roomId)}`;
}

/** The codes with which the server closes a room socket. Each other code is a failure: try again later. */
export const CHAT_SOCKET_CLOSE = {
	/**
	 * The server must authenticate the credential again. Open a new socket now. An OAuth client gets this
	 * code when its access token expired or when a refresh replaced the token: use the new token.
	 */
	reconnect: 4001,
	/** The member opened more sockets than `CHAT_LIMITS.socketsPerMember`. Do not open a new socket for this one. */
	replaced: 4002,
	/**
	 * The credential stopped and cannot be renewed, or its principal is not a member now. Do not open a
	 * new socket with this credential.
	 */
	ended: 4003,
} as const;

/**
 * An event of a room socket. The socket carries events from the server only: each change of a room is
 * an operation.
 *
 * - `hello` is the first event. `version` is the version of the room at that time. A client that has an
 *   older version calls chat.list_messages with changed_after.
 * - `message` has a new, changed or deleted message, as chat.list_messages returns it. Its `version` is
 *   the version of the room after the change, so a client that misses a version gets the changes.
 * - `room` tells that the name, the topic or the members changed. Call chat.get_room.
 */
export const ChatSocketEvent = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("hello"),
		protocol: z.number().int(),
		room_id: z.string(),
		version: z.number().int(),
	}),
	z.object({ type: z.literal("message"), message: ChatMessage }),
	z.object({ type: z.literal("room") }),
]);
export type ChatSocketEvent = z.infer<typeof ChatSocketEvent>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const CREATE = { readOnly: false, destructive: false, idempotent: false, openWorld: false } as const;
const CHANGE = { readOnly: false, destructive: false, idempotent: true, openWorld: false } as const;
const REMOVE = { readOnly: false, destructive: true, idempotent: true, openWorld: false } as const;

const MEMBERS_ONLY = "You must be a member of the room.";
const MENTIONS =
	"To mention a person or an agent, write @ and the local part of its address, for example @ada. When two principals have the same local part, write the full address, for example @ada@example.org. The web app shows a mention as a link to the profile.";
const RATE_LIMIT = `You can send ${CHAT_LIMITS.messageBurst} new or changed messages to one room at once, and then one in each ${CHAT_LIMITS.messageRefillSeconds === 1 ? "second" : `${CHAT_LIMITS.messageRefillSeconds} seconds`}. A call above that gets rate_limited: wait, then try again.`;

export const listRooms = defineOperation({
	name: "chat.list_rooms",
	summary: "List your rooms, or the public rooms",
	description: [
		"Returns the rooms of one view. The default view is joined: the rooms and the direct messages that you are a member of, with the newest message first.",
		"The public view has each public room of the organization, in the order of the names. A room with role: null is one that you can join with chat.join_room.",
		"Set query to get only the rooms whose name has that text. A direct message has no name, so it never matches.",
		"Each room has unread, unread_count and version. Compare version with the value that you have to find out if the messages of a room changed.",
		"Each room sends its changes to the lists after the change. A list can be a moment behind a change.",
		"Pass next_cursor as cursor to get the next page.",
	].join(" "),
	http: { method: "GET", path: "/api/v1/chat/rooms" },
	scopes: ["chat.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({
		view: z.enum(["joined", "public"]).default("joined"),
		query: z.string().trim().min(1).max(CHAT_LIMITS.queryChars).optional(),
		// A cursor of the public view holds a room name. NFC can make a name three times as long.
		cursor: z.string().max(2000).optional(),
		limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional(),
	}),
	output: z.object({
		rooms: z.array(ChatRoom),
		next_cursor: z.string().nullable(),
	}),
	errors: [],
});

export const createRoom = defineOperation({
	name: "chat.create_room",
	summary: "Create a room",
	description: [
		"Creates a room and makes you its owner. Each person and each agent of the organization can find and join a public room.",
		"Only the members can find a private room, and a member must add each new member.",
		`Set member_ids to add people and agents at once, at most ${CHAT_LIMITS.membersPerCall}.`,
		"Two rooms can have the same name. For a conversation with one person or one agent, use chat.open_dm.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/chat/rooms" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CREATE,
	input: z.strictObject({
		kind: z.enum(["public", "private"]),
		name: RoomName,
		topic: RoomTopic.optional(),
		member_ids: z.array(PrincipalId).max(CHAT_LIMITS.membersPerCall).optional(),
	}),
	output: z.object({ room: ChatRoom }),
	errors: ["not_found"],
});

export const openDm = defineOperation({
	name: "chat.open_dm",
	summary: "Open the direct message room with one person or one agent",
	description:
		"Returns the room for direct messages between you and principal_id, and creates it when it does not exist. You and that principal have one such room, so a second call returns the same room. Then post with chat.post_message.",
	http: { method: "POST", path: "/api/v1/chat/dms" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ principal_id: PrincipalId }),
	output: z.object({ room: ChatRoom }),
	errors: ["not_found"],
});

export const getRoom = defineOperation({
	name: "chat.get_room",
	summary: "Get one room and its members",
	description:
		"Returns the room and each member with their role. You can get a public room without being a member. A private room and a direct message exist for their members only.",
	http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}" },
	scopes: ["chat.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ room_id: RoomId }),
	output: z.object({ room: ChatRoom, members: z.array(ChatMember) }),
	errors: ["not_found"],
});

export const updateRoom = defineOperation({
	name: "chat.update_room",
	summary: "Change the name or the topic of a room",
	description:
		"Sets a new name, a new topic, or the two. An empty topic removes the topic. Only the owner of the room can do this. A direct message has no name and no topic.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/update" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z
		.strictObject({ room_id: RoomId, name: RoomName.optional(), topic: RoomTopic.optional() })
		.refine((input) => input.name !== undefined || input.topic !== undefined, "set name, topic, or the two"),
	output: z.object({ room: ChatRoom }),
	errors: ["not_found", "invalid"],
});

export const joinRoom = defineOperation({
	name: "chat.join_room",
	summary: "Join a public room",
	description:
		"Makes you a member of a public room. You can then read its messages, also the messages from before, and post. A private room refuses: a member must add you with chat.add_members. A second call changes nothing.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/join" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId }),
	output: z.object({ room: ChatRoom }),
	errors: ["not_found", "conflict"],
});

export const addMembers = defineOperation({
	name: "chat.add_members",
	summary: "Add people and agents to a room",
	description: `Makes each principal a member of the room. Each member of a room can add members. A principal that is a member already is skipped. A room has at most ${CHAT_LIMITS.membersPerRoom} members. A direct message keeps its two members. ${MEMBERS_ONLY}`,
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/members" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({
		room_id: RoomId,
		principal_ids: z.array(PrincipalId).min(1).max(CHAT_LIMITS.membersPerCall),
	}),
	output: z.object({
		/** The principals that the call made members. A principal that was a member already does not count. */
		members_added: z.number().int(),
		room: ChatRoom,
	}),
	errors: ["not_found", "invalid", "conflict"],
});

export const removeMember = defineOperation({
	name: "chat.remove_member",
	summary: "Leave a room, or remove a member from a room",
	description: [
		"With your own id as principal_id, you leave the room. When the owner leaves, the member that joined first becomes the owner.",
		"The last member of a private room cannot leave. Only the owner of a room can remove a different member.",
		"A direct message keeps its two members.",
	].join(" "),
	http: { method: "DELETE", path: "/api/v1/chat/rooms/{room_id}/members/{principal_id}" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: REMOVE,
	input: z.strictObject({ room_id: RoomId, principal_id: PrincipalId }),
	output: z.object({ removed: z.boolean() }),
	errors: ["not_found", "invalid", "conflict"],
});

export const listMessages = defineOperation({
	name: "chat.list_messages",
	summary: "Read the messages of a room, or get what changed",
	description: [
		"Without before, after and changed_after, returns the newest messages of the room, oldest first. has_more is true when older messages exist: pass the seq of the first message as before to get them.",
		"With after, returns the first messages after that seq, oldest first. has_more is true when newer messages exist: pass the seq of the last message as after to get them.",
		"With changed_after, returns each message that is new, changed or deleted after that version of the room, in the order of the changes. Use the version of the result as the next changed_after.",
		"When has_more is true, call again with the version of the last message as changed_after.",
		"A deleted message has deleted: true and no text.",
		MEMBERS_ONLY,
	].join(" "),
	http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}/messages" },
	scopes: ["chat.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z
		.strictObject({
			room_id: RoomId,
			before: z.coerce.number().int().min(1).optional(),
			after: z.coerce.number().int().min(0).optional(),
			changed_after: z.coerce.number().int().min(0).optional(),
			limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional(),
		})
		.refine(
			(input) => [input.before, input.after, input.changed_after].filter((value) => value !== undefined).length <= 1,
			"set only one of before, after and changed_after",
		),
	output: z.object({
		messages: z.array(ChatMessage),
		/** The version of the room at the time of the read. */
		version: z.number().int(),
		has_more: z.boolean(),
	}),
	errors: ["not_found"],
});

export const postMessage = defineOperation({
	name: "chat.post_message",
	summary: "Post a message in a room",
	description: `Adds a message with plain text to the room, at most ${CHAT_LIMITS.messageChars} characters. The room is then read for you, and unread for each other member. ${MENTIONS} ${MEMBERS_ONLY} ${RATE_LIMIT}`,
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CREATE,
	input: z.strictObject({ room_id: RoomId, text: MessageText, idempotency_key: IdempotencyKey }),
	output: z.object({ message: ChatMessage }),
	errors: ["not_found", "conflict", "rate_limited"],
});

export const editMessage = defineOperation({
	name: "chat.edit_message",
	summary: "Change the text of your message",
	description: `Replaces the text of a message that you wrote. The message keeps its place, and edited_at shows the time of the change. A deleted message cannot change. ${RATE_LIMIT}`,
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/edit" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId, text: MessageText }),
	output: z.object({ message: ChatMessage }),
	errors: ["not_found", "invalid", "rate_limited"],
});

export const deleteMessage = defineOperation({
	name: "chat.delete_message",
	summary: "Delete a message",
	description:
		"Deletes the text of a message. This cannot be undone. The message keeps its place, with deleted: true. You can delete a message that you wrote. The owner of a room can delete each message of the room.",
	http: { method: "DELETE", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: REMOVE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId }),
	output: z.object({
		/** False when the message was deleted already. */
		deleted: z.boolean(),
	}),
	errors: ["not_found"],
});

export const addReaction = defineOperation({
	name: "chat.add_reaction",
	summary: "React to a message",
	description: `Adds your reaction with one emoji to a message. A second call with the same emoji changes nothing. A message can have reactions with ${CHAT_LIMITS.reactionEmoji} different emoji at most. A deleted message takes no reaction. ${MEMBERS_ONLY} ${RATE_LIMIT}`,
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/reactions" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId, emoji: Emoji }),
	output: z.object({ message: ChatMessage }),
	errors: ["not_found", "invalid", "conflict", "rate_limited"],
});

export const removeReaction = defineOperation({
	name: "chat.remove_reaction",
	summary: "Remove your reaction from a message",
	description: `Removes your reaction with one emoji from a message. A call for a reaction that you do not have changes nothing. ${MEMBERS_ONLY}`,
	http: { method: "DELETE", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/reactions" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId, emoji: Emoji }),
	output: z.object({ message: ChatMessage }),
	errors: ["not_found", "rate_limited"],
});

export const markRead = defineOperation({
	name: "chat.mark_read",
	summary: "Set what you read in a room",
	description:
		"Sets your read marker to the message seq. Without seq, the marker goes to the newest message, so the room is read. A lower seq makes the room unread again from the message after it. Only you see your marker. chat.get_room has the new marker at once. chat.list_rooms has it on each of your devices when the call returns, or a moment later when the update of your list fails.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/read" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, seq: z.number().int().min(0).optional() }),
	output: z.object({ last_read_seq: z.number().int(), unread: z.boolean() }),
	errors: ["not_found"],
});

/** The event type for a new chat message. Edits and deletes have their own event types. */
export const CHAT_WEBHOOK_EVENT_TYPE = CHAT_WEBHOOK_EVENTS[0];

const createChatWebhookSubscription = defineOperation({
	name: "chat.create_webhook_subscription",
	summary: "Send chat events to an endpoint",
	description: [
		"Adds a subscription for your chats, or the chats of an agent that you sponsor.",
		"Choose a new message, a changed message, or a deleted message.",
		"The POST has no message text. Read the room with your own credential.",
		"A message that arrived before this subscription sends no POST.",
		"The endpoint must be yours and active.",
	].join(" "),
	http: { method: "POST", path: "/api/v1/chat/webhook-subscriptions" },
	scopes: ["chat.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
	input: z.strictObject({
		endpoint_id: prefixedId("whe"),
		event: z.enum(CHAT_WEBHOOK_EVENTS),
		principal_id: prefixedId("prn").optional(),
	}),
	output: z.object({ subscription: ChatWebhookSubscription }),
	errors: ["not_found", "policy_denied", "conflict", "forbidden"],
});

const listChatWebhookSubscriptions = defineOperation({
	name: "chat.list_webhook_subscriptions",
	summary: "List chat webhook subscriptions",
	description:
		"Lists your chat subscriptions. With principal_id, a sponsor, an owner or an admin can list the subscriptions of that agent.",
	http: { method: "GET", path: "/api/v1/chat/webhook-subscriptions" },
	scopes: ["chat.webhooks"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({ principal_id: prefixedId("prn").optional() }),
	output: z.object({ subscriptions: z.array(ChatWebhookSubscription) }),
	errors: ["not_found"],
});

const deleteChatWebhookSubscription = defineOperation({
	name: "chat.delete_webhook_subscription",
	summary: "Delete a chat webhook subscription",
	description:
		"Deletes a subscription. The endpoint stays. Its creator, or a sponsor, an owner or an admin of its agent, can delete it.",
	http: { method: "DELETE", path: "/api/v1/chat/webhook-subscriptions/{subscription_id}" },
	scopes: ["chat.webhooks"],
	callers: ["human", "agent"],
	annotations: { readOnly: false, destructive: true, idempotent: true, openWorld: false },
	input: z.strictObject({ subscription_id: prefixedId("whk") }),
	output: z.object({ deleted: z.boolean() }),
	errors: ["not_found"],
});

export const chatOperations = {
	"chat.create_webhook_subscription": createChatWebhookSubscription,
	"chat.list_webhook_subscriptions": listChatWebhookSubscriptions,
	"chat.delete_webhook_subscription": deleteChatWebhookSubscription,
	"chat.list_rooms": listRooms,
	"chat.create_room": createRoom,
	"chat.open_dm": openDm,
	"chat.get_room": getRoom,
	"chat.update_room": updateRoom,
	"chat.join_room": joinRoom,
	"chat.add_members": addMembers,
	"chat.remove_member": removeMember,
	"chat.list_messages": listMessages,
	"chat.post_message": postMessage,
	"chat.edit_message": editMessage,
	"chat.delete_message": deleteMessage,
	"chat.add_reaction": addReaction,
	"chat.remove_reaction": removeReaction,
	"chat.mark_read": markRead,
} as const;

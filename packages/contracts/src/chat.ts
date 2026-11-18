import { prefixedId, Timestamp } from "./common.ts";
import { Href } from "./docs.ts";
import { Actor } from "./drive.ts";
import { GROUP_MENTIONS } from "./mentions.ts";
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
	/**
	 * The characters of the Markdown of one message: the input, and the Markdown of each stored body, so an edit
	 * can send it back. The plain text of the message has the limit of `messageChars`.
	 */
	markdownChars: 16_000,
	/** The JSON of the body of one message, in bytes of UTF-8. */
	bodyBytes: 64 * 1024,
	/** Blocks in blocks in the body of one message: a list in a quote, and so on. A list and its items are one level. */
	bodyDepth: 6,
	/** The mention nodes of the body of one message. */
	mentions: 50,
	/**
	 * The members of a room in which each member can mention a group ("@here", "@channel"). In a room
	 * with more members, only an owner of the room can.
	 */
	groupMentionMembers: 50,
	/** The earlier versions of one message that the room keeps. An edit after that removes the oldest one. */
	messageEdits: 100,
	/** The blocks of the body of one message, with each list item. */
	bodyBlocks: 1000,
} as const;

// The body of a message: a small tree of blocks in the JSON form of ProseMirror, the same form as the
// content of a doc. It is data, never HTML. The schema is the allowlist: a node, a mark or a link
// scheme that it does not have gets `invalid`.

const BodyMark = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("strong") }),
	z.strictObject({ type: z.literal("em") }),
	z.strictObject({ type: z.literal("strike") }),
	z.strictObject({ type: z.literal("code") }),
	z.strictObject({ type: z.literal("link"), attrs: z.strictObject({ href: Href }) }),
]);

const BodyText = z.strictObject({
	type: z.literal("text"),
	// A line break is a hard_break node, never a new line in a text.
	text: z
		.string()
		.min(1)
		.max(CHAT_LIMITS.messageChars)
		.refine((text) => !/[\r\n]/.test(text), "a text has no new line: use hard_break"),
	// Each type of mark one time: two links on one text would show one and report the other.
	marks: z
		.array(BodyMark)
		.max(5)
		.refine((marks) => new Set(marks.map((mark) => mark.type)).size === marks.length, "each mark one time")
		.optional(),
});

/**
 * A mention of a principal. `label` is the text after the "@" that shows: the handle, or the name
 * alias, of the time of the write. The server checks `id`, and sets `label` when it no longer finds
 * that principal.
 */
const BodyMention = z.strictObject({
	type: z.literal("mention"),
	attrs: z.strictObject({
		id: prefixedId("prn"),
		label: z
			.string()
			.min(1)
			.max(254)
			.regex(/^[a-z0-9._+-]+(?:@[a-z0-9.-]+)?$/i, "must be a handle: the label has no @ at its start"),
	}),
});

/**
 * A mention of a group: "@here" or "@channel". It mentions each member of the room, except the author.
 * Until presence (layer 7 of Chat), "@here" mentions each member too.
 */
const BodyGroupMention = z.strictObject({
	type: z.literal("group_mention"),
	attrs: z.strictObject({ group: z.enum(GROUP_MENTIONS) }),
});

const BodyInline = z.discriminatedUnion("type", [
	BodyText,
	z.strictObject({ type: z.literal("hard_break") }),
	BodyMention,
	BodyGroupMention,
]);

const BodyParagraph = z.strictObject({ type: z.literal("paragraph"), content: z.array(BodyInline).optional() });

const BodyCodeBlock = z.strictObject({
	type: z.literal("code_block"),
	content: z
		.array(z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(CHAT_LIMITS.messageChars) }))
		.optional(),
});

const BodyBlockquote = z.strictObject({
	type: z.literal("blockquote"),
	get content() {
		return z.array(BodyBlock).min(1);
	},
});

const BodyListItem = z.strictObject({
	type: z.literal("list_item"),
	get content() {
		return z.array(BodyBlock).min(1);
	},
});

const BodyBulletList = z.strictObject({ type: z.literal("bullet_list"), content: z.array(BodyListItem).min(1) });

const BodyOrderedList = z.strictObject({
	type: z.literal("ordered_list"),
	attrs: z.strictObject({ order: z.number().int().min(0).max(99_999) }).optional(),
	content: z.array(BodyListItem).min(1),
});

const BodyBlock = z.union([BodyParagraph, BodyCodeBlock, BodyBlockquote, BodyBulletList, BodyOrderedList]);

/**
 * The body of a message: a tree of blocks in the JSON form of ProseMirror. Blocks: paragraph,
 * code_block, blockquote, bullet_list, ordered_list and list_item. Inline: text, hard_break, mention and
 * group_mention.
 * Marks on text: strong, em, strike, code and link (http, https or mailto). An emoji is text.
 */
export const ChatBody = z.strictObject({
	type: z.literal("doc"),
	content: z.array(BodyBlock).min(1),
});
export type ChatBody = z.infer<typeof ChatBody>;
export type ChatBodyBlock = z.infer<typeof BodyBlock>;
export type ChatBodyInline = z.infer<typeof BodyInline>;

/**
 * One emoji of the Unicode list of emoji for general use (RGI), in its full form: 👍, 👍🏽, ❤️, 1️⃣, 🇳🇴
 * or 👨‍👩‍👧. Each emoji has one form only, so two values never show the same emoji. A form without
 * U+FE0F (❤), a text symbol (©), a lone flag letter, an extra joiner and marks after the emoji fail.
 */
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

/** One emoji, as the reactions store it. */
export const Emoji = z
	.string()
	.min(1)
	.max(32)
	.refine((value) => RGI_EMOJI.test(value), {
		message: "Send one emoji in its full form, such as 👍 or ❤️ (with U+FE0F).",
	})
	.describe(
		"One emoji in its full form, such as 👍, 🎉 or ❤️ (with U+FE0F). Not a name such as :thumbsup:, and not text.",
	);

/** The reactions of one emoji on a message. */
export const ChatReaction = z.object({
	emoji: z.string(),
	count: z.number().int(),
	/** Each principal that reacted with this emoji, oldest first. */
	principal_ids: z.array(z.string()),
});
export type ChatReaction = z.infer<typeof ChatReaction>;

/** The replies of a message: a thread. The parent keeps this summary, so a list shows it without a read. */
export const ChatThread = z.object({
	/** The replies that stay, without deleted replies. */
	reply_count: z.number().int().nonnegative(),
	/** The time of the newest reply that stays. */
	last_reply_at: Timestamp,
	/** The authors of the newest replies, newest first, each one time, at most 3. */
	authors: z.array(Actor),
});
export type ChatThread = z.infer<typeof ChatThread>;

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

const MessageMarkdown = z
	.string()
	.max(CHAT_LIMITS.markdownChars)
	.refine((text) => text.trim().length > 0, "must have text");

/** The three forms of the content of a new or a changed message. A call sends one of them. */
const MESSAGE_FORMS = {
	text: MessageText.optional().describe("Plain text. The message shows it as it is: no format."),
	markdown: MessageMarkdown.optional().describe(
		"Markdown: **bold**, *italic*, ~~strikethrough~~, `code`, [links](https://example.com), lists, > quotes and code fences.",
	),
	body: ChatBody.optional().describe("The body as a ProseMirror JSON tree. See ChatBody."),
};

const ONE_FORM = "set one of text, markdown and body";

function oneForm(input: { text?: unknown; markdown?: unknown; body?: unknown }): boolean {
	return [input.text, input.markdown, input.body].filter((value) => value !== undefined).length === 1;
}

const FORMS_NOTE = `Send the content as markdown (formatted text), as text (plain text that shows as it is) or as body (a JSON tree), one of the three. The plain text of the message has at most ${CHAT_LIMITS.messageChars} characters.`;

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
	/**
	 * The messages after `last_read_seq` that mention you or a group ("@here", "@channel"), without
	 * deleted messages and your own messages. The count stops at 100. 0 when you are not a member.
	 */
	mention_count: z.number().int().nonnegative(),
	/** A number that grows with each new, changed or deleted message. Compare it to find out if you must get the changes. */
	version: z.number().int(),
	/**
	 * True when you put your star on the room (chat.star_room). Only you see your star. False when you
	 * are not a member. A reader that gets no value takes false, so a client reads a room of a server
	 * from before this field.
	 */
	starred: z.boolean().default(false),
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
	/** The plain text of the body, for search and for notifications. Empty for a deleted message. */
	text: z.string(),
	/**
	 * The body: formatted text. Show it, not `text`. A message from before the bodies has a body of
	 * its text. A reader that gets no value shows `text`.
	 */
	body: ChatBody.optional(),
	/** The body as Markdown, for agents and for an edit. A reader that gets no value uses `text`. */
	markdown: z.string().optional(),
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
	 * The reactions of the message, one entry for each emoji, in the order of the oldest reaction of
	 * each emoji that stays. So an entry can move when a reaction goes away. A deleted message has
	 * none. A reader that gets no value takes an empty list.
	 */
	reactions: z.array(ChatReaction).default([]),
	/**
	 * The ids of the principals that the body mentions, each one time, in the order of the body. A
	 * deleted message has none. A reader that gets no value takes an empty list.
	 */
	mentions: z.array(z.string()).default([]),
	/**
	 * The groups that the body mentions ("here", "channel"), each one time, in the order of the body. A
	 * group mentions each member of the room, except the author. A deleted message has none. A reader
	 * that gets no value takes an empty list.
	 */
	group_mentions: z.array(z.enum(GROUP_MENTIONS)).default([]),
	/**
	 * The id of the message that this message replies to, or null for a message of the room. A thread has
	 * one level: a reply has no replies. A reader that gets no value takes null.
	 */
	parent_id: z.string().nullable().default(null),
	/**
	 * True for a reply that the author also sent to the room: the room list shows it too. A reader that
	 * gets no value takes false.
	 */
	also_in_room: z.boolean().default(false),
	/** The summary of the replies of this message, or null when it has none. A reader that gets no value takes null. */
	thread: ChatThread.nullable().default(null),
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
 * - `reply` has a new, changed or deleted reply that is not in the room list, as chat.list_replies
 *   returns it. Its `version` is a version of the room too. A client without threads ignores it, and
 *   its sync gets the changes of the room list.
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
	z.object({ type: z.literal("reply"), message: ChatMessage }),
	z.object({ type: z.literal("room") }),
]);
export type ChatSocketEvent = z.infer<typeof ChatSocketEvent>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const CREATE = { readOnly: false, destructive: false, idempotent: false, openWorld: false } as const;
const CHANGE = { readOnly: false, destructive: false, idempotent: true, openWorld: false } as const;
const REMOVE = { readOnly: false, destructive: true, idempotent: true, openWorld: false } as const;

const MEMBERS_ONLY = "You must be a member of the room.";
const MENTIONS = `To mention a person or an agent, write @ and the local part of its address in text or markdown, for example @ada. When two principals have the same local part, write the full address, for example @ada@example.org. The server stores each mention as a mention node with the id of the principal, and the message lists the ids in mentions. In a private room, a mention of a principal that is not a member stays text. In a body, write a mention node: { type: mention, attrs: { id, label } }. @here and @channel mention each member of the room, except you: the message lists them in group_mentions. In a room with more than ${CHAT_LIMITS.groupMentionMembers} members, only an owner of the room can mention a group: a different member gets forbidden. In a body, write { type: group_mention, attrs: { group } }.`;
const RATE_LIMIT = `You can send ${CHAT_LIMITS.messageBurst} new or changed messages to one room at once, and then one in each ${CHAT_LIMITS.messageRefillSeconds === 1 ? "second" : `${CHAT_LIMITS.messageRefillSeconds} seconds`}. A call above that gets rate_limited: wait, then try again.`;

export const listRooms = defineOperation({
	name: "chat.list_rooms",
	summary: "List your rooms, or the public rooms",
	description: [
		"Returns the rooms of one view. The default view is joined: the rooms and the direct messages that you are a member of, with the newest message first.",
		"The public view has each public room of the organization, in the order of the names. A room with role: null is one that you can join with chat.join_room.",
		"The starred view has the rooms and the direct messages of the joined view that have your star (chat.star_room), with the newest message first.",
		"Set query to get only the rooms whose name has that text. A direct message has no name, so it never matches.",
		"Each room has unread, unread_count, mention_count, starred and version. Compare version with the value that you have to find out if the messages of a room changed.",
		"Each room sends its changes to the lists after the change. A list can be a moment behind a change.",
		"Pass next_cursor as cursor to get the next page.",
	].join(" "),
	http: { method: "GET", path: "/api/v1/chat/rooms" },
	scopes: ["chat.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z.strictObject({
		view: z.enum(["joined", "public", "starred"]).default("joined"),
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
		"A reply is not in this list, unless its author also sent it to the room (also_in_room). A message with replies has thread: read the replies with chat.list_replies.",
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

const THREADS = `To reply in a thread, set parent_id to the id of a message of the room. A thread has one level: a reply cannot have replies, and a deleted message takes no reply. A reply is not in the room list and does not make the room unread. Set also_in_room: true to show the reply in the room list too.`;

export const postMessage = defineOperation({
	name: "chat.post_message",
	summary: "Post a message in a room, or a reply in a thread",
	description: `Adds a message to the room. ${FORMS_NOTE} The room is then read for you, and unread for each other member. ${THREADS} ${MENTIONS} ${MEMBERS_ONLY} ${RATE_LIMIT}`,
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CREATE,
	input: z
		.strictObject({
			room_id: RoomId,
			...MESSAGE_FORMS,
			idempotency_key: IdempotencyKey,
			parent_id: MessageId.optional(),
			also_in_room: z.boolean().optional(),
		})
		.refine(oneForm, ONE_FORM)
		.refine((input) => input.also_in_room !== true || input.parent_id !== undefined, {
			message: "also_in_room needs parent_id: only a reply can also go to the room",
		}),
	output: z.object({ message: ChatMessage }),
	errors: ["not_found", "invalid", "conflict", "rate_limited"],
});

export const listReplies = defineOperation({
	name: "chat.list_replies",
	summary: "Read the replies of a message, or get what changed",
	description: [
		"Returns the message (parent) and its replies, oldest first.",
		"Without after and changed_after, returns the first replies. has_more is true when more replies exist: pass the seq of the last reply as after to get them.",
		"With changed_after, returns each reply that is new, changed or deleted after that version of the room, in the order of the changes. Use the version of the result as the next changed_after.",
		"When has_more is true with changed_after, call again with the version of the last reply as changed_after.",
		"The replies of a deleted message stay, and this operation returns them.",
		MEMBERS_ONLY,
	].join(" "),
	http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/replies" },
	scopes: ["chat.read"],
	callers: ["human", "agent"],
	annotations: READ,
	input: z
		.strictObject({
			room_id: RoomId,
			message_id: MessageId,
			after: z.coerce.number().int().min(0).optional(),
			changed_after: z.coerce.number().int().min(0).optional(),
			limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional(),
		})
		.refine((input) => input.after === undefined || input.changed_after === undefined, {
			message: "set only one of after and changed_after",
		}),
	output: z.object({
		parent: ChatMessage,
		replies: z.array(ChatMessage),
		/** The version of the room at the time of the read. */
		version: z.number().int(),
		has_more: z.boolean(),
	}),
	errors: ["not_found", "invalid"],
});

export const editMessage = defineOperation({
	name: "chat.edit_message",
	summary: "Change the text of your message",
	description: `Replaces the content of a message that you wrote. ${FORMS_NOTE} The message keeps its place, and edited_at shows the time of the change. A deleted message cannot change. An edit keeps the mentions of a group (@here, @channel) that the message has. A new mention of a group follows the rule of chat.post_message. ${RATE_LIMIT}`,
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/edit" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId, ...MESSAGE_FORMS }).refine(oneForm, ONE_FORM),
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

/** An earlier version of a message: its content before an edit. */
export const ChatMessageEdit = z.object({
	/**
	 * The version of the message before the edit that replaced this content. A reaction changes it too,
	 * so use it only for the order of the versions.
	 */
	version: z.number().int(),
	/** The plain text of this content. */
	text: z.string(),
	body: ChatBody,
	/** The body as Markdown. */
	markdown: z.string(),
	/** The time of the post or the edit that wrote this content. */
	written_at: Timestamp,
	/** The time of the edit that replaced this content. */
	replaced_at: Timestamp,
});
export type ChatMessageEdit = z.infer<typeof ChatMessageEdit>;

export const listMessageEdits = defineOperation({
	name: "chat.list_message_edits",
	summary: "Read the earlier versions of a message",
	description: [
		"Owners and admins of the organization only, in a room that they can read. Returns the content of a message before each of its edits, oldest first. A key or a token of an owner or an admin with chat.read can call it.",
		`The room keeps the ${CHAT_LIMITS.messageEdits} newest earlier versions of a message. A delete of the message removes its earlier versions too.`,
	].join(" "),
	http: { method: "GET", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/edits" },
	scopes: ["chat.read"],
	callers: ["human"],
	annotations: READ,
	// The earlier words of a different person: each refused read gets an audit line too.
	auditDenied: true,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId }),
	output: z.object({ edits: z.array(ChatMessageEdit) }),
	errors: ["not_found", "forbidden"],
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
	description: `Removes your reaction with one emoji from a message. A call for a reaction that you do not have changes nothing. ${MEMBERS_ONLY} ${RATE_LIMIT}`,
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

export const starRoom = defineOperation({
	name: "chat.star_room",
	summary: "Add or remove your star on a room",
	description: [
		"With starred: true, puts your star on a room or a direct message. With starred: false, removes it.",
		"A star is yours only: nobody else sees it. The web app shows the rooms with your star at the top of the sidebar.",
		"chat.list_rooms with view: starred returns them. A second call with the same value changes nothing.",
		"When you leave a room, its star goes away.",
		MEMBERS_ONLY,
	].join(" "),
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/star" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, starred: z.boolean() }),
	output: z.object({ room: ChatRoom }),
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
	"chat.list_replies": listReplies,
	"chat.edit_message": editMessage,
	"chat.delete_message": deleteMessage,
	"chat.list_message_edits": listMessageEdits,
	"chat.add_reaction": addReaction,
	"chat.remove_reaction": removeReaction,
	"chat.mark_read": markRead,
	"chat.star_room": starRoom,
} as const;

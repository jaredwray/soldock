import { prefixedId, Timestamp } from "./common.ts";
import { Actor } from "./drive.ts";
import { defineOperation } from "./operation.ts";
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
} as const;

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
		"Makes a retry safe: a second call with the same key and the same input returns the first message and posts nothing.",
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
	/** True when you are a member and the room has a message after `last_read_seq`. */
	unread: z.boolean(),
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
});
export type ChatMessage = z.infer<typeof ChatMessage>;

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const CREATE = { readOnly: false, destructive: false, idempotent: false, openWorld: false } as const;
const CHANGE = { readOnly: false, destructive: false, idempotent: true, openWorld: false } as const;
const REMOVE = { readOnly: false, destructive: true, idempotent: true, openWorld: false } as const;

const MEMBERS_ONLY = "You must be a member of the room.";

export const listRooms = defineOperation({
	name: "chat.list_rooms",
	summary: "List your rooms, or the public rooms",
	description: [
		"Returns the rooms of one view. The default view is joined: the rooms and the direct messages that you are a member of, with the newest message first.",
		"The public view has each public room of the organization, in the order of the names. A room with role: null is one that you can join with chat.join_room.",
		"Set query to get only the rooms whose name has that text. A direct message has no name, so it never matches.",
		"Each room has unread and version. Compare version with the value that you have to find out if the messages of a room changed.",
		"The list comes from an index that follows each room. It can be a moment behind a change.",
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
		"Without before and changed_after, returns the newest messages of the room, oldest first. has_more is true when older messages exist: pass the seq of the first message as before to get them.",
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
			changed_after: z.coerce.number().int().min(0).optional(),
			limit: z.coerce.number().int().min(1).max(CHAT_LIMITS.pageSize).optional(),
		})
		.refine(
			(input) => input.before === undefined || input.changed_after === undefined,
			"set before or changed_after, not the two",
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
	description: `Adds a message with plain text to the room, at most ${CHAT_LIMITS.messageChars} characters. The room is then read for you, and unread for each other member. ${MEMBERS_ONLY}`,
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CREATE,
	input: z.strictObject({ room_id: RoomId, text: MessageText, idempotency_key: IdempotencyKey }),
	output: z.object({ message: ChatMessage }),
	errors: ["not_found", "conflict"],
});

export const editMessage = defineOperation({
	name: "chat.edit_message",
	summary: "Change the text of your message",
	description:
		"Replaces the text of a message that you wrote. The message keeps its place, and edited_at shows the time of the change. A deleted message cannot change.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/messages/{message_id}/edit" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, message_id: MessageId, text: MessageText }),
	output: z.object({ message: ChatMessage }),
	errors: ["not_found", "invalid"],
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

export const markRead = defineOperation({
	name: "chat.mark_read",
	summary: "Set what you read in a room",
	description:
		"Sets your read marker to the message seq. Without seq, the marker goes to the newest message, so the room is read. A lower seq makes the room unread again from the message after it. Only you see your marker. chat.get_room has the new marker at once, and chat.list_rooms a few seconds later.",
	http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/read" },
	scopes: ["chat.write"],
	callers: ["human", "agent"],
	annotations: CHANGE,
	input: z.strictObject({ room_id: RoomId, seq: z.number().int().min(0).optional() }),
	output: z.object({ last_read_seq: z.number().int(), unread: z.boolean() }),
	errors: ["not_found"],
});

export const chatOperations = {
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
	"chat.mark_read": markRead,
} as const;

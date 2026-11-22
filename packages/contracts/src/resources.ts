import { CHAT_LIMITS } from "./chat.ts";
import type { InputOf, OperationName, OutputOf } from "./registry.ts";
import type { ResourceKind } from "./restrictions.ts";

/**
 * One kind of MCP resource. An operation reads it and an operation lists it, so a resource never
 * gives data that the REST API does not give. The MCP adapter makes `resources/templates/list`,
 * `resources/list`, `resources/read` and the `subscriptions/listen` filter from these definitions.
 */
export interface ResourceDefinition<R extends OperationName = OperationName, L extends OperationName = OperationName> {
	/** `<domain>.<noun>`. A domain module gives the change feed of the resource under this name. */
	name: string;
	title: string;
	/** For the model: what the resource holds, and when it changes. */
	description: string;
	/**
	 * An RFC 6570 template of level 1. Each `{name}` variable is a whole path segment, and each
	 * variable is an input field of the read operation.
	 */
	uriTemplate: string;
	mimeType: "application/json";
	/** The operation that reads one resource, and its input from the variables of the URI. */
	read: { operation: R; input: (vars: Readonly<Record<string, string>>) => InputOf<R> };
	/** The operation that finds the resources that the caller can read, and the variables and title of each one. */
	list: {
		operation: L;
		input: InputOf<L>;
		items: (output: OutputOf<L>) => { vars: Record<string, string>; title: string }[];
	};
	/** When the server sends `notifications/resources/updated` for a resource of this kind. MCP adds it to the description. */
	updates: string;
	/**
	 * How a token with resource limits treats this kind: the URI variable that names the listed resource, or
	 * `refuse` for a kind that reads across rooms. Each kind must say it, so a new kind cannot bypass a limit.
	 */
	restricted: { var: string; resource: ResourceKind } | "refuse";
}

export function defineResource<R extends OperationName, L extends OperationName>(
	resource: ResourceDefinition<R, L>,
): ResourceDefinition<R, L> {
	return resource;
}

/** The inbox of one mailbox: the own mailbox of the caller or a team mailbox that the caller is a member of. */
export const mailInbox = defineResource({
	name: "mail.inbox",
	title: "Inbox",
	description:
		"The newest threads in the inbox of a mailbox, as mail.list_threads returns them for the query in:inbox. Subscribe to it with subscriptions/listen to get a notification when new mail arrives. A client that cannot keep a stream open can use a webhook subscription for mail.inbox.updated instead.",
	uriTemplate: "asterra://mail/{mailbox_id}/inbox",
	restricted: { var: "mailbox_id", resource: "mailbox" },
	mimeType: "application/json",
	read: { operation: "mail.list_threads", input: (vars) => ({ mailbox_id: vars.mailbox_id, query: "in:inbox" }) },
	list: {
		operation: "mail.list_mailboxes",
		input: {},
		items: (output) =>
			output.mailboxes.map((mailbox) => ({
				vars: { mailbox_id: mailbox.id },
				title: `Inbox of ${mailbox.display_name} <${mailbox.address}>`,
			})),
	},
	updates:
		"Only a new message in the inbox sends notifications/resources/updated. Other changes, such as a read, a label or an archive, send no notification.",
});

/** The messages of one room or direct message that the caller is a member of. */
export const chatRoom = defineResource({
	name: "chat.room",
	title: "Room messages",
	description:
		"The newest messages of a room or a direct message that you are a member of, as chat.list_messages returns them. Subscribe to it with subscriptions/listen to get a notification when a message is new, changed or deleted. Then call chat.list_messages with changed_after and the version that you have. A reply in a thread is not in this list: read it with chat.list_replies.",
	uriTemplate: "asterra://chat/{room_id}/messages",
	restricted: { var: "room_id", resource: "room" },
	mimeType: "application/json",
	read: { operation: "chat.list_messages", input: (vars) => ({ room_id: vars.room_id as string }) },
	list: {
		operation: "chat.list_rooms",
		input: { view: "joined", limit: CHAT_LIMITS.pageSize },
		items: (output) =>
			output.rooms.map((room) => ({
				vars: { room_id: room.id },
				title:
					room.kind === "dm"
						? `Direct message with ${room.peer?.display_name ?? "a member"}`
						: room.kind === "group_dm"
							? `Group direct message with ${room.peers.map((p) => p.display_name).join(", ") || "members"}`
							: `Messages of #${room.name ?? "room"}`,
			})),
	},
	updates:
		"A new, changed or deleted message sends notifications/resources/updated, also a reply in a thread. A change that you made sends no notification. A read marker sends no notification. A change of the name, the topic or the members sends no notification.",
});

/**
 * The rooms and the direct messages of the caller, with the unread count of each. One subscription
 * follows each room of the caller, also a room that the caller joins later.
 */
export const chatRooms = defineResource({
	name: "chat.rooms",
	title: "Your rooms",
	description:
		"Your rooms and direct messages, newest message first, with the unread count and the mention count of each, as chat.list_rooms returns them. Subscribe to it with subscriptions/listen to follow all of your rooms with one subscription, also the rooms that you join later. Then call chat.list_rooms, and chat.list_messages for each room with a new version.",
	uriTemplate: "asterra://chat/rooms",
	restricted: "refuse",
	mimeType: "application/json",
	read: { operation: "chat.list_rooms", input: () => ({ view: "joined", limit: CHAT_LIMITS.pageSize }) },
	list: {
		operation: "chat.list_rooms",
		input: { view: "joined", limit: 1 },
		items: () => [{ vars: {}, title: "Your rooms" }],
	},
	updates:
		"A change of one of your rooms sends notifications/resources/updated: a new, changed or deleted message, a read marker, a new name or topic, a change of the members, a room that you join, and a room that you leave.",
});

/**
 * The newest change for the caller in each of its rooms. One subscription tells an agent about each
 * message that is for it, and about no other message.
 */
export const chatAddressed = defineResource({
	name: "chat.addressed",
	title: "Messages for you",
	description:
		"The newest change that is for you in each of your rooms and direct messages, as chat.list_addressed returns them: a message in a direct message, a mention of you or of a group, a reply in a thread that you follow, and a delete of your message by a different member. Subscribe to it with subscriptions/listen to get a notification only for a message that is for you, also in a room that you join later. Then call chat.list_addressed, and read each room that has a new entry.",
	uriTemplate: "asterra://chat/addressed",
	restricted: "refuse",
	mimeType: "application/json",
	read: { operation: "chat.list_addressed", input: () => ({}) },
	list: {
		operation: "chat.list_addressed",
		input: { limit: 1 },
		items: () => [{ vars: {}, title: "Messages for you" }],
	},
	updates:
		"A new, changed or deleted message that is for you sends notifications/resources/updated. Each other message of your rooms sends no notification. A change that you made sends no notification. Changes of one room in a short time send one notification.",
});

/** One item in a drive. The POST of a drive item event uses this URI. */
export const driveItem = defineResource({
	name: "drive.item",
	title: "Drive item",
	description:
		"One item in a drive, as drive.get_item returns it. A webhook for an item event sends this URI. The POST has no file content.",
	uriTemplate: "asterra://drive/{space_id}/items/{item_id}",
	restricted: { var: "space_id", resource: "drive" },
	mimeType: "application/json",
	read: {
		operation: "drive.get_item",
		input: (vars) => ({ space_id: vars.space_id as string, item_id: vars.item_id as string }),
	},
	list: {
		operation: "drive.list_items",
		input: {},
		items: (output) =>
			output.items.map((item) => ({
				vars: { space_id: item.space_id, item_id: item.id },
				title: item.name,
			})),
	},
	updates: "A webhook sends the change. subscriptions/listen does not follow this resource yet.",
});

/** One shared drive. The POST of a drive-level event uses this URI. */
export const driveSpace = defineResource({
	name: "drive.space",
	title: "Shared drive",
	description:
		"One shared drive, as drive.get_shared_drive returns it. A webhook for members or for a deleted drive sends this URI.",
	uriTemplate: "asterra://drive/{drive_id}",
	restricted: { var: "drive_id", resource: "drive" },
	mimeType: "application/json",
	read: {
		operation: "drive.get_shared_drive",
		input: (vars) => ({ drive_id: vars.drive_id as string }),
	},
	list: {
		operation: "drive.list_shared_drives",
		input: {},
		items: (output) =>
			output.shared_drives.map((drive) => ({
				vars: { drive_id: drive.id },
				title: drive.name,
			})),
	},
	updates: "A webhook sends the change. subscriptions/listen does not follow this resource yet.",
});

/** Every resource kind, by name. */
export const resources = {
	"mail.inbox": mailInbox,
	"chat.room": chatRoom,
	"chat.rooms": chatRooms,
	"chat.addressed": chatAddressed,
	"drive.item": driveItem,
	"drive.space": driveSpace,
} as const;

export type ResourceName = keyof typeof resources;

/** Every resource kind, without the operation-specific types, as the adapters hold it. */
export const resourceList: readonly ResourceDefinition[] = Object.values(resources) as readonly ResourceDefinition[];

/** The `{name}` variables of a URI template, in order. */
export function templateVars(uriTemplate: string): string[] {
	return [...uriTemplate.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1] as string);
}

/** The template with each variable replaced by its value. A value is one path segment, so it is percent-encoded. */
export function expandTemplate(uriTemplate: string, vars: Readonly<Record<string, string>>): string {
	return uriTemplate.replace(/\{([a-z_]+)\}/g, (_match, name: string) => encodeURIComponent(vars[name] ?? ""));
}

/**
 * The variables of a URI that matches the template, or null. Each variable matches one non-empty
 * path segment. The read operation validates the values.
 */
export function matchTemplate(uriTemplate: string, uri: string): Record<string, string> | null {
	const names = templateVars(uriTemplate);
	const pattern = uriTemplate
		.split(/\{[a-z_]+\}/)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("([^/?#]+)");
	const match = new RegExp(`^${pattern}$`).exec(uri);
	if (!match) return null;
	const vars: Record<string, string> = {};
	for (const [index, name] of names.entries()) {
		try {
			vars[name] = decodeURIComponent(match[index + 1] as string);
		} catch {
			return null;
		}
	}
	return vars;
}

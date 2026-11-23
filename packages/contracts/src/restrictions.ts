import { z } from "./zod.ts";

// The resource limits of an agent or a service account. An agent can name the mailboxes, the drives and the
// rooms that it can reach, on top of its memberships. Each API key and each OAuth connection of the agent has
// the same limits. Each operation that an agent can call has one rule here, and the invoker applies it to a
// limited agent before the handler runs. An operation without a rule is refused for a limited agent, so a new
// operation cannot bypass a limit.

export const AGENT_RESOURCE_LIMITS = {
	/** The ids of one kind (mailboxes, drives or rooms) that one agent can name, at most. */
	perKind: 20,
} as const;

const ResourceIds = z
	.array(z.string().min(1).max(64))
	.max(AGENT_RESOURCE_LIMITS.perKind)
	.refine((ids) => new Set(ids).size === ids.length, "must not name an id two times");

/**
 * The limits of an agent or a service account. Each list is the complete list of that product: an empty list
 * allows nothing of it. The own mailbox and the own drive of the agent have the id of the agent, and a list
 * names them like each other id. Null on an agent: not limited.
 */
export const AgentResources = z.strictObject({
	mailbox_ids: ResourceIds,
	drive_ids: ResourceIds,
	room_ids: ResourceIds,
});
export type AgentResources = z.infer<typeof AgentResources>;

/**
 * The limits of a new agent or service account: its own mailbox and its own drive, and no room. A new agent
 * has no membership, so these limits name each resource that it reaches. A manager adds a team mailbox, a
 * shared drive or a room, or removes the limits, with `directory.set_agent_access`.
 */
export function defaultAgentResources(agentId: string): AgentResources {
	return { mailbox_ids: [agentId], drive_ids: [agentId], room_ids: [] };
}

/**
 * The `limits` field of an operation that creates an agent or a service account.
 * - `own` (the default): the new agent gets `defaultAgentResources`.
 * - `none`: the new agent has no limits.
 *
 * A create call takes no list of resources, because the own mailbox and the own drive have the id of the
 * agent, which does not exist before the call. The wide value is a word and not null or false: a client that
 * sends null or false for a field that it did not set must not remove the limits.
 */
export const NewAgentLimits = z.enum(["own", "none"]);
export type NewAgentLimits = z.infer<typeof NewAgentLimits>;

export type ResourceKind = "mailbox" | "drive" | "room";

/**
 * One input field that names a resource. `absent` says what a call without the field means: `own` is the
 * own mailbox or drive of the caller, `none` names no resource, and `refuse` refuses the call for a limited
 * agent. `value: "own"` means that each value comes from the own drive of the caller (for example the files
 * of a chat message), so any value needs the own drive in the list.
 */
export interface ResourceField {
	field: string;
	resource: ResourceKind;
	absent: "own" | "none" | "refuse";
	value?: "id" | "own";
}

/**
 * How an operation treats a limited agent or service account.
 * - `none`: the operation names no mailbox, drive or room. Its scope decides.
 * - `filter`: a list. The handler leaves out each resource that the agent does not name.
 * - `check`: each field must name a resource of the list.
 * - `refuse`: the operation is not open to a limited agent: it reads or writes state across rooms, or makes
 *   a resource that the list cannot name yet.
 */
export type ResourceRule =
	| { mode: "none" }
	| { mode: "filter" }
	| { mode: "refuse" }
	| { mode: "check"; fields: readonly ResourceField[] };

const NONE: ResourceRule = { mode: "none" };
const FILTER: ResourceRule = { mode: "filter" };
const REFUSE: ResourceRule = { mode: "refuse" };
const check = (...fields: ResourceField[]): ResourceRule => ({ mode: "check", fields });

const MAILBOX: ResourceField = { field: "mailbox_id", resource: "mailbox", absent: "own" };
const SPACE: ResourceField = { field: "space_id", resource: "drive", absent: "own" };
const ROOM: ResourceField = { field: "room_id", resource: "room", absent: "refuse" };
const IN_MAILBOX = check(MAILBOX);
const IN_SPACE = check(SPACE);
const IN_ROOM = check(ROOM);

/** The rule of each operation that an agent can call. The registry test keeps it complete. */
export const RESOURCE_RULES: Readonly<Record<string, ResourceRule>> = {
	"account.whoami": NONE,
	"directory.list_principals": NONE,
	"directory.get_principals": NONE,
	"directory.list_team_mailboxes": NONE,
	"chat.list_custom_emoji": NONE,
	"chat.list_slash_commands": NONE,
	"chat.get_presence": NONE,
	// The status of the agent names no room.
	"chat.set_status": NONE,
	// An endpoint names no resource, and the outbound policy limits its host. A subscription names the
	// resource, so its operation has a check. A delete only removes a subscription of the caller.
	"webhooks.create_endpoint": NONE,
	"webhooks.list_endpoints": NONE,
	"webhooks.update_endpoint": NONE,
	"webhooks.delete_endpoint": NONE,
	"mail.delete_webhook_subscription": NONE,
	"drive.delete_webhook_subscription": NONE,
	"chat.list_webhook_subscriptions": NONE,
	"chat.delete_webhook_subscription": NONE,

	"mail.list_mailboxes": FILTER,
	"drive.list_shared_drives": FILTER,
	"chat.list_rooms": FILTER,

	"mail.get_profile": IN_MAILBOX,
	"mail.list_labels": IN_MAILBOX,
	"mail.create_label": IN_MAILBOX,
	"mail.delete_label": IN_MAILBOX,
	"mail.list_threads": IN_MAILBOX,
	"mail.get_thread": IN_MAILBOX,
	"mail.get_message": IN_MAILBOX,
	"mail.modify_threads": IN_MAILBOX,
	"mail.send": IN_MAILBOX,
	"mail.suggest_recipients": IN_MAILBOX,
	"mail.get_attachment": IN_MAILBOX,
	"mail.create_webhook_subscription": IN_MAILBOX,
	// Without mailbox_id, the list has the subscriptions of the caller in each mailbox: the own mailbox must be
	// in the list.
	"mail.list_webhook_subscriptions": IN_MAILBOX,

	"drive.get_about": IN_SPACE,
	// The shared and the starred views read items of other drives. The handler leaves out each drive that
	// the account does not name.
	"drive.list_items": IN_SPACE,
	"drive.get_item": IN_SPACE,
	"drive.create_folder": IN_SPACE,
	"drive.upload_file": check(SPACE, { field: "room_id", resource: "room", absent: "none" }),
	"drive.upload_version": IN_SPACE,
	"drive.download_file": IN_SPACE,
	"drive.set_preview": IN_SPACE,
	"drive.create_upload": check(SPACE, { field: "room_id", resource: "room", absent: "none" }),
	"drive.upload_part": IN_SPACE,
	"drive.get_upload": IN_SPACE,
	"drive.complete_upload": IN_SPACE,
	"drive.abort_upload": IN_SPACE,
	"drive.list_versions": IN_SPACE,
	"drive.restore_version": IN_SPACE,
	"drive.rename_item": IN_SPACE,
	"drive.move_items": IN_SPACE,
	"drive.copy_item": check(SPACE, { field: "target_space_id", resource: "drive", absent: "own" }),
	"drive.star_items": IN_SPACE,
	"drive.trash_items": IN_SPACE,
	"drive.restore_items": IN_SPACE,
	"drive.delete_items": IN_SPACE,
	"drive.empty_trash": IN_SPACE,
	"drive.list_permissions": IN_SPACE,
	"drive.share_item": IN_SPACE,
	"drive.unshare_item": IN_SPACE,
	"drive.get_shared_drive": check({ field: "drive_id", resource: "drive", absent: "refuse" }),
	"drive.move_to_drive": check(SPACE, { field: "target_space_id", resource: "drive", absent: "refuse" }),
	"docs.create": IN_SPACE,
	"docs.get": IN_SPACE,
	"docs.update": IN_SPACE,
	"docs.upload_image": IN_SPACE,
	"docs.copy_image": check(SPACE, { field: "from_space_id", resource: "drive", absent: "own" }),
	"docs.import_image": IN_SPACE,
	"docs.get_image": IN_SPACE,
	"sheets.create": IN_SPACE,
	"sheets.get": IN_SPACE,
	"sheets.update_cells": IN_SPACE,
	"sheets.format_cells": IN_SPACE,
	"sheets.add_tab": IN_SPACE,
	"sheets.rename_tab": IN_SPACE,
	"sheets.move_tab": IN_SPACE,
	"sheets.duplicate_tab": IN_SPACE,
	"sheets.delete_tab": IN_SPACE,
	"drive.create_webhook_subscription": IN_SPACE,
	"drive.list_webhook_subscriptions": IN_SPACE,

	"chat.get_room": IN_ROOM,
	"chat.update_room": IN_ROOM,
	"chat.join_room": IN_ROOM,
	"chat.add_members": IN_ROOM,
	"chat.remove_member": IN_ROOM,
	"chat.list_messages": IN_ROOM,
	// The files of a message come from the own drive of the author.
	"chat.post_message": check(ROOM, { field: "file_ids", resource: "drive", absent: "none", value: "own" }),
	"chat.list_replies": IN_ROOM,
	"chat.follow_thread": IN_ROOM,
	"chat.mark_thread_read": IN_ROOM,
	// A search across each room of the caller reads rooms outside the list, so it needs a room.
	"chat.search_messages": IN_ROOM,
	"chat.edit_message": check(ROOM, { field: "file_ids", resource: "drive", absent: "none", value: "own" }),
	"chat.delete_message": IN_ROOM,
	"chat.download_file": IN_ROOM,
	"chat.remove_link_preview": IN_ROOM,
	"chat.download_link_image": IN_ROOM,
	"chat.add_reaction": IN_ROOM,
	"chat.remove_reaction": IN_ROOM,
	"chat.mark_read": IN_ROOM,
	"chat.star_room": IN_ROOM,
	"chat.pin_message": IN_ROOM,
	"chat.unpin_message": IN_ROOM,
	"chat.list_pins": IN_ROOM,
	"chat.forward_message": check(ROOM, { field: "target_room_id", resource: "room", absent: "refuse" }),
	"chat.archive_room": IN_ROOM,
	"chat.unarchive_room": IN_ROOM,
	"chat.set_posting_rules": IN_ROOM,
	"chat.set_room_retention": IN_ROOM,
	"chat.invoke_slash_command": IN_ROOM,
	"chat.trigger_card_action": IN_ROOM,
	"chat.list_card_actions": IN_ROOM,
	"chat.list_incoming_webhooks": IN_ROOM,
	"chat.set_room_notification_level": IN_ROOM,

	// A new room, or a direct message, is outside the list. The personal views of Chat (threads, activity,
	// sections, saved messages, scheduled messages, reminders and drafts) read and write state across rooms,
	// and a scheduled message posts later without a call.
	"chat.create_room": REFUSE,
	"chat.open_dm": REFUSE,
	"chat.open_group_dm": REFUSE,
	"chat.list_threads": REFUSE,
	"chat.list_addressed": REFUSE,
	"chat.list_activity": REFUSE,
	"chat.mark_activity_read": REFUSE,
	"chat.list_sections": REFUSE,
	"chat.create_section": REFUSE,
	"chat.update_section": REFUSE,
	"chat.delete_section": REFUSE,
	"chat.set_room_section": REFUSE,
	"chat.save_message": REFUSE,
	"chat.unsave_message": REFUSE,
	"chat.list_saved_messages": REFUSE,
	"chat.schedule_message": REFUSE,
	"chat.list_scheduled_messages": REFUSE,
	"chat.update_scheduled_message": REFUSE,
	"chat.cancel_scheduled_message": REFUSE,
	"chat.create_reminder": REFUSE,
	"chat.list_reminders": REFUSE,
	"chat.complete_reminder": REFUSE,
	"chat.delete_reminder": REFUSE,
	"chat.list_drafts": REFUSE,
	"chat.save_draft": REFUSE,
	"chat.delete_draft": REFUSE,
	// The notification settings hold the level of each room of the agent.
	"chat.get_notification_settings": REFUSE,
	"chat.set_notification_settings": REFUSE,
	// A chat subscription sends the messages of each room of the agent.
	"chat.create_webhook_subscription": REFUSE,
};

/** The rule of an operation for a limited agent, or undefined when it has none: then the call is refused. */
export function resourceRuleOf(operationName: string): ResourceRule | undefined {
	return Object.hasOwn(RESOURCE_RULES, operationName) ? RESOURCE_RULES[operationName] : undefined;
}

const LISTS: Record<ResourceKind, keyof AgentResources> = {
	mailbox: "mailbox_ids",
	drive: "drive_ids",
	room: "room_ids",
};

/**
 * The ids of one kind that an agent with these limits can reach, or null for no limits. A list
 * operation gives these ids to its query, so its page and its cursor never name a resource outside them.
 */
export function listedIds(restriction: AgentResources | null, kind: ResourceKind): readonly string[] | null {
	return restriction === null ? null : restriction[LISTS[kind]];
}

/** True when an agent with these limits can reach the resource. An agent without limits (null) can. */
export function allowsResource(restriction: AgentResources | null, kind: ResourceKind, id: string): boolean {
	return restriction === null || restriction[LISTS[kind]].includes(id);
}

const NOT_OPEN = "This agent is limited to listed mailboxes, drives and rooms, and this operation is not open to it.";

/**
 * Why a limited agent cannot make this call, or null when it can. `input` is the validated input. An
 * agent without limits always can. An operation without a rule, and an operation with the rule `refuse`, refuse.
 */
export function resourceRefusal(
	operationName: string,
	input: unknown,
	caller: { id: string; restriction: AgentResources | null },
): string | null {
	const { restriction } = caller;
	if (restriction === null) return null;
	const rule = resourceRuleOf(operationName);
	if (!rule || rule.mode === "refuse") return NOT_OPEN;
	if (rule.mode !== "check") return null;
	const values = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
	for (const field of rule.fields) {
		const value = values[field.field];
		const absent =
			value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
		if (absent) {
			if (field.absent === "refuse") return `This agent is limited, and ${field.field} must name a listed resource.`;
			if (field.absent === "own" && !allowsResource(restriction, field.resource, caller.id)) {
				return `This agent is limited, and its list does not name its own ${field.resource}.`;
			}
			continue;
		}
		if (field.value === "own") {
			if (!allowsResource(restriction, field.resource, caller.id)) {
				return `This agent is limited, and ${field.field} needs its own ${field.resource} in its list.`;
			}
			continue;
		}
		const ids = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
		if (!ids?.every((id) => typeof id === "string" && allowsResource(restriction, field.resource, id))) {
			return `This agent is limited, and ${field.field} names a ${field.resource} that its list does not name.`;
		}
	}
	return null;
}

// The operation handlers and the resource change feeds of each domain, joined, and the subscriptions of
// MCP Events. The composition root and the tests use these maps.
import { AGENT_ACCESS_LIMITS, type OutputOf } from "@asterra/contracts";
import { aiHandlers } from "./ai/index.ts";
import { calendarHandlers, enableCalendarEvents } from "./calendar/index.ts";
import {
	chatHandlers,
	chatWatchers,
	confirmedRoomsOf,
	invokeSlashCommand,
	removeDeletedPrincipalFromRooms,
} from "./chat/index.ts";
import { docsHandlers } from "./docs/index.ts";
import {
	confirmedSharedDrivesOf,
	driveHandlers,
	driveWatchers,
	enableDriveEvents,
	sharedItemsOfPrincipal,
} from "./drive/index.ts";
import { feedbackHandlers } from "./feedback/index.ts";
import { type CallContext, getPrincipal, identityHandlers } from "./identity/index.ts";
import { closeAutoLabels, enableMailEvents, mailHandlers, mailWatchers } from "./mail/index.ts";
import { meetHandlers } from "./meet/index.ts";
import type { EventSubscriptions, HandlerMap, WatcherMap } from "./platform/index.ts";
import { log, OperationError } from "./platform/index.ts";
import { sheetsHandlers } from "./sheets/index.ts";
import { createEventSubscriptions, endpointHandlers } from "./webhooks/index.ts";

export const handlers: HandlerMap<CallContext> = {
	...identityHandlers,
	...mailHandlers,
	...driveHandlers,
	...docsHandlers,
	...sheetsHandlers,
	...chatHandlers,
	...endpointHandlers,
	...aiHandlers,
	...feedbackHandlers,
	...calendarHandlers,
	...meetHandlers,
	async "chat.invoke_slash_command"(call, input) {
		return await invokeSlashCommand(call, handlers, {
			room_id: input.room_id,
			command: input.command,
			text: input.text ?? "",
		});
	},
	// The identity handler checks the access and reads the team mailboxes and the keys. The shared drives
	// and the rooms come from the indexes of Drive and Chat. The items shared directly with an agent or a
	// service account come from its own drive, and the drive of each item checks its access again.
	async "directory.get_member_access"(call, input) {
		return withResources(call, await identityHandlers["directory.get_member_access"](call, input));
	},
	async "directory.get_agent_access"(call, input) {
		return withResources(call, await identityHandlers["directory.get_agent_access"](call, input));
	},
	async "directory.delete_principal"(call, input) {
		const result = await identityHandlers["directory.delete_principal"](call, input);
		// The mail of a deleted mailbox never goes to the classifier: its auto labels turn off and their outbox
		// empties. If this fails, the consumer still drops each job of a mailbox that is not in the directory.
		try {
			await closeAutoLabels(call.env, result.principal_id);
		} catch (error) {
			log("error", "auto labels did not close on principal delete", {
				principalId: result.principal_id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// Bounded best-effort cleanup on delete; admins can finish larger memberships via chat.admin_remove_deleted_principal.
		try {
			await removeDeletedPrincipalFromRooms(call.env, result.principal_id, 50);
		} catch (error) {
			log("warn", "best-effort chat membership cleanup failed on principal delete", {
				principalId: result.principal_id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return result;
	},
};

/**
 * The access of a member with its shared drives, its rooms and the items shared directly with it.
 *
 * For a person, the answer has only what an owner or an admin can see in a different place: the team mailboxes,
 * the shared drives and the public rooms. The private rooms, the direct messages and the items that others
 * shared directly with the person stay private.
 *
 * The indexes can have a membership from before migration 0033 that its room or its drive did not narrow. Only
 * an agent or a service account without both scopes of the product can have one. For such an account, each room
 * and each drive of the answer confirms the membership, so the answer has the narrowed roles.
 */
async function withResources(call: CallContext, access: OutputOf<"directory.get_member_access">) {
	const member = await getPrincipal(call.env.DIRECTORY, access.principal_id);
	if (!member) throw new OperationError("not_found", "No member has that id.");
	const [drives, rooms, shared] = await Promise.all([
		confirmedSharedDrivesOf(call.env, member),
		confirmedRoomsOf(call.env, member, AGENT_ACCESS_LIMITS.rooms),
		member.kind === "human"
			? { items: [], truncated: false }
			: sharedItemsOfPrincipal(call.env, member, AGENT_ACCESS_LIMITS.sharedItems),
	]);
	return {
		...access,
		shared_drives: drives,
		chat_rooms: rooms.rooms,
		chat_rooms_truncated: rooms.truncated,
		drive_shared_items: shared.items,
		drive_shared_items_truncated: shared.truncated,
	};
}

/** The change feed of each resource kind, for `subscriptions/listen` on MCP. */
export const watchers: WatcherMap<CallContext> = {
	...mailWatchers,
	...chatWatchers,
	...driveWatchers,
};

/**
 * The subscriptions of MCP Events, for `events/subscribe` on MCP. Mail and Drive record events only
 * after their object knows that a subscription exists.
 */
export const events: EventSubscriptions<CallContext> = createEventSubscriptions({
	mail: enableMailEvents,
	drive: enableDriveEvents,
	calendar: enableCalendarEvents,
});

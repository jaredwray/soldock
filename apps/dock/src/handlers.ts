// The operation handlers and the resource change feeds of each domain, joined, and the subscriptions of
// MCP Events. The composition root and the tests use these maps.
import { AGENT_ACCESS_LIMITS } from "@asterra/contracts";
import { aiHandlers } from "./ai/index.ts";
import {
	chatHandlers,
	chatWatchers,
	invokeSlashCommand,
	removeDeletedPrincipalFromRooms,
	roomsOfPrincipal,
} from "./chat/index.ts";
import { docsHandlers } from "./docs/index.ts";
import {
	driveHandlers,
	driveWatchers,
	enableDriveEvents,
	sharedDrivesOfPrincipal,
	sharedItemsOfPrincipal,
} from "./drive/index.ts";
import { type CallContext, getPrincipal, identityHandlers } from "./identity/index.ts";
import { closeAutoLabels, enableMailEvents, mailHandlers, mailWatchers } from "./mail/index.ts";
import type { EventSubscriptions, HandlerMap, WatcherMap } from "./platform/index.ts";
import { log } from "./platform/index.ts";
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
	async "chat.invoke_slash_command"(call, input) {
		return await invokeSlashCommand(call, handlers, {
			room_id: input.room_id,
			command: input.command,
			text: input.text ?? "",
		});
	},
	// The identity handler checks the access and reads the team mailboxes and the keys. The shared drives
	// and the rooms come from the indexes of Drive and Chat. The items shared directly come from the drive of
	// the agent, and the drive of each item checks the access of the agent again.
	async "directory.get_agent_access"(call, input) {
		const result = await identityHandlers["directory.get_agent_access"](call, input);
		const agent = await getPrincipal(call.env.DIRECTORY, result.principal_id);
		const [drives, rooms, shared] = await Promise.all([
			sharedDrivesOfPrincipal(call.env.DIRECTORY, result.principal_id),
			roomsOfPrincipal(call.env.DIRECTORY, result.principal_id, AGENT_ACCESS_LIMITS.rooms),
			agent
				? sharedItemsOfPrincipal(call.env, agent, AGENT_ACCESS_LIMITS.sharedItems)
				: { items: [], truncated: false },
		]);
		return {
			...result,
			shared_drives: drives,
			chat_rooms: rooms.rooms,
			chat_rooms_truncated: rooms.truncated,
			drive_shared_items: shared.items,
			drive_shared_items_truncated: shared.truncated,
		};
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
});

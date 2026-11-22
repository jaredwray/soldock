// The operation handlers and the resource change feeds of each domain, joined, and the subscriptions of
// MCP Events. The composition root and the tests use these maps.
import { SERVICE_ACCESS_LIMITS } from "@asterra/contracts";
import {
	chatHandlers,
	chatWatchers,
	invokeSlashCommand,
	removeDeletedPrincipalFromRooms,
	roomsOfPrincipal,
} from "./chat/index.ts";
import { docsHandlers } from "./docs/index.ts";
import { driveHandlers, driveWatchers, enableDriveEvents, sharedDrivesOfPrincipal } from "./drive/index.ts";
import { type CallContext, identityHandlers } from "./identity/index.ts";
import { enableMailEvents, mailHandlers, mailWatchers } from "./mail/index.ts";
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
	async "chat.invoke_slash_command"(call, input) {
		return await invokeSlashCommand(call, handlers, {
			room_id: input.room_id,
			command: input.command,
			text: input.text ?? "",
		});
	},
	// The identity handler checks the access and reads the team mailboxes and the tokens. The shared drives
	// and the rooms come from the indexes of Drive and Chat.
	async "directory.get_service_account_access"(call, input) {
		const result = await identityHandlers["directory.get_service_account_access"](call, input);
		const [drives, rooms] = await Promise.all([
			sharedDrivesOfPrincipal(call.env.DIRECTORY, result.principal_id),
			roomsOfPrincipal(call.env.DIRECTORY, result.principal_id, SERVICE_ACCESS_LIMITS.rooms),
		]);
		return { ...result, shared_drives: drives, chat_rooms: rooms.rooms, chat_rooms_truncated: rooms.truncated };
	},
	async "directory.delete_principal"(call, input) {
		const result = await identityHandlers["directory.delete_principal"](call, input);
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

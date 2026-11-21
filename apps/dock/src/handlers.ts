// The operation handlers and the resource change feeds of each domain, joined, and the subscriptions of
// MCP Events. The composition root and the tests use these maps.
import { chatHandlers, chatWatchers, invokeSlashCommand, removeDeletedPrincipalFromRooms } from "./chat/index.ts";
import { docsHandlers } from "./docs/index.ts";
import { driveHandlers, driveWatchers, enableDriveEvents } from "./drive/index.ts";
import { type CallContext, identityHandlers } from "./identity/index.ts";
import { enableMailEvents, mailHandlers, mailWatchers } from "./mail/index.ts";
import type { EventSubscriptions, HandlerMap, WatcherMap } from "./platform/index.ts";
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
	async "directory.delete_principal"(call, input) {
		const result = await identityHandlers["directory.delete_principal"](call, input);
		// Bounded best-effort cleanup on delete; admins can finish larger memberships via chat.admin_remove_deleted_principal.
		try {
			await removeDeletedPrincipalFromRooms(call.env, result.principal_id, 50);
		} catch {
			// Best-effort cleanup; remaining memberships can be cleaned with chat.admin_remove_deleted_principal.
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

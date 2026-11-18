// The operation handlers and the resource change feeds of each domain, joined, and the subscriptions of
// MCP Events. The composition root and the tests use these maps.
import { chatHandlers, chatWatchers } from "./chat/index.ts";
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

// The operation handlers and the resource change feeds of each domain, joined. The composition root and
// the tests use these maps.
import { chatHandlers } from "./chat/index.ts";
import { docsHandlers } from "./docs/index.ts";
import { driveHandlers } from "./drive/index.ts";
import { type CallContext, identityHandlers } from "./identity/index.ts";
import { mailHandlers, mailWatchers } from "./mail/index.ts";
import type { HandlerMap, WatcherMap } from "./platform/index.ts";
import { sheetsHandlers } from "./sheets/index.ts";

export const handlers: HandlerMap<CallContext> = {
	...identityHandlers,
	...mailHandlers,
	...driveHandlers,
	...docsHandlers,
	...sheetsHandlers,
	...chatHandlers,
};

/** The change feed of each resource kind, for `subscriptions/listen` on MCP. */
export const watchers: WatcherMap<CallContext> = {
	...mailWatchers,
};

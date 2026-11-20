// The operation handlers and the resource change feeds of each domain, joined, and the subscriptions of
// MCP Events. The composition root and the tests use these maps.
import { chatHandlers, chatWatchers } from "./chat/index.ts";
import { docsHandlers } from "./docs/index.ts";
import { driveHandlers, driveWatchers, enableDriveEvents } from "./drive/index.ts";
import { type CallContext, identityHandlers } from "./identity/index.ts";
import { enableMailEvents, limitQueryProblem, mailHandlers, mailWatchers } from "./mail/index.ts";
import { type EventSubscriptions, type HandlerMap, OperationError, type WatcherMap } from "./platform/index.ts";
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
	// The identity module does not know the search syntax of Mail. So the check of the query of a Mail
	// limit is here, before the key exists. A key with a query that does not compile reads no mail.
	async "account.create_api_key"(call, input) {
		const query = input.limits?.mail?.query;
		const problem = query === undefined ? null : limitQueryProblem(query);
		if (problem !== null) throw new OperationError("invalid", `limits.mail.query: ${problem}`);
		return identityHandlers["account.create_api_key"](call, input);
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

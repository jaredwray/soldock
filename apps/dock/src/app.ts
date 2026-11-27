import { Hono } from "hono";
import { mountRestApi } from "./api/index.ts";
import { mountChatFiles, mountChatIncomingWebhooks, mountChatSocket } from "./chat/index.ts";
import { mountDriveTransfer } from "./drive/index.ts";
import { mountFeedbackFiles } from "./feedback/index.ts";
import { type CallContext, mountAuthRoutes, mountEventsSocket, mountOAuthRoutes } from "./identity/index.ts";
import { mountMcp } from "./mcp/index.ts";
import {
	type EventSubscriptions,
	type HandlerMap,
	log,
	OperationError,
	problemResponse,
	type RequestIdVariables,
	requestId,
	type WatcherMap,
} from "./platform/index.ts";

export type AppEnv = { Bindings: Env; Variables: RequestIdVariables };

/**
 * The HTTP app for Worker-owned paths (see `WORKER_PREFIXES`): `/auth/*`, the OAuth server (`/oauth/*`,
 * `/.well-known/*`), REST, MCP, the uploads and downloads of Drive (`/blob/drive/*`, `/dl/drive/*`), the files of Chat (`/dl/chat/*`), the attachments of feedback (`/dl/feedback/*`), the room sockets of Chat (`/ws/chat/*`) and the events socket (`/ws/events`). The REST routes and the MCP tools
 * come from the operation registry, with the handlers that the composition root passes in. MCP
 * resource subscriptions use the change feeds that it passes in. MCP Events uses the subscriptions that
 * it passes in.
 */
export function createApp(
	handlers: HandlerMap<CallContext>,
	watchers: WatcherMap<CallContext>,
	events: EventSubscriptions<CallContext>,
): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use(requestId());

	app.get("/healthz", (c) => c.json({ ok: true }, 200, { "cache-control": "no-store" }));
	app.get("/api/v1/system/ping", (c) => c.json({ ok: true }));
	mountAuthRoutes(app);
	mountOAuthRoutes(app);
	mountRestApi(app, handlers);
	mountMcp(app, handlers, watchers, events);
	mountDriveTransfer(app);
	mountChatFiles(app);
	mountFeedbackFiles(app);
	mountChatIncomingWebhooks(app);
	mountChatSocket(app);
	mountEventsSocket(app);

	app.notFound((c) => {
		const { pathname } = new URL(c.req.url);
		return problemResponse({
			type: "about:blank",
			title: "Not Found",
			status: 404,
			code: "not_found",
			detail: `No route for ${c.req.method} ${pathname}`,
			instance: pathname,
			requestId: c.var.requestId,
		});
	});

	app.onError((err, c) => {
		const instance = new URL(c.req.url).pathname;
		if (err instanceof OperationError) return err.toResponse({ requestId: c.var.requestId, instance });
		log("error", "unhandled error", { requestId: c.var.requestId, err: err.stack ?? String(err) });
		return problemResponse({
			type: "about:blank",
			title: "Internal Server Error",
			status: 500,
			code: "internal",
			requestId: c.var.requestId,
		});
	});

	return app;
}

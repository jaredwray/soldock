import { Hono } from "hono";
import { problemResponse, type RequestIdVariables, requestId } from "./platform/index.ts";

export type AppEnv = { Bindings: Env; Variables: RequestIdVariables };

/**
 * The HTTP app for Worker-owned paths (see `WORKER_PREFIXES`). Routes are hand-written until the
 * operation registry generates them (S00.T10).
 */
export function createApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use(requestId());

	app.get("/api/v1/system/ping", (c) => c.json({ ok: true }));

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
		console.error(
			JSON.stringify({
				level: "error",
				msg: "unhandled error",
				requestId: c.var.requestId,
				err: err.stack ?? String(err),
			}),
		);
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

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://dock.test";

function get(path: string, headers?: Record<string, string>): Promise<Response> {
	return exports.default.fetch(new Request(`${ORIGIN}${path}`, headers ? { headers } : {}));
}

describe("GET /api/v1/system/ping", () => {
	it("returns { ok: true } with a request id", async () => {
		const res = await get("/api/v1/system/ping");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/^application\/json/);
		expect(await res.json()).toEqual({ ok: true });
		expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("generates a fresh request id per request and ignores a client-supplied one", async () => {
		const a = await get("/api/v1/system/ping", { "x-request-id": "client-chosen-id" });
		const b = await get("/api/v1/system/ping");
		const idA = a.headers.get("x-request-id");
		expect(idA).not.toBe("client-chosen-id");
		expect(idA).not.toBe(b.headers.get("x-request-id"));
	});
});

describe("unknown Worker paths", () => {
	it.each([
		"/api/v1/nope",
		"/api/v2/system/ping",
		"/mcp",
		"/oauth/authorize",
		"/.well-known/oauth-authorization-server",
		"/auth/sign-in",
		"/ws/events",
		"/blob/upload",
		"/dl/token",
		"/hooks/email",
	])("%s returns a problem+json 404, never the SPA", async (path) => {
		const res = await get(path, { "sec-fetch-mode": "navigate", accept: "text/html" });
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toBe("application/problem+json");
		const requestId = res.headers.get("x-request-id");
		expect(requestId).toBeTruthy();
		expect(await res.json()).toEqual({
			type: "about:blank",
			title: "Not Found",
			status: 404,
			code: "not_found",
			detail: `No route for GET ${path}`,
			instance: path,
			requestId,
		});
	});

	it("returns 404 for a known path with the wrong method", async () => {
		const res = await exports.default.fetch(new Request(`${ORIGIN}/api/v1/system/ping`, { method: "POST" }));
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toBe("application/problem+json");
	});
});

describe("SPA fallback", () => {
	// In production, navigations to these paths are answered by assets before the Worker runs
	// (run_worker_first is checked in config.test.ts). These cover the requests that do reach it.
	it.each(["/", "/mail", "/mail/inbox/thr_123", "/d/itm_abc", "/settings", "/api"])(
		"%s serves index.html",
		async (path) => {
			const res = await get(path, { "sec-fetch-mode": "navigate", accept: "text/html" });
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toMatch(/^text\/html/);
			expect(await res.text()).toContain("data-soldock-shell");
		},
	);
});

import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

const ORIGIN = "https://soldock-spike-email.test";
const AUTH = { authorization: "Bearer test-token" };

function call(path: string, init: RequestInit = {}): Promise<Response> {
	return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

describe("the run token gate", () => {
	it("refuses every route with 503 while SPIKE_TOKEN is not set", async () => {
		const noToken: Env = { EMAIL: env.EMAIL, EVENTS: env.EVENTS };
		for (const [method, path] of [
			["GET", "/ready"],
			["POST", "/send"],
			["GET", "/events"],
		] as const) {
			const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: AUTH }), noToken);
			expect(res.status, `${method} ${path}`).toBe(503);
		}
	});

	it.each([
		["no authorization header", {}],
		["a wrong token", { authorization: "Bearer other-token" }],
		["the token without the Bearer scheme", { authorization: "test-token" }],
		["the token with extra text", { authorization: "Bearer test-token-and-more" }],
	])("refuses %s with 401, also on /send", async (_name, headers) => {
		expect((await call("/ready", { headers })).status).toBe(401);
		const send = await call("/send", { method: "POST", headers, body: "{}" });
		expect(send.status).toBe(401);
	});

	it("answers /ready with the token", async () => {
		const res = await call("/ready", { headers: AUTH });
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
	});
});

describe("POST /send", () => {
	it("refuses a bad request body with 400", async () => {
		const res = await call("/send", {
			method: "POST",
			headers: AUTH,
			body: JSON.stringify({ runId: "1", from: "spike@spike.example", to: [] }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: expect.stringMatching(/to must list/) });
	});

	it("sends a structured message, a raw MIME message and a reply to each, for each recipient, and stores the results", async () => {
		const res = await call("/send", {
			method: "POST",
			headers: AUTH,
			body: JSON.stringify({ runId: "7-1", from: "spike@spike.example", to: ["a@example.com", "b@example.org"] }),
		});
		expect(res.status).toBe(200);
		const { results } = (await res.json()) as { results: { kind: string; to: string; error?: string }[] };
		expect(results.map((r) => `${r.kind} ${r.to}`)).toEqual([
			"structured a@example.com",
			"structured-reply a@example.com",
			"raw a@example.com",
			"raw-reply a@example.com",
			"structured b@example.org",
			"structured-reply b@example.org",
			"raw b@example.org",
			"raw-reply b@example.org",
		]);
		expect(results.filter((r) => r.error)).toEqual([]);

		// A collect run gets the same results, also when the workflow's call to /send timed out.
		const stored = await call("/events", { headers: AUTH });
		const { sends } = (await stored.json()) as { sends: { runId: string; kind: string; to: string }[] };
		expect(sends.filter((r) => r.runId === "7-1").map((r) => `${r.kind} ${r.to}`)).toEqual(
			results.map((r) => `${r.kind} ${r.to}`),
		);
	});
});

describe("the lifecycle event log", () => {
	it("records each queued event once, acks the batch, and returns the events from /events", async () => {
		const first = {
			id: "m1",
			timestamp: new Date("2026-10-18T12:00:00Z"),
			attempts: 1,
			body: { type: "delivered", n: 1 },
		};
		const second = {
			id: "m2",
			timestamp: new Date("2026-10-18T12:01:00Z"),
			attempts: 1,
			body: { type: "bounced", n: 2 },
		};
		const batch = createMessageBatch("soldock-spike-email-events", [first, second]);
		await worker.queue(batch, env);
		expect((await getQueueResult(batch, createExecutionContext())).ackAll).toBe(true);
		// A queue can deliver a message again. The log keeps one copy.
		await worker.queue(createMessageBatch("soldock-spike-email-events", [first]), env);

		const res = await call("/events", { headers: AUTH });
		expect(res.status).toBe(200);
		const { count, events } = (await res.json()) as { count: number; events: { id: string; body: unknown }[] };
		expect(count).toBe(2);
		expect(events.map((e) => [e.id, e.body])).toEqual([
			["m1", { type: "delivered", n: 1 }],
			["m2", { type: "bounced", n: 2 }],
		]);
	});
});

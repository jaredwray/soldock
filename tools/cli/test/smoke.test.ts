import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { type HttpResponse, httpGet } from "../src/http.ts";
import { smokeCheck } from "../src/smoke.ts";

const BASE = "https://work.example.com";
const json = (body: unknown, status = 200): HttpResponse => ({
	status,
	contentType: "application/json; charset=UTF-8",
	body: JSON.stringify(body),
});
const problem = (status: number): HttpResponse => ({ status, contentType: "application/problem+json", body: "{}" });

/** The answers of a healthy Worker. A navigation without the header of a browser gets no shell. */
function healthy(overrides: Record<string, HttpResponse> = {}) {
	const answers: Record<string, HttpResponse> = {
		"/api/v1/system/ping": json({ ok: true }),
		"/healthz": json({ ok: true }),
		"/api/v1/nope": problem(404),
		"/hooks/nope": problem(404),
		"/mcp": problem(405),
		"/api/v1/mail/profile": problem(401),
		"/auth/setup": json({ setup_needed: true }),
		"/mail": { status: 200, contentType: "text/html", body: '<div data-asterra-shell="">' },
		...overrides,
	};
	return async (url: string, headers: Record<string, string> = {}) => {
		const path = url.slice(BASE.length);
		if (path === "/mail" && headers["Sec-Fetch-Mode"] !== "navigate") return problem(404);
		const answer = answers[path];
		if (!answer) throw new Error(`unexpected ${url}`);
		return answer;
	};
}

const options = (get: ReturnType<typeof healthy>) => {
	let clock = 0;
	return {
		httpGet: get,
		sleep: async (ms: number) => {
			clock += ms;
		},
		now: () => clock,
	};
};

describe("smokeCheck", () => {
	it("passes each check against a healthy Worker", async () => {
		const results = await smokeCheck(`${BASE}/`, options(healthy()));
		expect(results.filter((result) => !result.ok)).toEqual([]);
		expect(results).toHaveLength(8);
	});

	it.each([
		["/api/v1/system/ping", json({ ok: false }), 'returns {"ok":true}'],
		["/healthz", { status: 200, contentType: "text/html", body: "<html>" }, "/healthz"],
		["/api/v1/nope", { status: 200, contentType: "text/html", body: "<html>" }, "/api/v1/nope"],
		["/mcp", problem(404), "/mcp returns a problem+json 405"],
		["/api/v1/mail/profile", json({}), "returns 401"],
		["/auth/setup", json({ setup_needed: "yes" }), "/auth/setup"],
		["/mail", { status: 200, contentType: "text/html", body: "<html>" }, "/mail returns the shell"],
	])("fails only the check of %s when its answer is wrong", async (path, answer, name) => {
		const failed = (await smokeCheck(BASE, options(healthy({ [path]: answer })))).filter((result) => !result.ok);
		expect(failed).toHaveLength(1);
		expect(failed[0]?.name).toContain(name);
	});

	it("waits for a new host, and stops with one failure when it never answers", async () => {
		const results = await smokeCheck(BASE, {
			...options(healthy({ "/api/v1/system/ping": problem(522) })),
			waitMs: 60_000,
		});
		expect(results).toEqual([{ name: "GET /api/v1/system/ping", ok: false, detail: "status 522" }]);
	});
});

// The assets router decides on Sec-Fetch-Mode. `fetch` sends `cors` in its place, so the smoke check
// has its own GET. A change back to `fetch` must fail here.
describe("httpGet", () => {
	it("sends the navigation headers as given", async () => {
		const server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ mode: request.headers["sec-fetch-mode"] ?? null }));
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		try {
			const { port } = server.address() as AddressInfo;
			const response = await httpGet(`http://127.0.0.1:${port}/`, { "Sec-Fetch-Mode": "navigate" });
			expect(response).toEqual({ status: 200, contentType: "application/json", body: '{"mode":"navigate"}' });
		} finally {
			server.close();
		}
	});
});

// The smoke check after a deploy. The requests go through the real assets router, which the workerd
// tests cannot reach. It replaces scripts/smoke-check.sh, with the same checks.
import type { HttpGet, HttpResponse } from "./http.ts";

export interface SmokeResult {
	name: string;
	ok: boolean;
	detail: string;
}

export interface SmokeOptions {
	httpGet: HttpGet;
	sleep(ms: number): Promise<void>;
	now(): number;
	/** How long the first request retries. A new custom domain needs its DNS record and its certificate. */
	waitMs?: number;
}

const NAVIGATE = { "Sec-Fetch-Mode": "navigate", Accept: "text/html" };

/** Runs each check against `baseUrl`. The first check waits for the host to answer. */
export async function smokeCheck(baseUrl: string, options: SmokeOptions): Promise<SmokeResult[]> {
	const base = baseUrl.replace(/\/+$/, "");
	const results: SmokeResult[] = [];
	const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

	const ping = await firstAnswer(`${base}/api/v1/system/ping`, options);
	if (ping === null || ping.status < 200 || ping.status > 299) {
		check("GET /api/v1/system/ping", false, ping === null ? "no answer" : `status ${ping.status}`);
		return results;
	}
	check('GET /api/v1/system/ping returns {"ok":true}', isOkBody(ping.body), clip(ping.body));

	// A retry only for a transient error, so that a wrong status shows at once.
	const get = async (path: string, headers: Record<string, string> = {}) => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await options.httpGet(`${base}${path}`, headers);
			} catch (error) {
				if (attempt >= 3) return { status: 0, contentType: "", body: String(error) } satisfies HttpResponse;
				await options.sleep(2000);
			}
		}
	};
	const describe = (response: HttpResponse) => `${response.status} ${response.contentType}`.trim();

	// The health endpoint must also bypass the SPA for a browser navigation.
	const health = await get("/healthz", NAVIGATE);
	check(
		"GET /healthz returns JSON for a browser navigation",
		health.status === 200 && health.contentType.startsWith("application/json") && isOkBody(health.body),
		describe(health),
	);

	// A navigation to a path of the Worker gets the problem+json of the Worker, not the SPA.
	for (const [path, status] of [
		["/api/v1/nope", 404],
		["/hooks/nope", 404],
		["/mcp", 405],
	] as const) {
		const response = await get(path, NAVIGATE);
		check(
			`navigation to ${path} returns a problem+json ${status}`,
			response.status === status && response.contentType.startsWith("application/problem+json"),
			describe(response),
		);
	}

	const profile = await get("/api/v1/mail/profile");
	check("GET /api/v1/mail/profile without a credential returns 401", profile.status === 401, describe(profile));

	const setup = await get("/auth/setup");
	check(
		"GET /auth/setup returns the setup status",
		setup.status === 200 && setup.contentType.startsWith("application/json") && hasSetupStatus(setup.body),
		describe(setup),
	);

	const shell = await get("/mail", NAVIGATE);
	check(
		"navigation to /mail returns the shell",
		shell.status === 200 && shell.contentType.startsWith("text/html") && shell.body.includes("data-asterra-shell"),
		describe(shell),
	);
	return results;
}

async function firstAnswer(url: string, options: SmokeOptions): Promise<HttpResponse | null> {
	const end = options.now() + (options.waitMs ?? 300_000);
	for (;;) {
		try {
			const response = await options.httpGet(url);
			if (response.status >= 200 && response.status <= 299) return response;
			if (options.now() >= end) return response;
		} catch {
			if (options.now() >= end) return null;
		}
		await options.sleep(5000);
	}
}

function parse(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

function isOkBody(body: string): boolean {
	const value = parse(body) as { ok?: unknown } | undefined;
	return value !== undefined && value !== null && Object.keys(value).length === 1 && value.ok === true;
}

function hasSetupStatus(body: string): boolean {
	return typeof (parse(body) as { setup_needed?: unknown } | undefined)?.setup_needed === "boolean";
}

function clip(text: string): string {
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

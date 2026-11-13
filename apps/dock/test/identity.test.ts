import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ALL_SCOPES, ApiError } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import baseMigration from "../migrations/0001_directory.sql?raw";
import domainMigration from "../migrations/0003_mail_domains.sql?raw";
import passwordMigration from "../migrations/0004_password_sign_in.sql?raw";
import { matchTotp, totpCode } from "../src/identity/totp.ts";
import worker from "../src/index.ts";
import legacyDirectory from "./fixtures/directory-v1.sql?raw";
import {
	api,
	callTool,
	cookieOf,
	createActor,
	mcp,
	ORIGIN,
	PASSWORD,
	request,
	SETUP_TOKEN,
	seedOrg,
	setupOwner,
	signIn,
	submitSignIn,
	totpNow,
} from "./helpers.ts";

async function denied(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ApiError);
	return (error as ApiError).code;
}

function setup(token: string, body: unknown, origin?: string) {
	return request("/auth/setup", {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(origin ? { origin } : {}) },
		body: JSON.stringify(body),
	});
}

/** Sends a request to the Worker with these bindings in place of the ones in vitest.config.ts. */
function withEnv(
	overrides: { SETUP_TOKEN?: string | undefined; DIRECTORY?: D1Database },
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
	return (worker as unknown as Required<Pick<ExportedHandler<Env>, "fetch">>).fetch(
		new Request(`${ORIGIN}${path}`, init),
		{ ...env, ...overrides } as unknown as Env,
		createExecutionContext(),
	);
}

const OWNER = {
	mail_domain: "dock.test",
	display_name: "Olive Owner",
	address: "owner@dock.test",
	password: PASSWORD,
};

const SESSION_COOKIE =
	/^__Host-soldock_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/;

/** A different code of the same length. */
function wrong(code: string): string {
	return String((Number(code) + 1) % 10 ** code.length).padStart(code.length, "0");
}

/** Calls an account route with a session cookie, as the web app does. */
function postWithCookie(cookie: string, path: string, body: Record<string, string> = {}) {
	return request(`/api/v1/account/${path}`, {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Turns on two-step verification for the caller of `call`, and returns the secret. */
async function turnOnTotp(call: ReturnType<typeof api>): Promise<string> {
	const { secret } = await call("account.create_totp_secret");
	await call("account.enable_totp", { code: await totpNow(secret) });
	return secret;
}

/** The body of the 401 that each refused sign-in gets. */
async function refusal(res: Response) {
	expect(res.status).toBe(401);
	expect(res.headers.get("set-cookie")).toBeNull();
	return ((await res.json()) as { detail?: string }).detail;
}

describe("first-run setup", () => {
	it("verifies the setup token without a session, also when the directory query fails", async () => {
		const unavailable = new Proxy(env.DIRECTORY, {
			get() {
				throw new Error("D1 is unavailable");
			},
		});
		const res = await withEnv({ DIRECTORY: unavailable }, "/auth/setup/verify", {
			method: "POST",
			headers: { authorization: `Bearer ${SETUP_TOKEN}`, origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("set-cookie")).toBeNull();
		// The page still offers a fresh start, because the directory state is not known.
		expect(await res.json()).toEqual({ directory: "unknown" });
	});

	it("tells the operator if setup without a reset can keep existing accounts", async () => {
		const verify = async () =>
			(
				await request("/auth/setup/verify", {
					method: "POST",
					headers: { authorization: `Bearer ${SETUP_TOKEN}`, origin: ORIGIN },
				})
			).json();
		expect(await verify()).toEqual({ directory: "empty" });
		await setupOwner();
		expect(await verify()).toEqual({ directory: "has_accounts" });
	});

	it.each([
		{ token: undefined, credential: SETUP_TOKEN, origin: ORIGIN, status: 503 },
		{ token: "short", credential: SETUP_TOKEN, origin: ORIGIN, status: 503 },
		{ token: SETUP_TOKEN, credential: "wrong", origin: ORIGIN, status: 401 },
		{ token: SETUP_TOKEN, credential: "", origin: ORIGIN, status: 401 },
		{ token: SETUP_TOKEN, credential: SETUP_TOKEN, origin: "https://evil.example", status: 403 },
	])(
		"refuses setup token verification for invalid credentials or origins ($status)",
		async ({ token, credential, origin, status }) => {
			const res = await withEnv({ SETUP_TOKEN: token }, "/auth/setup/verify", {
				method: "POST",
				headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), origin },
			});
			expect(res.status).toBe(status);
			expect(res.headers.get("set-cookie")).toBeNull();
		},
	);

	it("creates the owner once, only with the setup token, and only on a mail domain", async () => {
		expect((await setup("wrong", OWNER)).status).toBe(401);
		expect((await setup(SETUP_TOKEN, { ...OWNER, address: "x@elsewhere.example" })).status).toBe(400);
		expect((await setup(SETUP_TOKEN, { ...OWNER, address: "x+tag@dock.test" })).status).toBe(400);
		// The owner needs a password of at least 12 characters, and setup takes no sign-in email.
		expect(
			(await setup(SETUP_TOKEN, { mail_domain: "dock.test", display_name: "X", address: "x@dock.test" })).status,
		).toBe(400);
		expect((await setup(SETUP_TOKEN, { ...OWNER, password: "short pass" })).status).toBe(400);
		expect((await setup(SETUP_TOKEN, { ...OWNER, sign_in_email: "olive@home.example" })).status).toBe(400);
		const res = await setup(SETUP_TOKEN, OWNER);
		expect(res.status).toBe(201);
		// Without an Origin header (curl), setup makes no session.
		expect(res.headers.get("set-cookie")).toBeNull();
		const { api_key } = (await res.json()) as { api_key: { secret: string } };
		expect(await api(api_key.secret)("account.whoami")).toMatchObject({
			principal: { kind: "human", org_role: "owner", address: "owner@dock.test" },
			credential: "api_key",
			sign_in: { password_set: true, totp_enabled: false },
		});
		await signIn("owner@dock.test");
		const again = await setup(SETUP_TOKEN, { ...OWNER, display_name: "Mallory", address: "mallory@dock.test" });
		expect(again.status).toBe(409);
	});

	it("is off while the SETUP_TOKEN secret is missing or shorter than 32 characters", async () => {
		for (const [token, state] of [
			[undefined, "missing"],
			["a".repeat(31), "too_short"],
		] as const) {
			const status = await withEnv({ SETUP_TOKEN: token }, "/auth/setup");
			expect(await status.json()).toEqual({
				setup_needed: true,
				setup_token: state,
			});
			const res = await withEnv({ SETUP_TOKEN: token }, "/auth/setup", {
				method: "POST",
				headers: { authorization: `Bearer ${token ?? ""}`, "content-type": "application/json" },
				body: JSON.stringify(OWNER),
			});
			expect(res.status).toBe(503);
		}
	});

	it("offers a fresh start while the token is set, and hides setup after its removal", async () => {
		const before = await request("/auth/setup");
		expect(before.headers.get("cache-control")).toBe("no-store");
		expect(await before.json()).toEqual({
			setup_needed: true,
			setup_token: "ready",
			start_fresh_available: true,
		});
		await setupOwner();
		expect(await (await request("/auth/setup")).json()).toMatchObject({
			setup_needed: true,
			start_fresh_available: true,
		});
		expect(await (await withEnv({ SETUP_TOKEN: undefined }, "/auth/setup")).json()).toEqual({ setup_needed: false });
	});

	it("offers recovery without a query against the directory", async () => {
		const unavailable = new Proxy(env.DIRECTORY, {
			get() {
				throw new Error("D1 is unavailable");
			},
		});
		const res = await withEnv({ DIRECTORY: unavailable }, "/auth/setup", {
			headers: { cookie: "__Host-soldock_session=old-session" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ setup_needed: true, start_fresh_available: true });
	});

	it("replaces the directory and invalidates old keys, sessions, and passwords", async () => {
		const { owner, ada, bot } = await seedOrg();
		const cookie = await signIn(owner.address);
		const res = await setup(
			SETUP_TOKEN,
			{ ...OWNER, mail_domain: "new.example", address: "owner@new.example", start_fresh: "DELETE DIRECTORY" },
			ORIGIN,
		);
		expect(res.status).toBe(201);
		expect(res.headers.get("set-cookie")).toMatch(SESSION_COOKIE);
		const result = (await res.json()) as { principal: { id: string }; api_key: { secret: string } };
		expect(result.principal.id).not.toBe(owner.id);
		expect(await denied(api(owner.key)("account.whoami"))).toBe("unauthenticated");
		expect(await denied(api(bot.key)("account.whoami"))).toBe("unauthenticated");
		expect((await request("/api/v1/account", { headers: { cookie } })).status).toBe(401);
		expect((await request("/api/v1/account", { headers: { cookie: cookieOf(res) } })).status).toBe(200);
		expect(await api(result.api_key.secret)("account.whoami")).toMatchObject({
			principal: { id: result.principal.id },
		});
		expect(await api(result.api_key.secret)("directory.list_mail_domains")).toEqual({
			mail_domains: ["dock.test", "new.example", "second.test"],
		});
		expect(await env.DIRECTORY.prepare("SELECT COUNT(*) AS count FROM principals").first("count")).toBe(1);
		await refusal(await submitSignIn(ada.address, PASSWORD));
		await signIn("owner@new.example");
		expect((await setup(SETUP_TOKEN, OWNER)).status).toBe(409);
	});

	it("requires the token, same origin, explicit consent, and valid owner details before a reset", async () => {
		const owner = await setupOwner();
		const body = { ...OWNER, start_fresh: "DELETE DIRECTORY" };
		expect((await setup("wrong", body, ORIGIN)).status).toBe(401);
		expect((await setup(SETUP_TOKEN, body, "https://evil.example")).status).toBe(403);
		expect((await setup(SETUP_TOKEN, { ...body, start_fresh: true }, ORIGIN)).status).toBe(400);
		expect((await setup(SETUP_TOKEN, { ...body, password: "short" }, ORIGIN)).status).toBe(400);
		for (const token of [undefined, "short"]) {
			const res = await withEnv({ SETUP_TOKEN: token }, "/auth/setup", {
				method: "POST",
				headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(503);
		}
		expect(await api(owner.key)("account.whoami")).toMatchObject({ principal: { id: owner.id } });
	});

	it("rolls back the reset when the transaction fails", async () => {
		const owner = await setupOwner();
		const failing = new Proxy(env.DIRECTORY, {
			get(target, property) {
				if (property === "batch")
					return (statements: D1PreparedStatement[]) =>
						target.batch([...statements, target.prepare("SELECT json('invalid json')")]);
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const res = await withEnv({ DIRECTORY: failing }, "/auth/setup", {
			method: "POST",
			headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({
				...OWNER,
				mail_domain: "failed.example",
				address: "owner@failed.example",
				start_fresh: "DELETE DIRECTORY",
			}),
		});
		expect(res.status).toBe(500);
		expect(await owner.call("directory.list_mail_domains")).toEqual({ mail_domains: ["dock.test", "second.test"] });
		expect(await api(owner.key)("account.whoami")).toMatchObject({ principal: { id: owner.id } });
		expect(
			(await owner.call("mail.send", { to: ["owner@dock.test"], text: "The mailbox resumed" })).recipients,
		).toMatchObject([{ status: "delivered" }]);
	});

	it("recreates the old schema that lacks sign_in_email and supports a new session", async () => {
		await env.DIRECTORY.batch([
			...["sessions", "api_keys", "addresses", "principals"].map((name) => env.DIRECTORY.prepare(`DROP TABLE ${name}`)),
			...legacyDirectory
				.split(";")
				.map((sql) => sql.trim())
				.filter(Boolean)
				.map((sql) => env.DIRECTORY.prepare(sql)),
			env.DIRECTORY.prepare(
				"INSERT INTO principals (id, kind, display_name, org_role, created_at) VALUES ('old', 'human', 'Old owner', 'owner', '2026-01-01')",
			),
		]);
		const res = await setup(SETUP_TOKEN, { ...OWNER, start_fresh: "DELETE DIRECTORY" }, ORIGIN);
		expect(res.status).toBe(201);
		expect((await request("/api/v1/account", { headers: { cookie: cookieOf(res) } })).status).toBe(200);
		expect(await env.DIRECTORY.prepare("SELECT name FROM d1_migrations").first("name")).toBe("0001_directory.sql");
		await signIn(OWNER.address);
	});

	// A fresh start replays the bundled migrations. If wrangler ran 0004 again later, it would copy the
	// principals without their passwords.
	it("records the migrations that a fresh start replays, so a later migration run keeps passwords", async () => {
		await setupOwner();
		// A directory one migration behind the Worker, as after a deploy before `migrations apply`.
		await env.DIRECTORY.prepare("DELETE FROM d1_migrations WHERE name = '0004_password_sign_in.sql'").run();
		const res = await setup(SETUP_TOKEN, { ...OWNER, start_fresh: "DELETE DIRECTORY" }, ORIGIN);
		expect(res.status).toBe(201);
		await applyD1Migrations(env.DIRECTORY, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
		await signIn(OWNER.address);
	});

	// The owner and the key exist after the first D1 batch, so setup cannot run again. If the session
	// batch then fails, the response must still hold the key, or nobody can sign in.
	it("returns the key without a session when the session after setup fails", async () => {
		let batches = 0;
		const failing = new Proxy(env.DIRECTORY, {
			get(target, property) {
				if (property === "batch") {
					return (statements: D1PreparedStatement[]) => {
						batches += 1;
						if (batches === 2) return Promise.reject(new Error("D1_ERROR: storage overloaded"));
						return target.batch(statements);
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const res = await withEnv({ DIRECTORY: failing }, "/auth/setup", {
			method: "POST",
			headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify(OWNER),
		});
		expect(batches).toBe(2);
		expect(res.status).toBe(201);
		expect(res.headers.get("set-cookie")).toBeNull();
		const { api_key } = (await res.json()) as { api_key: { secret: string } };
		expect(await api(api_key.secret)("account.whoami")).toMatchObject({ principal: { org_role: "owner" } });
	});

	it("signs the owner in when setup runs from the web app, and refuses another origin", async () => {
		const forged = await setup(SETUP_TOKEN, OWNER, "https://evil.example");
		expect(forged.status).toBe(403);
		expect(await (await request("/auth/setup")).json()).toMatchObject({ setup_needed: true });

		const res = await setup(SETUP_TOKEN, OWNER, ORIGIN);
		expect(res.status).toBe(201);
		expect(res.headers.get("set-cookie")).toMatch(SESSION_COOKIE);
		const { principal } = (await res.json()) as { principal: { id: string } };
		const whoami = await request("/api/v1/account", { headers: { cookie: cookieOf(res) } });
		expect(await whoami.json()).toMatchObject({
			credential: "session",
			principal: { id: principal.id, org_role: "owner" },
		});
	});
});

describe("credentials", () => {
	it("answers a request without a valid key with 401 and a Bearer challenge", async () => {
		for (const authorization of [undefined, "Bearer sdk_not-a-key", "Basic abc"]) {
			const res = await request("/api/v1/account", authorization ? { headers: { authorization } } : {});
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toBe('Bearer realm="soldock"');
		}
	});

	it("stops accepting a key as soon as it is revoked", async () => {
		const owner = await setupOwner();
		const { api_key } = await owner.call("account.create_api_key", { label: "temp", scopes: ["account.read"] });
		const temp = api(api_key.secret);
		await temp("account.whoami");
		await owner.call("account.revoke_api_key", { key_id: api_key.id });
		expect(await denied(temp("account.whoami"))).toBe("unauthenticated");
	});

	it("limits a key to its scopes, and a narrow key cannot mint a wider one", async () => {
		const owner = await setupOwner();
		const { api_key } = await owner.call("account.create_api_key", {
			label: "narrow",
			scopes: ["account.keys", "mail.read"],
		});
		const narrow = api(api_key.secret);
		await narrow("mail.list_threads");
		expect(await denied(narrow("mail.create_label", { name: "x" }))).toBe("forbidden");
		expect(await denied(narrow("account.create_api_key", { label: "wide", scopes: ["mail.send"] }))).toBe("forbidden");
	});
});

describe("sign-in with a password", () => {
	it("signs a person in with the address and the password, with every human scope", async () => {
		await setupOwner();
		const res = await submitSignIn("Owner@Dock.TEST", PASSWORD);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "signed_in" });
		expect(res.headers.get("set-cookie")).toMatch(SESSION_COOKIE);
		const whoami = await request("/api/v1/account", { headers: { cookie: cookieOf(res) } });
		const body = (await whoami.json()) as { credential: string; scopes: string[]; sign_in: unknown };
		expect(body).toMatchObject({ credential: "session", sign_in: { password_set: true, totp_enabled: false } });
		expect(body.scopes.sort()).toEqual([...ALL_SCOPES].sort());
	});

	// The answer must not tell an attacker which part is wrong, or which addresses have an account.
	it("gives the same 401 for an unknown address, an agent, and a wrong password, and refuses another origin", async () => {
		const { owner, bot } = await seedOrg();
		const details = new Set<string | undefined>();
		for (const [address, password] of [
			["nobody@dock.test", PASSWORD],
			[bot.address, PASSWORD],
			[owner.address, `${PASSWORD}!`],
			[owner.address, "x"],
		] as const) {
			details.add(await refusal(await submitSignIn(address, password)));
		}
		expect(details.size).toBe(1);
		for (const origin of ["https://evil.example", null]) {
			expect((await submitSignIn(owner.address, PASSWORD, { origin })).status).toBe(403);
		}
		expect((await submitSignIn("not an address", PASSWORD)).status).toBe(400);
		expect((await submitSignIn(owner.address, "")).status).toBe(400);
	});

	// A password is safe only while the number of guesses stays small.
	it("locks sign-in for 15 minutes after 10 failed attempts, also for parallel guesses", async () => {
		const owner = await setupOwner();
		// A success starts the count again, so a person who sometimes mistypes is never locked.
		for (let round = 0; round < 2; round++) {
			await Promise.all(Array.from({ length: 9 }, () => submitSignIn(owner.address, "wrong password")));
			await signIn(owner.address);
		}
		const guesses = await Promise.all(
			Array.from({ length: 10 }, () => submitSignIn(owner.address, "wrong password").then((res) => res.status)),
		);
		expect(guesses).toEqual(Array(10).fill(401));
		await refusal(await submitSignIn(owner.address, PASSWORD));
		// The API key still works during the lock.
		await owner.call("account.whoami");
		await env.DIRECTORY.prepare("UPDATE principals SET sign_in_locked_until = ? WHERE id = ?")
			.bind(new Date(Date.now() - 1).toISOString(), owner.id)
			.run();
		await signIn(owner.address);
	});

	it("asks for a TOTP code after a correct password, and a code works one time", async () => {
		const owner = await setupOwner();
		const secret = await turnOnTotp(owner.call);
		expect((await owner.call("account.whoami")).sign_in).toEqual({ password_set: true, totp_enabled: true });
		const first = await submitSignIn(owner.address, PASSWORD);
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ status: "totp_required" });
		expect(first.headers.get("set-cookie")).toBeNull();
		// The code that turned on two-step verification is used, so the next code signs in.
		const code = await totpNow(secret, 1);
		const wrongPassword = await refusal(await submitSignIn(owner.address, "wrong password", { totpCode: code }));
		expect(await refusal(await submitSignIn(owner.address, PASSWORD, { totpCode: wrong(code) }))).toBe(wrongPassword);
		const signedIn = await submitSignIn(owner.address, PASSWORD, { totpCode: ` ${code.slice(0, 3)} ${code.slice(3)}` });
		expect(await signedIn.json()).toEqual({ status: "signed_in" });
		expect(signedIn.headers.get("set-cookie")).toMatch(SESSION_COOKIE);
		await refusal(await submitSignIn(owner.address, PASSWORD, { totpCode: code }));
		expect((await submitSignIn(owner.address, PASSWORD, { totpCode: "12345" })).status).toBe(400);
	});

	// A password change, or a second request with the same code, can land while a sign-in checks the
	// password. The tests run requests one at a time, so a D1 proxy plays the other request: it makes its
	// change just before the batch that would create the session.
	it.each([
		{ race: "a parallel sign-in used the code", totp: true, change: "totp_last_step = totp_last_step + 1" },
		{ race: "the password changed", totp: false, change: "password_hash = 'changed'" },
		{ race: "two-step verification turned on", totp: false, change: "totp_secret = 'GEZDGNBVGY3TQOJQ'" },
	])("refuses the sign-in and makes no session when $race during the check", async ({ totp, change }) => {
		const owner = await setupOwner();
		const secret = totp ? await turnOnTotp(owner.call) : null;
		const racing = new Proxy(env.DIRECTORY, {
			get(target, property) {
				if (property === "batch") {
					return async (statements: D1PreparedStatement[]) => {
						await target.prepare(`UPDATE principals SET ${change} WHERE id = ?`).bind(owner.id).run();
						return target.batch(statements);
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const res = await withEnv({ DIRECTORY: racing }, "/auth/session", {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({
				address: owner.address,
				password: PASSWORD,
				...(secret ? { totp_code: await totpNow(secret, 1) } : {}),
			}),
		});
		await refusal(res);
		expect(await env.DIRECTORY.prepare("SELECT COUNT(*) AS count FROM sessions").first("count")).toBe(0);
	});

	// Authenticator apps compute codes with RFC 6238, so the server must give the same codes.
	it.each([
		[59, "287082"],
		[1111111109, "081804"],
		[1111111111, "050471"],
		[1234567890, "005924"],
		[2000000000, "279037"],
		[20000000000, "353130"],
	])("gives the RFC 6238 code at %i seconds", async (seconds, code) => {
		// The base32 form of the RFC test key "12345678901234567890".
		expect(await totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", Math.floor(seconds / 30))).toBe(code);
	});

	// A clock can be a little wrong, but each extra step lets a stolen code work for longer.
	it("accepts a code from one step before or after the current step, and no further", async () => {
		const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
		const step = 1000;
		const now = step * 30_000 + 15_000;
		const at = async (offset: number) => matchTotp(secret, await totpCode(secret, step + offset), null, now);
		expect(await Promise.all([-1, 0, 1].map(at))).toEqual([step - 1, step, step + 1]);
		expect(await Promise.all([-2, 2].map(at))).toEqual([null, null]);
	});

	it("refuses a large sign-in body while it streams, before any lookup", async () => {
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				if (pulled > 40) controller.close();
				else controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
			},
		});
		const res = await request("/auth/session", {
			method: "POST",
			headers: { origin: ORIGIN, "content-type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit);
		expect(res.status).toBe(413);
		expect(pulled).toBeLessThan(5);
	});

	// SameSite=Lax still sends the cookie on some cross-site requests, so changes also need the Origin.
	it("refuses a change made with the cookie unless it comes from this origin", async () => {
		const owner = await setupOwner();
		const cookie = await signIn(owner.address);
		const create = (headers: Record<string, string>) =>
			request("/api/v1/mail/labels", {
				method: "POST",
				headers: { cookie, "content-type": "application/json", ...headers },
				body: JSON.stringify({ name: "Receipts" }),
			});
		expect((await create({})).status).toBe(403);
		expect((await create({ origin: "https://evil.example" })).status).toBe(403);
		expect((await create({ origin: ORIGIN })).status).toBe(200);
	});

	it("ends the session on sign-out", async () => {
		const owner = await setupOwner();
		const cookie = await signIn(owner.address);
		const out = await request("/auth/sign-out", { method: "POST", headers: { cookie, origin: ORIGIN } });
		expect(out.status).toBe(204);
		expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
		expect((await request("/api/v1/account", { headers: { cookie } })).status).toBe(401);
	});
});

describe("passwords", () => {
	// A new password is the way to lock out somebody who knew the old one, so it ends the other sessions.
	it("lets a person change their own password with a full credential, and ends their other sessions", async () => {
		const owner = await setupOwner();
		const here = await signIn(owner.address);
		const elsewhere = await signIn(owner.address);
		const res = await postWithCookie(here, "password", { password: "a new long password", current_password: PASSWORD });
		expect(await res.json()).toEqual({ principal_id: owner.id });
		expect((await request("/api/v1/account", { headers: { cookie: here } })).status).toBe(200);
		expect((await request("/api/v1/account", { headers: { cookie: elsewhere } })).status).toBe(401);
		await refusal(await submitSignIn(owner.address, PASSWORD));
		await signIn(owner.address, "a new long password");
		expect((await postWithCookie(here, "password", { password: "too short" })).status).toBe(400);
	});

	// A stolen session cookie must not replace the password or the second step. An API key with every
	// human scope stays the recovery credential, so it needs no current password.
	it("asks a browser session for the current password before it changes its own sign-in", async () => {
		const owner = await setupOwner();
		const here = await signIn(owner.address);
		const elsewhere = await signIn(owner.address);
		const password = { password: "a new long password" };
		expect((await postWithCookie(here, "password", password)).status).toBe(403);
		expect((await postWithCookie(here, "password", { ...password, current_password: "a wrong one" })).status).toBe(403);
		const { secret } = (await (await postWithCookie(here, "totp/secret")).json()) as { secret: string };
		const code = { code: await totpNow(secret) };
		expect((await postWithCookie(here, "totp/enable", code)).status).toBe(403);
		expect((await postWithCookie(here, "totp/enable", { ...code, current_password: PASSWORD })).status).toBe(200);
		// Turning on the second step also ends the other sessions.
		expect((await request("/api/v1/account", { headers: { cookie: elsewhere } })).status).toBe(401);
		expect((await postWithCookie(here, "totp/disable")).status).toBe(403);
		expect((await postWithCookie(here, "totp/disable", { current_password: PASSWORD })).status).toBe(200);
		await refusal(await submitSignIn(owner.address, "a new long password"));
		// Wrong current passwords count toward the sign-in lock, like wrong sign-ins.
		await Promise.all(
			Array.from({ length: 10 }, () => postWithCookie(here, "totp/disable", { current_password: "a wrong one" })),
		);
		await refusal(await submitSignIn(owner.address, PASSWORD));
		await owner.call("account.set_password", password);
		await signIn(owner.address, password.password);
	});

	// A sign-in gives every human scope, so a narrow key must not choose how a person signs in.
	it("refuses a credential that does not hold every human scope", async () => {
		const owner = await setupOwner();
		const { api_key } = await owner.call("account.create_api_key", {
			label: "keys only",
			scopes: ["account.keys", "directory.write"],
		});
		const narrow = api(api_key.secret);
		expect(await denied(narrow("account.set_password", { password: "mallory's password" }))).toBe("forbidden");
		expect(await denied(narrow("account.create_totp_secret"))).toBe("forbidden");
		expect(await denied(narrow("account.enable_totp", { code: "123456" }))).toBe("forbidden");
		expect(await denied(narrow("account.disable_totp"))).toBe("forbidden");
		expect(
			await denied(
				narrow("directory.create_principal", {
					kind: "human",
					display_name: "Mallory",
					address: "mallory@dock.test",
					password: "mallory's password",
				}),
			),
		).toBe("forbidden");
		await refusal(await submitSignIn("mallory@dock.test", "mallory's password"));
	});

	it("lets admins set the password of others except the owner, which also clears a lock", async () => {
		const { owner, ada, bot } = await seedOrg();
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Ann",
			address: "ann@dock.test",
			org_role: "admin",
			password: PASSWORD,
		});
		const adaSession = await signIn(ada.address);
		await Promise.all(Array.from({ length: 10 }, () => submitSignIn(ada.address, "wrong password")));
		await refusal(await submitSignIn(ada.address, PASSWORD));
		await admin.call("account.set_password", { principal_id: ada.id, password: "ada's new password" });
		expect((await request("/api/v1/account", { headers: { cookie: adaSession } })).status).toBe(401);
		await signIn(ada.address, "ada's new password");
		expect(
			await denied(admin.call("account.set_password", { principal_id: owner.id, password: "taken over now" })),
		).toBe("forbidden");
		expect(await denied(ada.call("account.set_password", { principal_id: admin.id, password: "taken over now" }))).toBe(
			"forbidden",
		);
		expect(await denied(ada.call("account.set_password", { principal_id: bot.id, password: "agents have none" }))).toBe(
			"invalid",
		);
		// MCP gives the same operation, with the same rules.
		const tool = await callTool(admin.key, "account_set_password", {
			principal_id: ada.id,
			password: "third password!",
		});
		expect(tool.structuredContent).toEqual({ principal_id: ada.id });
		await signIn(ada.address, "third password!");
		expect(
			(await callTool(admin.key, "account_set_password", { principal_id: owner.id, password: "taken over now" }))
				.isError,
		).toBe(true);
		expect(await denied(bot.call("account.set_password", { password: "agents have none" }))).toBe("forbidden");
	});
});

/**
 * A D1 binding that runs `change` just before the batch or the write that a call makes, as a request
 * that lands during the call would. `write` names the SQL of a write that is not in a batch.
 */
function racing(change: string, bind: string, write?: string) {
	const run = () => env.DIRECTORY.prepare(change).bind(bind).run();
	return new Proxy(env.DIRECTORY, {
		get(target, property) {
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					await run();
					return target.batch(statements);
				};
			}
			if (property === "prepare") {
				return (sql: string) => {
					const statement = target.prepare(sql);
					if (!write || !sql.includes(write)) return statement;
					return {
						bind: (...values: unknown[]) => ({ run: async () => (await run(), statement.bind(...values).run()) }),
					};
				};
			}
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("sessions that end during a change", () => {
	// A reset by an admin ends the sessions of a person. A slow request from one of those sessions must
	// not commit after it, or the holder of a stolen session chooses the new sign-in.
	it.each([
		{ op: "password", body: () => ({ password: "the attacker's choice" }), status: 401 },
		{ op: "totp/disable", body: () => ({ current_password: PASSWORD }), status: 401 },
		{
			op: "totp/enable",
			body: async (secret: string) => ({ code: await totpNow(secret), current_password: PASSWORD }),
			status: 409,
		},
	])("refuses $op from a session that a reset ended during the request", async ({ op, body, status }) => {
		const owner = await setupOwner();
		const { secret } = await owner.call("account.create_totp_secret");
		// Turning on the second step ends each session, so it comes before the sign-in.
		if (op === "totp/disable") await owner.call("account.enable_totp", { code: await totpNow(secret) });
		const signedIn = await submitSignIn(owner.address, PASSWORD, {
			...(op === "totp/disable" ? { totpCode: await totpNow(secret, 1) } : {}),
		});
		const cookie = cookieOf(signedIn);
		// A person from before the upgrade has no password, so no current password protects the change.
		if (op === "password") await env.DIRECTORY.prepare("UPDATE principals SET password_hash = NULL").run();
		const before = await env.DIRECTORY.prepare("SELECT password_hash, totp_secret FROM principals").first();
		const res = await withEnv(
			{ DIRECTORY: racing("DELETE FROM sessions WHERE principal_id = ?", owner.id, "SET totp_secret = NULL") },
			`/api/v1/account/${op}`,
			{
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify(await body(secret)),
			},
		);
		expect(res.status).toBe(status);
		// The session was live at authentication, so the refusal comes from the write.
		expect(((await res.json()) as { detail: string }).detail).toMatch(/session ended/);
		expect(await env.DIRECTORY.prepare("SELECT password_hash, totp_secret FROM principals").first()).toEqual(before);
	});

	// Two clicks can send the same code twice. The request that loses changes nothing, also no session.
	it("ends no session when a parallel request turned on two-step verification first", async () => {
		const owner = await setupOwner();
		const here = await signIn(owner.address);
		const elsewhere = await signIn(owner.address);
		const { secret } = await owner.call("account.create_totp_secret");
		const winner = "UPDATE principals SET totp_secret = totp_pending_secret, totp_pending_secret = NULL WHERE id = ?";
		const res = await withEnv({ DIRECTORY: racing(winner, owner.id) }, "/api/v1/account/totp/enable", {
			method: "POST",
			headers: { cookie: here, origin: ORIGIN, "content-type": "application/json" },
			body: JSON.stringify({ code: await totpNow(secret), current_password: PASSWORD }),
		});
		expect(res.status).toBe(409);
		expect((await request("/api/v1/account", { headers: { cookie: elsewhere } })).status).toBe(200);
	});
});

describe("two-step verification", () => {
	it("turns on only with a correct code for the newest secret", async () => {
		const owner = await setupOwner();
		expect(await denied(owner.call("account.enable_totp", { code: "123456" }))).toBe("conflict");
		const first = await owner.call("account.create_totp_secret");
		expect(first.secret).toMatch(/^[A-Z2-7]{32}$/);
		const uri = new URL(first.otpauth_uri);
		expect(`${uri.protocol}//${uri.host}${decodeURIComponent(uri.pathname)}`).toBe(
			"otpauth://totp/Soldock:owner@dock.test",
		);
		expect(Object.fromEntries(uri.searchParams)).toEqual({
			secret: first.secret,
			issuer: "Soldock",
			algorithm: "SHA1",
			digits: "6",
			period: "30",
		});
		expect(await denied(owner.call("account.enable_totp", { code: wrong(await totpNow(first.secret)) }))).toBe(
			"invalid",
		);
		// A new secret replaces the one that waits, so a code for the first secret does nothing.
		const second = await owner.call("account.create_totp_secret");
		expect(await denied(owner.call("account.enable_totp", { code: await totpNow(first.secret) }))).toBe("invalid");
		expect((await owner.call("account.whoami")).sign_in).toEqual({ password_set: true, totp_enabled: false });
		await signIn(owner.address);
		expect(await owner.call("account.enable_totp", { code: await totpNow(second.secret) })).toEqual({
			totp_enabled: true,
		});
		expect(await (await submitSignIn(owner.address, PASSWORD)).json()).toEqual({ status: "totp_required" });
	});

	it("lets the person or an admin turn it off, but only the owner turns off the owner's", async () => {
		const { owner, ada } = await seedOrg();
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Ann",
			address: "ann@dock.test",
			org_role: "admin",
			password: PASSWORD,
		});
		await turnOnTotp(ada.call);
		await turnOnTotp(owner.call);
		expect(await admin.call("account.disable_totp", { principal_id: ada.id })).toEqual({
			principal_id: ada.id,
			totp_enabled: false,
		});
		await signIn(ada.address);
		expect(await denied(admin.call("account.disable_totp", { principal_id: owner.id }))).toBe("forbidden");
		expect(await denied(ada.call("account.disable_totp", { principal_id: owner.id }))).toBe("forbidden");
		expect(await (await submitSignIn(owner.address, PASSWORD)).json()).toEqual({ status: "totp_required" });
		const tool = await callTool(owner.key, "account_disable_totp", {});
		expect(tool.structuredContent).toEqual({ principal_id: owner.id, totp_enabled: false });
		await signIn(owner.address);
	});
});

describe("directory upgrade", () => {
	// Production directories have sign-in emails. The migration must keep each account, key and session.
	it("moves a directory with sign-in emails to passwords, and keeps keys, sessions, agents and the old columns", async () => {
		const db = env.DIRECTORY;
		const run = (statements: string[]) => db.batch(statements.map((sql) => db.prepare(sql)));
		await run([
			"DROP TABLE sign_in_codes",
			"DROP TABLE sessions",
			"DROP TABLE api_keys",
			"DROP TABLE addresses",
			"DROP TABLE principals",
			"DROP TABLE mail_domains",
		]);
		await run([
			...baseMigration
				.replace(/--[^\n]*/g, "")
				.split(";")
				.map((sql) => sql.trim())
				.filter(Boolean),
			...domainMigration.split("--> statement-breakpoint"),
		]);
		const key = "sdk_upgrade-key-0123456789abcdefghijklmnopqrstuvw";
		const session = "upgrade-session-token";
		const hash = async (value: string) =>
			[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join("");
		await run([
			"INSERT INTO mail_domains (domain) VALUES ('dock.test')",
			`INSERT INTO principals (id, kind, display_name, org_role, sign_in_email, created_at)
				VALUES ('prn_owner', 'human', 'Olive', 'owner', 'olive@home.example', '2026-01-01T00:00:00.000Z')`,
			`INSERT INTO principals (id, kind, display_name, sponsor_id, outbound_mode, created_at)
				VALUES ('prn_bot', 'agent', 'Bot', 'prn_owner', 'internal-only', '2026-01-01T00:00:00.000Z')`,
			"INSERT INTO addresses VALUES ('owner@dock.test', 'prn_owner', 1, '2026-01-01T00:00:00.000Z')",
			"INSERT INTO addresses VALUES ('bot@dock.test', 'prn_bot', 1, '2026-01-01T00:00:00.000Z')",
			`INSERT INTO api_keys (id, principal_id, key_hash, label, scopes, created_by, created_at)
				VALUES ('key_owner', 'prn_owner', '${await hash(key)}', 'Setup', '${JSON.stringify(ALL_SCOPES)}', 'prn_owner', '2026-01-01T00:00:00.000Z')`,
			`INSERT INTO sessions VALUES ('${await hash(session)}', 'prn_owner', '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')`,
			`INSERT INTO sign_in_codes VALUES ('sic_1', 'prn_owner', 'x', 0, '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z', NULL)`,
		]);
		await run(passwordMigration.split("--> statement-breakpoint"));

		const owner = api(key);
		expect(await owner("account.whoami")).toMatchObject({
			principal: { id: "prn_owner", address: "owner@dock.test" },
			sign_in: { password_set: false, totp_enabled: false },
		});
		const cookie = `__Host-soldock_session=${session}`;
		expect((await request("/api/v1/account", { headers: { cookie } })).status).toBe(200);
		expect((await owner("directory.list_principals")).principals).toMatchObject([
			{ id: "prn_bot", sponsor_id: "prn_owner" },
			{ id: "prn_owner" },
		]);
		expect(await db.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
		// The deploy migrates while the old Worker runs. It reads the sign-in email and writes codes, so
		// the column and the table stay until a later migration, empty. A kept address could receive codes
		// after a rollback, so the values go.
		expect(await db.prepare("SELECT sign_in_email FROM principals WHERE id = 'prn_owner'").first()).toEqual({
			sign_in_email: null,
		});
		expect(await db.prepare("SELECT COUNT(*) AS count FROM sign_in_codes").first("count")).toBe(0);
		await db
			.prepare("INSERT INTO sign_in_codes VALUES ('sic_2', 'prn_owner', 'x', 0, '2026-01-01', '2999-01-01', NULL)")
			.run();
		// Without a password, the person signs in after somebody sets one: the person in a kept session,
		// or the owner with the setup key.
		await refusal(await submitSignIn("owner@dock.test", "olive@home.example"));
		await owner("account.set_password", { password: PASSWORD });
		await signIn("owner@dock.test");
		// The domain rules and the foreign keys still apply.
		expect(await denied(owner("directory.remove_mail_domain", { domain: "dock.test" }))).toBe("conflict");
		await expect(
			db.prepare("INSERT INTO addresses VALUES ('ghost@dock.test', 'prn_nobody', 1, '2026-01-01')").run(),
		).rejects.toThrow(/FOREIGN KEY/);
	});
});

describe("directory authorization", () => {
	it("lets only owners and admins create principals", async () => {
		const { owner, ada, bot } = await seedOrg();
		const input = {
			kind: "human",
			display_name: "Eve",
			address: "eve@dock.test",
			password: PASSWORD,
		} as const;
		expect(await denied(ada.call("directory.create_principal", input))).toBe("forbidden");
		expect(await denied(bot.call("directory.create_principal", input))).toBe("forbidden");
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Ann Admin",
			address: "ann@dock.test",
			org_role: "admin",
			password: PASSWORD,
		});
		await admin.call("directory.create_principal", input);
	});

	it("gives a new agent a human sponsor and the internal-only policy, and validates the address", async () => {
		const owner = await setupOwner();
		const { principal } = await owner.call("directory.create_principal", {
			kind: "agent",
			display_name: "Helper",
			address: "helper@dock.test",
		});
		expect(principal).toMatchObject({
			kind: "agent",
			org_role: null,
			sponsor_id: owner.id,
			outbound_policy: { mode: "internal-only", allowlist: [] },
		});
		const create = (address: string, password: string | null = PASSWORD) =>
			owner.call("directory.create_principal", {
				kind: "human",
				display_name: "X",
				address,
				...(password ? { password } : {}),
			});
		expect(await denied(create("x@not-ours.example"))).toBe("invalid");
		expect(await denied(create("x+tag@dock.test"))).toBe("invalid");
		expect(await denied(create("HELPER@dock.test"))).toBe("conflict");
		// A person needs a password of at least 12 characters. An agent has none.
		expect(await denied(create("x@dock.test", null))).toBe("invalid");
		expect(await denied(create("x@dock.test", "eleven char"))).toBe("invalid");
		expect(
			await denied(
				owner.call("directory.create_principal", {
					kind: "agent",
					display_name: "Z",
					address: "z@dock.test",
					password: PASSWORD,
				}),
			),
		).toBe("invalid");
		expect(
			await denied(
				owner.call("directory.create_principal", {
					kind: "agent",
					display_name: "Y",
					address: "y@dock.test",
					sponsor_id: principal.id,
				}),
			),
		).toBe("invalid");
	});

	it("lets the sponsor and admins change an agent's policy, and never the agent or another member", async () => {
		const { owner, ada, bot } = await seedOrg();
		const other = await createActor(owner, {
			kind: "human",
			display_name: "Bob",
			address: "bob@dock.test",
			password: PASSWORD,
		});
		const change = (mode: "any" | "internal-only") => ({ principal_id: bot.id, mode });
		await ada.call("directory.update_agent_policy", change("any"));
		await owner.call("directory.update_agent_policy", change("internal-only"));
		expect(await denied(other.call("directory.update_agent_policy", change("any")))).toBe("forbidden");
		expect(await denied(bot.call("directory.update_agent_policy", change("any")))).toBe("forbidden");
		// The MCP surface does not offer the tool to the agent, and refuses a direct call.
		const tool = await mcp(bot.key, "tools/call", {
			name: "directory_update_agent_policy",
			arguments: change("any"),
		});
		expect(tool.body).toMatchObject({ error: { code: -32602 } });
		const { principals } = await owner.call("directory.list_principals");
		expect(principals.find((p) => p.id === bot.id)?.outbound_policy?.mode).toBe("internal-only");
	});

	it("lets the sponsor manage an agent's keys within agent scopes, and nobody else but admins", async () => {
		const { ada, bot, owner } = await seedOrg();
		const other = await createActor(owner, {
			kind: "human",
			display_name: "Bob",
			address: "bob@dock.test",
			password: PASSWORD,
		});
		const { api_key } = await ada.call("account.create_api_key", {
			principal_id: bot.id,
			label: "reader",
			scopes: ["mail.read"],
		});
		expect(api_key.principal_id).toBe(bot.id);
		expect(
			await denied(
				ada.call("account.create_api_key", { principal_id: bot.id, label: "x", scopes: ["directory.write"] }),
			),
		).toBe("invalid");
		expect(
			await denied(other.call("account.create_api_key", { principal_id: bot.id, label: "x", scopes: ["mail.read"] })),
		).toBe("forbidden");
		expect(await denied(other.call("account.list_api_keys", { principal_id: ada.id }))).toBe("forbidden");
		expect(await denied(other.call("account.revoke_api_key", { key_id: api_key.id }))).toBe("forbidden");
		// An admin manages other people's keys, but never the owner's: that would let it act as the owner.
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Ann",
			address: "ann@dock.test",
			org_role: "admin",
			password: PASSWORD,
		});
		await admin.call("account.list_api_keys", { principal_id: ada.id });
		expect(await denied(admin.call("account.list_api_keys", { principal_id: owner.id }))).toBe("forbidden");
		expect(
			await denied(admin.call("account.create_api_key", { principal_id: owner.id, label: "x", scopes: ["mail.read"] })),
		).toBe("forbidden");
		// An agent has no account.keys scope at all, so it cannot mint or revoke keys.
		expect(await denied(bot.call("account.list_api_keys"))).toBe("forbidden");
		const tool = await callTool(owner.key, "account_list_api_keys", { principal_id: bot.id });
		expect((tool.structuredContent?.api_keys ?? []) as unknown[]).toHaveLength(2);
	});
});

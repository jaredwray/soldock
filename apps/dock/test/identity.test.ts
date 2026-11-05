import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ALL_SCOPES, ApiError } from "@soldock/contracts";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import legacyDirectory from "./fixtures/directory-v1.sql?raw";
import {
	api,
	callTool,
	codeIn,
	cookieOf,
	createActor,
	mcp,
	ORIGIN,
	OWNER_SIGN_IN_EMAIL,
	request,
	requestCode,
	SETUP_TOKEN,
	seedOrg,
	setupOwner,
	signIn,
	submitCode,
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
	sign_in_email: OWNER_SIGN_IN_EMAIL,
};

const SESSION_COOKIE =
	/^__Host-soldock_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/;

/** A different code of the same length. */
function wrong(code: string): string {
	return String((Number(code) + 1) % 10 ** code.length).padStart(code.length, "0");
}

/** Changes the sign-in email with a session cookie, as the web app does. */
function setSignInEmailWithCookie(cookie: string, body: Record<string, string>) {
	return request("/api/v1/account/sign-in-email", {
		method: "POST",
		headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("first-run setup", () => {
	it("verifies the setup token before the choices without a directory query or a session", async () => {
		const unavailable = new Proxy(env.DIRECTORY, {
			get() {
				throw new Error("D1 is unavailable");
			},
		});
		const res = await withEnv({ DIRECTORY: unavailable }, "/auth/setup/verify", {
			method: "POST",
			headers: { authorization: `Bearer ${SETUP_TOKEN}`, origin: ORIGIN },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("set-cookie")).toBeNull();
		expect(await res.text()).toBe("");
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
		// The owner needs a sign-in email, outside the mail domains: a code in a Soldock mailbox cannot be read.
		expect(
			(await setup(SETUP_TOKEN, { mail_domain: "dock.test", display_name: "X", address: "x@dock.test" })).status,
		).toBe(400);
		expect((await setup(SETUP_TOKEN, { ...OWNER, sign_in_email: "olive@dock.test" })).status).toBe(400);
		const res = await setup(SETUP_TOKEN, OWNER);
		expect(res.status).toBe(201);
		// Without an Origin header (curl), setup makes no session.
		expect(res.headers.get("set-cookie")).toBeNull();
		const { api_key } = (await res.json()) as { api_key: { secret: string } };
		expect(await api(api_key.secret)("account.whoami")).toMatchObject({
			principal: { kind: "human", org_role: "owner", address: "owner@dock.test" },
			credential: "api_key",
		});
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

	it("replaces the directory and invalidates old keys, sessions, and sign-in codes", async () => {
		const { owner, bot } = await seedOrg();
		const cookie = await signIn(OWNER_SIGN_IN_EMAIL);
		await requestCode(OWNER_SIGN_IN_EMAIL);
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
		expect(
			await denied(api(result.api_key.secret)("account.set_sign_in_email", { sign_in_email: "owner@new.example" })),
		).toBe("invalid");
		expect(await env.DIRECTORY.prepare("SELECT COUNT(*) AS count FROM principals").first("count")).toBe(1);
		expect(await env.DIRECTORY.prepare("SELECT COUNT(*) AS count FROM sign_in_codes").first("count")).toBe(0);
		expect((await setup(SETUP_TOKEN, OWNER)).status).toBe(409);
	});

	it("requires the token, same origin, explicit consent, and valid owner details before a reset", async () => {
		const owner = await setupOwner();
		const body = { ...OWNER, start_fresh: "DELETE DIRECTORY" };
		expect((await setup("wrong", body, ORIGIN)).status).toBe(401);
		expect((await setup(SETUP_TOKEN, body, "https://evil.example")).status).toBe(403);
		expect((await setup(SETUP_TOKEN, { ...body, start_fresh: true }, ORIGIN)).status).toBe(400);
		expect((await setup(SETUP_TOKEN, { ...body, sign_in_email: "owner@dock.test" }, ORIGIN)).status).toBe(400);
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
			...["sessions", "sign_in_codes", "api_keys", "addresses", "principals"].map((name) =>
				env.DIRECTORY.prepare(`DROP TABLE ${name}`),
			),
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
		const { sent } = await requestCode(OWNER_SIGN_IN_EMAIL);
		expect(sent).toHaveLength(1);
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

describe("sign-in with a code", () => {
	it("sends a code to the sign-in email, and the code signs the person in once, with every human scope", async () => {
		await setupOwner();
		const { res, sent } = await requestCode(OWNER_SIGN_IN_EMAIL);
		expect(res.status).toBe(202);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			from: { name: "Soldock", email: "no-reply@dock.test" },
			to: OWNER_SIGN_IN_EMAIL,
			subject: "Your Soldock sign-in code",
		});
		expect(sent[0]?.text).toContain(`sign in as owner@dock.test at ${ORIGIN}`);
		const code = codeIn(sent[0]);
		const signedIn = await submitCode(OWNER_SIGN_IN_EMAIL, code);
		expect(signedIn.status).toBe(204);
		expect(signedIn.headers.get("set-cookie")).toMatch(SESSION_COOKIE);
		const whoami = await request("/api/v1/account", { headers: { cookie: cookieOf(signedIn) } });
		const body = (await whoami.json()) as { credential: string; scopes: string[]; sign_in_email: string };
		expect(body).toMatchObject({ credential: "session", sign_in_email: OWNER_SIGN_IN_EMAIL });
		expect(body.scopes.sort()).toEqual([...ALL_SCOPES].sort());
		expect((await submitCode(OWNER_SIGN_IN_EMAIL, code)).status).toBe(401);
	});

	// People type their Soldock address as often as their sign-in email. The code never goes to the mailbox.
	it("accepts the Soldock address or the sign-in email in any case, and ignores spaces and hyphens in the code", async () => {
		await setupOwner();
		const { sent } = await requestCode("Owner@Dock.TEST");
		expect(sent.map((mail) => mail.to)).toEqual([OWNER_SIGN_IN_EMAIL]);
		const code = codeIn(sent[0]);
		expect((await submitCode("OLIVE@home.example", ` ${code.slice(0, 4)}-${code.slice(4)} `)).status).toBe(204);
	});

	// The answer must not tell an attacker which addresses have an account.
	it("answers each address the same, and sends nothing for an unknown address, an agent or another origin", async () => {
		await seedOrg();
		for (const email of ["nobody@dock.test", "nobody@home.example", "bot@dock.test"]) {
			const { res, sent } = await requestCode(email);
			expect(res.status).toBe(202);
			expect(sent).toEqual([]);
			expect((await submitCode(email, "12345678")).status).toBe(401);
		}
		for (const origin of ["https://evil.example", null]) {
			const { res, sent } = await requestCode(OWNER_SIGN_IN_EMAIL, origin);
			expect(res.status).toBe(403);
			expect(sent).toEqual([]);
			expect((await submitCode(OWNER_SIGN_IN_EMAIL, "12345678", origin)).status).toBe(403);
		}
		expect((await requestCode("not an address")).res.status).toBe(400);
		expect((await submitCode(OWNER_SIGN_IN_EMAIL, "1234")).status).toBe(400);
	});

	// An 8-digit code is safe only while the number of guesses stays small.
	it("allows five guesses on one code, after which the correct code also fails", async () => {
		await setupOwner();
		const code = codeIn((await requestCode(OWNER_SIGN_IN_EMAIL)).sent[0]);
		const guesses = await Promise.all(
			Array.from({ length: 5 }, () => submitCode(OWNER_SIGN_IN_EMAIL, wrong(code)).then((res) => res.status)),
		);
		expect(guesses).toEqual([401, 401, 401, 401, 401]);
		expect((await submitCode(OWNER_SIGN_IN_EMAIL, code)).status).toBe(401);
	});

	it("makes a new code replace the older ones, and refuses an expired code", async () => {
		await setupOwner();
		const first = codeIn((await requestCode(OWNER_SIGN_IN_EMAIL)).sent[0]);
		const second = codeIn((await requestCode(OWNER_SIGN_IN_EMAIL)).sent[0]);
		expect((await submitCode(OWNER_SIGN_IN_EMAIL, first)).status).toBe(401);
		expect((await submitCode(OWNER_SIGN_IN_EMAIL, second)).status).toBe(204);
		const third = codeIn((await requestCode(OWNER_SIGN_IN_EMAIL)).sent[0]);
		await env.DIRECTORY.prepare("UPDATE sign_in_codes SET expires_at = ?")
			.bind(new Date(Date.now() - 1).toISOString())
			.run();
		expect((await submitCode(OWNER_SIGN_IN_EMAIL, third)).status).toBe(401);
	});

	// Somebody who knows the address must not fill the person's inbox, or get unlimited guesses.
	it("sends at most five codes an hour to one person, also after a change of the sign-in email", async () => {
		const owner = await setupOwner();
		const sent = await Promise.all(
			Array.from({ length: 6 }, () => requestCode(OWNER_SIGN_IN_EMAIL).then((result) => result.sent.length)),
		);
		expect(sent.reduce((sum, n) => sum + n, 0)).toBe(5);
		// The change stops the old codes, but it must not give a new hour of codes to the new inbox.
		await owner.call("account.set_sign_in_email", { sign_in_email: "olive@new.example" });
		expect((await requestCode("owner@dock.test")).sent).toEqual([]);
		await env.DIRECTORY.prepare("UPDATE sign_in_codes SET created_at = ?")
			.bind(new Date(Date.now() - 61 * 60 * 1000).toISOString())
			.run();
		expect((await requestCode("owner@dock.test")).sent.map((mail) => mail.to)).toEqual(["olive@new.example"]);
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
		const res = await request("/auth/code", {
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
		await setupOwner();
		const cookie = await signIn(OWNER_SIGN_IN_EMAIL);
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
		await setupOwner();
		const cookie = await signIn(OWNER_SIGN_IN_EMAIL);
		const out = await request("/auth/sign-out", { method: "POST", headers: { cookie, origin: ORIGIN } });
		expect(out.status).toBe(204);
		expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
		expect((await request("/api/v1/account", { headers: { cookie } })).status).toBe(401);
	});
});

describe("sign-in email", () => {
	// A new email is the way to lock out somebody who got into the old one, so it ends the other sessions.
	it("lets a person change their own sign-in email with a full credential, and ends their other sessions", async () => {
		const owner = await setupOwner();
		const here = await signIn(OWNER_SIGN_IN_EMAIL);
		const elsewhere = await signIn(OWNER_SIGN_IN_EMAIL);
		const pending = codeIn((await requestCode(OWNER_SIGN_IN_EMAIL)).sent[0]);
		const res = await setSignInEmailWithCookie(here, { sign_in_email: "Olive@New.example" });
		expect(await res.json()).toEqual({ principal_id: owner.id, sign_in_email: "olive@new.example" });
		// A code that went to the old email must not work after the change, with any address.
		expect((await submitCode("owner@dock.test", pending)).status).toBe(401);
		expect((await request("/api/v1/account", { headers: { cookie: here } })).status).toBe(200);
		expect((await request("/api/v1/account", { headers: { cookie: elsewhere } })).status).toBe(401);
		expect((await requestCode(OWNER_SIGN_IN_EMAIL)).sent).toEqual([]);
		expect((await requestCode("owner@dock.test")).sent.map((mail) => mail.to)).toEqual(["olive@new.example"]);
		expect((await setSignInEmailWithCookie(here, { sign_in_email: "olive@dock.test" })).status).toBe(400);
	});

	// A sign-in gives every human scope, so a narrow key must not choose where the codes go.
	it("refuses a credential that does not hold every human scope", async () => {
		const owner = await setupOwner();
		const { api_key } = await owner.call("account.create_api_key", {
			label: "keys only",
			scopes: ["account.keys", "directory.write"],
		});
		const narrow = api(api_key.secret);
		expect(await denied(narrow("account.set_sign_in_email", { sign_in_email: "mallory@evil.example" }))).toBe(
			"forbidden",
		);
		expect(
			await denied(
				narrow("directory.create_principal", {
					kind: "human",
					display_name: "Mallory",
					address: "mallory@dock.test",
					sign_in_email: "mallory@evil.example",
				}),
			),
		).toBe("forbidden");
		expect((await requestCode("mallory@evil.example")).sent).toEqual([]);
	});

	it("lets admins change the sign-in email of others except the owner, and refuses agents", async () => {
		const { owner, ada, bot } = await seedOrg();
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Ann",
			address: "ann@dock.test",
			org_role: "admin",
			sign_in_email: "ann@home.example",
		});
		const adaSession = await signIn("ada@home.example");
		await admin.call("account.set_sign_in_email", { principal_id: ada.id, sign_in_email: "ada@new.example" });
		expect((await request("/api/v1/account", { headers: { cookie: adaSession } })).status).toBe(401);
		expect(
			await denied(
				admin.call("account.set_sign_in_email", { principal_id: owner.id, sign_in_email: "x@evil.example" }),
			),
		).toBe("forbidden");
		expect(
			await denied(ada.call("account.set_sign_in_email", { principal_id: admin.id, sign_in_email: "x@evil.example" })),
		).toBe("forbidden");
		expect(
			await denied(
				admin.call("account.set_sign_in_email", { principal_id: ada.id, sign_in_email: OWNER_SIGN_IN_EMAIL }),
			),
		).toBe("conflict");
		expect(
			await denied(ada.call("account.set_sign_in_email", { principal_id: bot.id, sign_in_email: "bot@home.example" })),
		).toBe("invalid");
		// MCP gives the same operation, with the same rules.
		const tool = await callTool(admin.key, "account_set_sign_in_email", {
			principal_id: ada.id,
			sign_in_email: "ada@third.example",
		});
		expect(tool.structuredContent).toEqual({ principal_id: ada.id, sign_in_email: "ada@third.example" });
		expect(
			(
				await callTool(admin.key, "account_set_sign_in_email", {
					principal_id: owner.id,
					sign_in_email: "x@evil.example",
				})
			).isError,
		).toBe(true);
		expect(await denied(bot.call("account.set_sign_in_email", { sign_in_email: "bot@home.example" }))).toBe(
			"forbidden",
		);
	});
});

describe("directory authorization", () => {
	it("lets only owners and admins create principals", async () => {
		const { owner, ada, bot } = await seedOrg();
		const input = {
			kind: "human",
			display_name: "Eve",
			address: "eve@dock.test",
			sign_in_email: "eve@home.example",
		} as const;
		expect(await denied(ada.call("directory.create_principal", input))).toBe("forbidden");
		expect(await denied(bot.call("directory.create_principal", input))).toBe("forbidden");
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Ann Admin",
			address: "ann@dock.test",
			org_role: "admin",
			sign_in_email: "ann@home.example",
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
		const create = (address: string, signInEmail: string | null = "x@home.example") =>
			owner.call("directory.create_principal", {
				kind: "human",
				display_name: "X",
				address,
				...(signInEmail ? { sign_in_email: signInEmail } : {}),
			});
		expect(await denied(create("x@not-ours.example"))).toBe("invalid");
		expect(await denied(create("x+tag@dock.test"))).toBe("invalid");
		expect(await denied(create("HELPER@dock.test"))).toBe("conflict");
		// The sender of sign-in codes is reserved, so a reply to a code reaches no mailbox.
		expect(await denied(create("No-Reply@dock.test"))).toBe("invalid");
		// A person needs a sign-in email outside the mail domains, and only one person can have it.
		expect(await denied(create("x@dock.test", null))).toBe("invalid");
		expect(await denied(create("x@dock.test", "x@second.test"))).toBe("invalid");
		expect(await denied(create("x@dock.test", "OLIVE@home.example"))).toBe("conflict");
		expect(
			await denied(
				owner.call("directory.create_principal", {
					kind: "agent",
					display_name: "Z",
					address: "z@dock.test",
					sign_in_email: "z@home.example",
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
			sign_in_email: "bob@home.example",
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
			sign_in_email: "bob@home.example",
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
			sign_in_email: "ann@home.example",
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

import { env } from "cloudflare:workers";
import { MEET_TOKEN_HEADER, meetCallPath } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	callTool,
	clearMeetSettings,
	codeOf,
	createActor,
	mcp,
	ORIGIN,
	PASSWORD,
	request,
	SEALED,
	seedOrg,
	signIn,
	withEnv,
} from "./helpers.ts";
import { fakeRealtime, type RealtimeValues, TEST_REALTIME } from "./realtime-fake.ts";

// Admin › Meet: an owner or an admin saves the Cloudflare Realtime values of Meet (the SFU app and the TURN key). No
// person without the role, no agent and no service account reads or changes them: the App Secret has full control of
// the SFU app. Each pair resolves as a whole, from the settings or else from the Worker secrets.

let owner: Actor;
let ada: Actor;
let bot: Actor;
let admin: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	admin = await createActor(owner, {
		kind: "human",
		display_name: "Alan Admin",
		address: "alan@dock.test",
		org_role: "admin",
		password: PASSWORD,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A second SFU app and TURN key, as an admin saves them. */
const SECOND: RealtimeValues = {
	appId: "c0000000000000000000000000000002",
	appSecret: "second-realtime-app-secret",
	turnKeyId: "d0000000000000000000000000000002",
	turnToken: "second-turn-key-token",
};

const OTHER_KEY = "a-different-encryption-key-0123456789";

const row = () =>
	env.DIRECTORY.prepare("SELECT app_id, app_secret, turn_key_id, turn_key_token FROM meet_settings WHERE id = 1").first<
		Record<string, string | null>
	>();

/** A request of the owner with these bindings in place of the ones of the tests. */
async function asOwnerWith(bindings: Parameters<typeof withEnv>[0], path: string, body?: unknown) {
	return await withEnv(bindings, path, {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${owner.key}`, origin: ORIGIN, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

/** The audit lines that the Worker wrote while `run` ran, as text. */
async function auditText(run: () => Promise<unknown>): Promise<string[]> {
	const spy = vi.spyOn(console, "log");
	try {
		await run();
		return spy.mock.calls
			.map((args) => args.map(String).join(" "))
			.filter((line) => line.startsWith("{") && line.includes('"audit":true'));
	} finally {
		spy.mockRestore();
	}
}

const toolNames = async (key: string) =>
	(((await mcp(key, "tools/list")).body?.result ?? { tools: [] }) as { tools: { name: string }[] }).tools.map(
		(tool) => tool.name,
	);

describe("the Meet settings", () => {
	it("let owners and admins read and change them, and never show or log a secret", async () => {
		const saved = {
			app_id: TEST_REALTIME.appId,
			app_secret_configured: true,
			sfu_source: "settings",
			turn_key_id: TEST_REALTIME.turnKeyId,
			turn_key_token_configured: true,
			turn_source: "settings",
			ready: true,
			not_ready_reason: null,
		};
		expect(await owner.call("meet.get_settings")).toEqual(saved);
		expect((await callTool(owner.key, "meet_get_settings")).structuredContent).toEqual(saved);

		const input = {
			app_id: SECOND.appId.toUpperCase(),
			app_secret: SECOND.appSecret,
			turn_key_id: SECOND.turnKeyId,
			turn_key_token: SECOND.turnToken,
		};
		let changed: unknown;
		const lines = await auditText(async () => {
			changed = await admin.call("meet.update_settings", input);
		});
		// The ID is stored in lower case. The answer and the audit lines hold no secret.
		expect(changed).toEqual({ ...saved, app_id: SECOND.appId, turn_key_id: SECOND.turnKeyId });
		for (const text of [JSON.stringify(changed), ...lines]) {
			expect(text).not.toContain(SECOND.appSecret);
			expect(text).not.toContain(SECOND.turnToken);
		}
		const targets = lines.map((line) => (JSON.parse(line) as { op: string; target: string }).target);
		expect(targets).toEqual(["ready", "app_secret_set", "turn_key_token_set"]);
		// The tests have ENCRYPTION_KEY, so the secrets are sealed in D1.
		expect(await row()).toEqual({
			app_id: SECOND.appId,
			app_secret: expect.stringMatching(SEALED),
			turn_key_id: SECOND.turnKeyId,
			turn_key_token: expect.stringMatching(SEALED),
		});
		// The same secret again changes no secret, so it writes no secret line.
		const again = await auditText(() => owner.call("meet.update_settings", { app_secret: SECOND.appSecret }));
		expect(again.map((line) => (JSON.parse(line) as { target: string }).target)).toEqual(["ready"]);
	});

	it("refuse a member, an agent and a service account, and hide the tools from an agent", async () => {
		for (const actor of [ada, bot]) {
			expect(await codeOf(actor.call("meet.get_settings", {}))).toBe("forbidden");
			expect(await codeOf(actor.call("meet.update_settings", { app_id: null, app_secret: null }))).toBe("forbidden");
			expect(await codeOf(actor.call("meet.test_connection", {}))).toBe("forbidden");
		}
		expect((await toolNames(bot.key)).filter((name) => name.endsWith("_settings") && name.startsWith("meet_"))).toEqual(
			[],
		);
		expect(
			(await toolNames(owner.key)).filter((name) => /^meet_(get|update)_settings$|^meet_test/.test(name)).sort(),
		).toEqual(["meet_get_settings", "meet_test_connection", "meet_update_settings"]);

		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI Pipeline",
			address: "ci@dock.test",
			sponsor_id: ada.id,
		});
		const { api_key } = await owner.call("account.create_api_key", { principal_id: service.id, label: "ci" });
		expect(await codeOf(api(api_key.secret)("meet.get_settings", {}))).toBe("forbidden");

		// The key of an admin follows its scopes: directory.read reads, directory.write changes, meet.write does neither.
		const { api_key: reader } = await admin.call("account.create_api_key", {
			principal_id: admin.id,
			label: "read only",
			scopes: ["directory.read"],
		});
		expect((await api(reader.secret)("meet.get_settings", {})).ready).toBe(true);
		expect(await codeOf(api(reader.secret)("meet.update_settings", { app_id: null, app_secret: null }))).toBe(
			"forbidden",
		);
		const { api_key: meetOnly } = await admin.call("account.create_api_key", {
			principal_id: admin.id,
			label: "meet only",
			scopes: ["meet.read", "meet.write"],
		});
		expect(await codeOf(api(meetOnly.secret)("meet.get_settings", {}))).toBe("forbidden");
		expect(await codeOf(api(meetOnly.secret)("meet.test_connection", {}))).toBe("forbidden");
		expect(await row()).toMatchObject({ app_id: TEST_REALTIME.appId });
	});

	it("set each pair as a whole, and stop Meet when the SFU app goes", async () => {
		expect(await codeOf(owner.call("meet.update_settings", { app_id: null }))).toBe("invalid");
		expect(await codeOf(owner.call("meet.update_settings", { turn_key_token: null }))).toBe("invalid");
		// A new ID needs its secret in the same request.
		expect(await codeOf(owner.call("meet.update_settings", { app_id: SECOND.appId }))).toBe("invalid");
		expect(
			await codeOf(owner.call("meet.update_settings", { app_id: "not-an-id", app_secret: SECOND.appSecret })),
		).toBe("invalid");
		expect(await row()).toMatchObject({ app_id: TEST_REALTIME.appId, turn_key_id: TEST_REALTIME.turnKeyId });

		// Without a TURN key, Meet works with STUN only.
		expect(await owner.call("meet.update_settings", { turn_key_id: null, turn_key_token: null })).toMatchObject({
			turn_key_id: null,
			turn_key_token_configured: false,
			turn_source: null,
			ready: true,
		});
		expect(await owner.call("meet.update_settings", { app_id: null, app_secret: null })).toMatchObject({
			app_id: null,
			app_secret_configured: false,
			sfu_source: null,
			ready: false,
			not_ready_reason: "no_app",
		});
		expect(await codeOf(ada.call("meet.create_meeting", {}))).toBe("unavailable");
	});

	it("keep two changes at the same time", async () => {
		await Promise.all([
			owner.call("meet.update_settings", { app_id: SECOND.appId, app_secret: SECOND.appSecret }),
			admin.call("meet.update_settings", { turn_key_id: SECOND.turnKeyId, turn_key_token: SECOND.turnToken }),
		]);
		expect(await row()).toMatchObject({ app_id: SECOND.appId, turn_key_id: SECOND.turnKeyId });
	});

	it("use the Worker secrets for a pair that is not saved, and the saved pair over them", async () => {
		const secrets = { REALTIME_APP_ID: SECOND.appId, REALTIME_APP_SECRET: SECOND.appSecret };
		const both = await asOwnerWith(secrets, "/api/v1/meet/settings");
		expect(await both.json()).toMatchObject({ app_id: TEST_REALTIME.appId, sfu_source: "settings" });

		await clearMeetSettings();
		const fallback = await asOwnerWith(secrets, "/api/v1/meet/settings");
		// The answer never shows the value of a Worker secret: only where the pair comes from.
		expect(await fallback.json()).toEqual({
			app_id: null,
			app_secret_configured: true,
			sfu_source: "secret",
			turn_key_id: null,
			turn_key_token_configured: false,
			turn_source: null,
			ready: true,
			not_ready_reason: null,
		});
		const created = await asOwnerWith(secrets, "/api/v1/meet/meetings", {});
		expect(created.status).toBe(200);
		// A half pair of Worker secrets is no pair.
		const half = await asOwnerWith({ REALTIME_APP_ID: SECOND.appId }, "/api/v1/meet/settings");
		expect(await half.json()).toMatchObject({ sfu_source: null, ready: false });
	});

	it("seal a plaintext secret at the next write, and fall back while a sealed secret does not open", async () => {
		// The row of test/setup.ts is plaintext, as a row from before ENCRYPTION_KEY. Meet uses it.
		expect(await row()).toMatchObject({ app_secret: TEST_REALTIME.appSecret });
		await owner.call("meet.update_settings", { turn_key_id: SECOND.turnKeyId, turn_key_token: SECOND.turnToken });
		const sealed = await row();
		expect(sealed).toMatchObject({
			app_secret: expect.stringMatching(SEALED),
			turn_key_token: expect.stringMatching(SEALED),
		});

		// With a different key, the saved pairs do not open: the Worker secrets apply, or Meet has no SFU app.
		const secrets = { REALTIME_APP_ID: SECOND.appId, REALTIME_APP_SECRET: SECOND.appSecret, ENCRYPTION_KEY: OTHER_KEY };
		const fallback = await asOwnerWith(secrets, "/api/v1/meet/settings");
		expect(await fallback.json()).toMatchObject({ sfu_source: "secret", turn_source: null });
		const none = await asOwnerWith({ ENCRYPTION_KEY: OTHER_KEY }, "/api/v1/meet/settings");
		expect(await none.json()).toMatchObject({ sfu_source: null, ready: false, not_ready_reason: "no_app" });
		// A change of the other pair keeps the sealed secret that does not open now.
		const changed = await asOwnerWith({ ENCRYPTION_KEY: OTHER_KEY }, "/api/v1/meet/settings", {
			turn_key_id: TEST_REALTIME.turnKeyId,
			turn_key_token: TEST_REALTIME.turnToken,
		});
		expect(changed.status).toBe(200);
		expect((await row())?.app_secret).toBe(sealed?.app_secret);

		// With an ENCRYPTION_KEY that is too short, nothing is saved.
		const short = await asOwnerWith({ ENCRYPTION_KEY: "too-short" }, "/api/v1/meet/settings", {
			app_id: SECOND.appId,
			app_secret: SECOND.appSecret,
		});
		expect(short.status).toBe(503);
		expect(await short.text()).not.toContain("too-short");
		expect((await row())?.app_id).toBe(TEST_REALTIME.appId);
	});
});

describe("a meeting and the settings", () => {
	it("uses the values that apply now: a new SFU app at the next media call, and none after a removal", async () => {
		fakeRealtime();
		const { meeting } = await ada.call("meet.create_meeting", { title: "Sync" });
		const cookie = await signIn("ada@dock.test");
		const path = meetCallPath(meeting.code);
		const joined = await request(`${path}/join`, {
			method: "POST",
			headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
			body: "{}",
		});
		expect(joined.status).toBe(201);
		const { token } = (await joined.json()) as { token: string };
		const session = () =>
			request(`${path}/media/session`, {
				method: "POST",
				headers: { [MEET_TOKEN_HEADER]: token, "content-type": "application/json" },
				body: "{}",
			});
		expect((await session()).status).toBe(200);

		// An admin saves a second SFU app and TURN key. The next session of the object goes to the second app.
		await owner.call("meet.update_settings", {
			app_id: SECOND.appId,
			app_secret: SECOND.appSecret,
			turn_key_id: SECOND.turnKeyId,
			turn_key_token: SECOND.turnToken,
		});
		const second = fakeRealtime(SECOND);
		expect((await session()).status).toBe(200);
		expect(second.callsTo("/sessions/new").map((call) => call.path)).toEqual([`/apps/${SECOND.appId}/sessions/new`]);
		expect(second.callsTo("/generate-ice-servers")).toHaveLength(1);

		// Without an SFU app, the object refuses media, the page says that Meet is not set up, and nobody joins.
		await owner.call("meet.update_settings", { app_id: null, app_secret: null });
		const refused = await session();
		expect(refused.status).toBe(503);
		expect(await refused.text()).toContain("Admin › Meet");
		const info = (await (await request(path)).json()) as { media: string };
		expect(info.media).toBe("not_configured");
		const guest = await request(`${path}/join`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ display_name: "Grace" }),
		});
		expect(guest.status).toBe(503);
	});
});

describe("the connection test", () => {
	it("makes one session and one TURN credential that it revokes, and writes the result in the audit", async () => {
		const sfu = fakeRealtime();
		let result: unknown;
		const lines = await auditText(async () => {
			result = await admin.call("meet.test_connection", {});
		});
		expect(result).toEqual({
			sfu: { ok: true, status: 200, latency_ms: expect.any(Number), reason: null },
			turn: { ok: true, status: 201, latency_ms: expect.any(Number), reason: null },
		});
		expect(sfu.calls.map((call) => `${call.method} ${call.path.replace(/user[^/]+/, "<user>")}`)).toEqual([
			`POST /apps/${TEST_REALTIME.appId}/sessions/new`,
			`POST /turn/keys/${TEST_REALTIME.turnKeyId}/credentials/generate-ice-servers`,
			`POST /turn/keys/${TEST_REALTIME.turnKeyId}/credentials/<user>/revoke`,
		]);
		expect(sfu.calls[1]?.body).toEqual({ ttl: 60 });
		expect(lines.map((line) => (JSON.parse(line) as { target: string }).target)).toEqual(["sfu_ok_turn_ok"]);
	});

	it("gives the status of a refused value, and sends nothing when Meet is not set up", async () => {
		// The stand-in accepts only the second app and key, so Cloudflare refuses the saved values.
		const sfu = fakeRealtime(SECOND);
		expect(await owner.call("meet.test_connection", {})).toEqual({
			sfu: { ok: false, status: 401, latency_ms: expect.any(Number), reason: "http" },
			turn: { ok: false, status: 401, latency_ms: expect.any(Number), reason: "http" },
		});

		await clearMeetSettings();
		const before = sfu.calls.length;
		const none = { ok: false, status: null, latency_ms: 0, reason: "not_configured" };
		expect(await owner.call("meet.test_connection", {})).toEqual({ sfu: none, turn: none });
		expect(sfu.calls).toHaveLength(before);
	});
});

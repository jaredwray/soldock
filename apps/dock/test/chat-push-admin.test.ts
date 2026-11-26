import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import type { Scope } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	callTool,
	codeOf,
	createActor,
	mcp,
	ORIGIN,
	PASSWORD,
	racing,
	seedOrg,
	withEnv,
} from "./helpers.ts";

// Admin › Chat: an owner or an admin turns on Web Push. The Worker makes the VAPID key pair and keeps it in
// the database. No member, agent or service account reads or changes it. The deprecated Worker secrets
// VAPID_* apply until the first change, which copies their key pair.

let owner: Actor;
let ada: Actor;
let bot: Actor;
let admin: Actor;

const SUBJECT = "mailto:admin@example.com";
const OFF = { enabled: false, subject: null, public_key: null, key_source: null, keys_created_at: null };

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

afterEach(() => vi.restoreAllMocks());

/** Each audit line that the Worker writes after this call. */
function auditLines() {
	const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
	const all = () => spies.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" ")));
	return {
		all,
		targets: (op: string) =>
			all()
				.filter((line) => line.startsWith("{") && line.includes('"audit":true'))
				.map((line) => JSON.parse(line) as { op?: string; target?: string; result?: string })
				.filter((line) => line.op === op),
	};
}

async function storedPrivateKey(): Promise<string | null> {
	return await env.DIRECTORY.prepare("SELECT private_key FROM chat_push_settings WHERE id = 1").first<string>(
		"private_key",
	);
}

/** The deprecated secrets of an older deployment: a real P-256 key pair and a contact address. */
function secretPair() {
	const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const { x, y, d } = pair.privateKey.export({ format: "jwk" });
	if (!x || !y || !d) throw new Error("The test requires an EC key pair.");
	const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]);
	return {
		VAPID_PUBLIC_KEY: publicKey.toString("base64url"),
		VAPID_PRIVATE_KEY: d,
		VAPID_SUBJECT: "mailto:ops@example.com",
	};
}

/** A call through the Worker with the deprecated secrets set. */
async function withSecrets(secrets: ReturnType<typeof secretPair>, key: string, path: string, body?: unknown) {
	const res = await withEnv(secrets, path, {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${key}`, origin: ORIGIN, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Record<string, unknown>;
}

const toolNames = async (key: string) =>
	(((await mcp(key, "tools/list")).body?.result ?? { tools: [] }) as { tools: { name: string }[] }).tools.map(
		(tool) => tool.name,
	);

describe("the Web Push settings", () => {
	it("start off, turn on with a new key pair from the Worker, and never return the private key", async () => {
		const audit = auditLines();
		expect(await owner.call("chat.get_push_settings")).toEqual(OFF);
		expect((await ada.call("chat.get_notification_settings")).vapid_public_key).toBeNull();
		expect(await codeOf(owner.call("chat.update_push_settings", { enabled: true }))).toBe("invalid");
		expect(
			await codeOf(owner.call("chat.update_push_settings", { enabled: true, subject: "javascript:alert(1)" })),
		).toBe("invalid");
		expect(await owner.call("chat.get_push_settings")).toEqual(OFF);

		const saved = await admin.call("chat.update_push_settings", { enabled: true, subject: SUBJECT });
		expect(saved).toEqual({
			enabled: true,
			subject: SUBJECT,
			public_key: expect.stringMatching(/^B[A-Za-z0-9_-]{86}$/),
			key_source: "settings",
			keys_created_at: expect.any(String),
		});
		// Each member's device subscribes with the same public key. MCP gives the same settings as REST.
		expect((await ada.call("chat.get_notification_settings")).vapid_public_key).toBe(saved.public_key);
		const viaMcp = await callTool(owner.key, "chat_get_push_settings");
		expect(viaMcp.structuredContent).toEqual(saved);

		// Off and on again, and a new contact address, keep the key pair, so the devices stay subscribed.
		expect(await owner.call("chat.update_push_settings", { enabled: false })).toMatchObject({
			enabled: false,
			public_key: saved.public_key,
		});
		expect((await ada.call("chat.get_notification_settings")).vapid_public_key).toBeNull();
		expect(await owner.call("chat.update_push_settings", { enabled: true })).toEqual(saved);
		expect(await owner.call("chat.update_push_settings", { subject: "https://example.com/contact" })).toEqual({
			...saved,
			subject: "https://example.com/contact",
		});

		const privateKey = await storedPrivateKey();
		expect(privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(JSON.stringify([saved, viaMcp, await owner.call("chat.get_push_settings")])).not.toContain(privateKey);
		expect(audit.all().filter((line) => line.includes(privateKey ?? "-"))).toEqual([]);
		const targets = audit.targets("chat.update_push_settings").map((line) => line.target);
		expect(targets.filter((target) => target === "keys_created")).toHaveLength(1);
		expect(targets.filter((target) => target === "on")).toHaveLength(3);
	});

	it("refuse a member, an agent and a service account, and hide the tools from an agent", async () => {
		const audit = auditLines();
		const calls = [
			["chat.get_push_settings", {}],
			["chat.update_push_settings", { enabled: true, subject: SUBJECT }],
			["chat.rotate_push_keys", {}],
		] as const;
		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI Pipeline",
			address: "ci@dock.test",
			sponsor_id: ada.id,
		});
		const { api_key } = await owner.call("account.create_api_key", { principal_id: service.id, label: "ci" });
		for (const [name, input] of calls) {
			expect(await codeOf(ada.call(name, input))).toBe("forbidden");
			expect(await codeOf(bot.call(name, input))).toBe("forbidden");
			expect(await codeOf(api(api_key.secret)(name, input))).toBe("forbidden");
		}
		expect(await owner.call("chat.get_push_settings")).toEqual(OFF);
		// The refusal is in the audit log.
		expect(audit.targets("chat.update_push_settings").map((line) => line.result)).toEqual([
			"denied",
			"denied",
			"denied",
		]);

		const pushTools = ["chat_get_push_settings", "chat_rotate_push_keys", "chat_update_push_settings"];
		expect((await toolNames(bot.key)).filter((name) => pushTools.includes(name))).toEqual([]);
		expect((await toolNames(owner.key)).filter((name) => pushTools.includes(name)).sort()).toEqual(pushTools);
	});

	it("follow the scopes of the key of an admin: directory.read reads, directory.write changes", async () => {
		const key = async (scopes: Scope[]) =>
			api(
				(await admin.call("account.create_api_key", { principal_id: admin.id, label: scopes.join(" "), scopes }))
					.api_key.secret,
			);
		const reader = await key(["directory.read"]);
		expect(await reader("chat.get_push_settings", {})).toEqual(OFF);
		expect(await codeOf(reader("chat.update_push_settings", { enabled: true, subject: SUBJECT }))).toBe("forbidden");
		expect(await codeOf(reader("chat.rotate_push_keys", {}))).toBe("forbidden");
		// A key for a chat script cannot change the notifications of the organization.
		const chatScript = await key(["chat.read", "chat.write"]);
		expect(await codeOf(chatScript("chat.get_push_settings", {}))).toBe("forbidden");
		expect(await codeOf(chatScript("chat.update_push_settings", { enabled: false }))).toBe("forbidden");
		expect(await codeOf(chatScript("chat.rotate_push_keys", {}))).toBe("forbidden");
		const writer = await key(["directory.write"]);
		expect(await writer("chat.update_push_settings", { enabled: true, subject: SUBJECT })).toMatchObject({
			enabled: true,
		});
		expect((await writer("chat.rotate_push_keys", {})).enabled).toBe(true);
	});

	it("use the deprecated secrets until the first change, then keep their key pair in the database", async () => {
		const secrets = secretPair();
		const audit = auditLines();
		const fromSecret = {
			enabled: true,
			subject: secrets.VAPID_SUBJECT,
			public_key: secrets.VAPID_PUBLIC_KEY,
			key_source: "secret",
			keys_created_at: null,
		};
		expect(await withSecrets(secrets, owner.key, "/api/v1/chat/admin/push")).toEqual(fromSecret);
		expect((await withSecrets(secrets, ada.key, "/api/v1/chat/notifications")).vapid_public_key).toBe(
			secrets.VAPID_PUBLIC_KEY,
		);

		// The first change copies the key pair and the contact address. The row then wins over the secrets.
		expect(await withSecrets(secrets, owner.key, "/api/v1/chat/admin/push", { enabled: false })).toEqual({
			...fromSecret,
			enabled: false,
			key_source: "settings",
			keys_created_at: expect.any(String),
		});
		expect(await storedPrivateKey()).toBe(secrets.VAPID_PRIVATE_KEY);
		expect((await withSecrets(secrets, ada.key, "/api/v1/chat/notifications")).vapid_public_key).toBeNull();
		expect(audit.targets("chat.update_push_settings").map((line) => line.target)).toEqual([
			"off",
			"keys_copied_from_secret",
		]);

		// Without the secrets, a turn on uses the copied pair: the devices of the old deployment stay subscribed.
		expect(await owner.call("chat.update_push_settings", { enabled: true })).toMatchObject({
			enabled: true,
			subject: secrets.VAPID_SUBJECT,
			public_key: secrets.VAPID_PUBLIC_KEY,
		});
	});
});

describe("a change while the secrets apply", () => {
	it("keeps the state that a different admin copied from the secrets during the call", async () => {
		const secrets = secretPair();
		// A different admin turns push off just before the write of the call, and so copies the secrets.
		const turnOff = `UPDATE chat_push_settings SET enabled = 0, subject = 'mailto:other@example.com', public_key = ?,
			private_key = 'copied', keys_created_at = 1 WHERE id = 1`;
		const call = async (path: string, body: unknown) => {
			const directory = racing(turnOff, secrets.VAPID_PUBLIC_KEY, "UPDATE chat_push_settings SET");
			const res = await withEnv({ ...secrets, DIRECTORY: directory }, path, {
				method: "POST",
				headers: { authorization: `Bearer ${owner.key}`, origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(200);
			return (await res.json()) as Record<string, unknown>;
		};

		// A new contact address goes in. Push stays off.
		expect(await call("/api/v1/chat/admin/push", { subject: "https://example.com/contact" })).toMatchObject({
			enabled: false,
			subject: "https://example.com/contact",
			public_key: secrets.VAPID_PUBLIC_KEY,
		});

		await env.DIRECTORY.prepare(
			"UPDATE chat_push_settings SET enabled = 0, subject = NULL, public_key = NULL, private_key = NULL, keys_created_at = NULL",
		).run();
		// A rotation replaces the pair. Push stays off, and the contact address of the other admin stays.
		const rotated = await call("/api/v1/chat/admin/push/rotate", {});
		expect(rotated).toMatchObject({ enabled: false, subject: "mailto:other@example.com", key_source: "settings" });
		expect(rotated.public_key).not.toBe(secrets.VAPID_PUBLIC_KEY);
	});
});

describe("the key rotation", () => {
	it("needs a key pair, and replaces it while the state and the contact address stay", async () => {
		const audit = auditLines();
		expect(await codeOf(owner.call("chat.rotate_push_keys"))).toBe("invalid");
		const before = await owner.call("chat.update_push_settings", { enabled: true, subject: SUBJECT });
		const privateBefore = await storedPrivateKey();

		const after = await admin.call("chat.rotate_push_keys");
		expect(after).toEqual({
			...before,
			public_key: expect.stringMatching(/^B[A-Za-z0-9_-]{86}$/),
			keys_created_at: expect.any(String),
		});
		expect(after.public_key).not.toBe(before.public_key);
		expect(await storedPrivateKey()).not.toBe(privateBefore);
		// The devices get the new key at their next start and subscribe again.
		expect((await ada.call("chat.get_notification_settings")).vapid_public_key).toBe(after.public_key);
		expect(audit.targets("chat.rotate_push_keys").map((line) => line.target)).toEqual(["keys_rotated"]);
	});

	it("keeps push on when it replaces the key pair of the deprecated secrets", async () => {
		const secrets = secretPair();
		expect(await withSecrets(secrets, owner.key, "/api/v1/chat/admin/push/rotate", {})).toEqual({
			enabled: true,
			subject: secrets.VAPID_SUBJECT,
			public_key: expect.not.stringMatching(secrets.VAPID_PUBLIC_KEY),
			key_source: "settings",
			keys_created_at: expect.any(String),
		});
	});
});

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	EVENTS_SOCKET_CLOSE,
	EVENTS_SOCKET_PATH,
	type Scope,
	SERVICE_ACTIVITY_LIMITS,
	SERVICE_SCOPE_DESCRIPTIONS,
	SERVICE_SCOPES,
} from "@asterra/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CredentialRef, checkCredentials, credentialState } from "../src/identity/index.ts";
import {
	type Actor,
	api,
	base64,
	bearer,
	callTool,
	codeOf,
	consumeWebhooks,
	createActor,
	mcp,
	modernRequest,
	PASSWORD,
	racing,
	readSocket,
	readSse,
	receiveWebhooks,
	request,
	seedOrg,
	sendMemberStates,
	upgradeRoomSocket,
	withEnv,
} from "./helpers.ts";

// Service accounts: a third kind of member. Owners and admins create one, give it tokens with a lifetime,
// read its activity and see what it can reach. In mail, Drive and Chat it is an agent.

const PAST = "2020-01-01T00:00:00.000Z";
const HOOK = "https://hooks.example.com/asterra";

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The owner, an admin, a member (Ada), the agent of Ada, and a service account that Ada sponsors. The
 * account has each service scope, unless `scopes` names its scopes.
 */
async function seedService(scopes: Scope[] = [...SERVICE_SCOPES]) {
	const { owner, ada, bot } = await seedOrg();
	const admin = await createActor(owner, {
		kind: "human",
		display_name: "Alan Admin",
		address: "alan@dock.test",
		org_role: "admin",
		password: PASSWORD,
	});
	const { principal } = await admin.call("directory.create_service_account", {
		display_name: "CI Pipeline",
		address: "ci@dock.test",
		description: "Posts build results",
		sponsor_id: ada.id,
		scopes: scopes as never,
	});
	return { owner, admin, ada, bot, service: principal };
}

/**
 * A token of the service account, made by `by`, as an actor that calls the API with it. A token has no
 * scopes of its own: it has the scopes of the account.
 */
async function serviceToken(
	by: Actor,
	serviceId: string,
	extra: { expires_in_days?: number; expires_at?: string; description?: string } = {},
): Promise<Actor & { keyId: string }> {
	const { api_key } = await by.call("account.create_api_key", { principal_id: serviceId, label: "deploy", ...extra });
	return { id: serviceId, address: "ci@dock.test", key: api_key.secret, call: api(api_key.secret), keyId: api_key.id };
}

/** Sets the scopes of the service account, as an admin does. Each token of the account gets them. */
async function setScopes(admin: Actor, serviceId: string, scopes: Scope[]) {
	await admin.call("directory.set_agent_access", { principal_id: serviceId, scopes: scopes as never });
}

/** Moves the end of a key into the past, as when its lifetime ends. */
async function expire(keyId: string) {
	await env.DIRECTORY.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").bind(PAST, keyId).run();
}

/** The activity of a service account, after the writes that `waitUntil` holds reach the object. */
async function activityOf(admin: Actor, principalId: string, count: number, keyId?: string) {
	return await vi.waitFor(async () => {
		const page = await admin.call("directory.list_service_account_activity", {
			principal_id: principalId,
			...(keyId ? { key_id: keyId } : {}),
		});
		expect(page.entries.length).toBeGreaterThanOrEqual(count);
		return page;
	});
}

describe("service accounts", () => {
	it("are created by owners and admins only, with a description, a creator, a sponsor, scopes and no token", async () => {
		const { owner, admin, ada, bot, service } = await seedService(["account.read", "chat.read"]);
		expect(service).toMatchObject({
			kind: "service",
			display_name: "CI Pipeline",
			address: "ci@dock.test",
			description: "Posts build results",
			created_by: admin.id,
			sponsor_id: ada.id,
			org_role: null,
			outbound_policy: { mode: "internal-only", allowlist: [] },
		});
		expect((await admin.call("account.list_api_keys", { principal_id: service.id })).api_keys).toEqual([]);
		// The account has the scopes of its creation, and no limits.
		expect(await admin.call("directory.get_agent_access", { principal_id: service.id })).toMatchObject({
			scopes: ["account.read", "chat.read"],
			resources: null,
			tokens: [],
		});
		// The owner can create one through MCP too. The sponsor is the caller by default.
		const viaMcp = await callTool(owner.key, "directory_create_service_account", {
			display_name: "Backup Job",
			address: "backup@dock.test",
			scopes: ["drive.read"],
		});
		expect(viaMcp.isError).toBeFalsy();
		expect(viaMcp.structuredContent).toMatchObject({ principal: { kind: "service", sponsor_id: owner.id } });

		const input = { display_name: "Nope", address: "nope@dock.test", scopes: ["account.read" as const] };
		// An account needs a scope, and only a scope that a service account can hold.
		expect(await codeOf(admin.call("directory.create_service_account", { ...input, scopes: [] }))).toBe("invalid");
		expect(
			await codeOf(admin.call("directory.create_service_account", { ...input, scopes: ["account.keys" as never] })),
		).toBe("invalid");
		const token = await serviceToken(admin, service.id);
		expect(await codeOf(ada.call("directory.create_service_account", input))).toBe("forbidden");
		expect(await codeOf(bot.call("directory.create_service_account", input))).toBe("forbidden");
		expect(await codeOf(token.call("directory.create_service_account", input))).toBe("forbidden");
		// A narrow key of an admin without directory.write cannot create one.
		const { api_key } = await admin.call("account.create_api_key", { label: "narrow", scopes: ["account.keys"] });
		expect(await codeOf(api(api_key.secret)("directory.create_service_account", input))).toBe("forbidden");
		// A key with directory.write cannot give the account a scope that the key does not hold.
		const writer = await admin.call("account.create_api_key", {
			label: "writer",
			scopes: ["directory.write", "account.read"],
		});
		expect(
			await codeOf(api(writer.api_key.secret)("directory.create_service_account", { ...input, scopes: ["mail.read"] })),
		).toBe("forbidden");
		// The address follows the rules of a principal: a saved domain, and no other holder.
		expect(await codeOf(admin.call("directory.create_service_account", { ...input, address: "x@unknown.test" }))).toBe(
			"invalid",
		);
		expect(await codeOf(admin.call("directory.create_service_account", { ...input, address: "ci@dock.test" }))).toBe(
			"conflict",
		);
		// A sponsor that a parallel request archives after the read of the handler gets no service account: the
		// insert checks the sponsor again in its transaction.
		const res = await withEnv(
			{ DIRECTORY: racing("UPDATE principals SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", ada.id) },
			"/api/v1/directory/service-accounts",
			{
				method: "POST",
				headers: { authorization: `Bearer ${admin.key}`, "content-type": "application/json" },
				body: JSON.stringify({
					display_name: "Race",
					address: "race@dock.test",
					sponsor_id: ada.id,
					scopes: ["account.read"],
				}),
			},
		);
		expect(res.status).toBe(409);
		const listed = await owner.call("directory.list_principals", { kind: "service" });
		expect(listed.principals.map((principal) => principal.address)).not.toContain("race@dock.test");
	});

	it("show as their own kind in the directory, and an admin changes the description", async () => {
		const { admin, ada, bot, service } = await seedService();
		const listed = await ada.call("directory.list_principals", { kind: "service" });
		expect(listed.principals.map((principal) => principal.id)).toEqual([service.id]);
		const agents = await ada.call("directory.list_principals", { kind: "agent" });
		expect(agents.principals.map((principal) => principal.id)).toEqual([bot.id]);
		const humans = await ada.call("directory.list_principals", { kind: "human" });
		expect(humans.principals.every((principal) => principal.kind === "human")).toBe(true);
		const lookup = await bot.call("directory.get_principals", { ids: service.id });
		expect(lookup.principals[0]).toMatchObject({ kind: "service", handle: "ci" });

		const changed = await admin.call("directory.update_principal", {
			principal_id: service.id,
			description: "Posts build results and deploy notes",
		});
		expect(changed.principal.description).toBe("Posts build results and deploy notes");
		const cleared = await admin.call("directory.update_principal", { principal_id: service.id, description: "" });
		expect(cleared.principal.description).toBeNull();
		expect(await codeOf(admin.call("directory.update_principal", { principal_id: bot.id, description: "x" }))).toBe(
			"invalid",
		);
	});

	it("show their description and their creator in the directory to owners and admins only", async () => {
		const { owner, admin, ada, bot, service } = await seedService();
		const token = await serviceToken(admin, service.id);
		const shown = { description: "Posts build results", created_by: admin.id };
		const hidden = { description: null, created_by: null };
		for (const [caller, fields] of [
			[owner, shown],
			[admin, shown],
			[ada, hidden],
			[bot, hidden],
			[token, hidden],
		] as const) {
			const listed = await caller.call("directory.list_principals", { kind: "service" });
			expect(listed.principals[0]).toMatchObject({ id: service.id, ...fields });
			const lookup = await caller.call("directory.get_principals", { ids: service.id });
			expect(lookup.principals[0]).toMatchObject({ id: service.id, ...fields });
		}
	});
});

describe("tokens of a service account", () => {
	it("are managed by owners and admins only, never by the sponsor, and have the scopes of the account", async () => {
		const { owner, admin, ada, service } = await seedService(["mail.send", "chat.write"]);
		const before = Date.now();
		const { api_key } = await admin.call("account.create_api_key", {
			principal_id: service.id,
			label: "deploy",
			description: "GitHub Actions",
			expires_in_days: 7,
		});
		expect(api_key).toMatchObject({
			principal_id: service.id,
			description: "GitHub Actions",
			created_by: admin.id,
			// A token has no scopes of its own. It shows the scopes of its account.
			scopes: ["mail.send", "chat.write"],
			expired: false,
			revoked: false,
			revoked_by: null,
		});
		const end = Date.parse(api_key.expires_at ?? "");
		expect(end).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
		expect(end).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
		// The owner manages them too.
		expect((await owner.call("account.list_api_keys", { principal_id: service.id })).api_keys).toHaveLength(1);

		// The sponsor gets no right from that role, unlike the sponsor of an agent.
		expect(await codeOf(ada.call("account.list_api_keys", { principal_id: service.id }))).toBe("forbidden");
		expect(await codeOf(ada.call("account.create_api_key", { principal_id: service.id, label: "x" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(ada.call("account.revoke_api_key", { key_id: api_key.id }))).toBe("forbidden");

		// A token takes no scopes of its own, also not the scopes of the account. A key of a person needs scopes.
		expect(
			await codeOf(
				admin.call("account.create_api_key", { principal_id: service.id, label: "x", scopes: ["mail.send"] }),
			),
		).toBe("invalid");
		expect(await codeOf(admin.call("account.create_api_key", { label: "x" }))).toBe("invalid");
		// A new token gives each scope of the account. A narrow key of an admin that does not hold them cannot
		// create one, or it gets a secret with scopes that it does not hold.
		const narrow = await admin.call("account.create_api_key", { label: "narrow", scopes: ["account.keys"] });
		expect(
			await codeOf(api(narrow.api_key.secret)("account.create_api_key", { principal_id: service.id, label: "x" })),
		).toBe("forbidden");
	});

	it("get a change of the scopes of the account at their next call, each one", async () => {
		const { owner, admin, ada, bot, service } = await seedService(["account.read", "mail.read"]);
		const first = await serviceToken(admin, service.id);
		const second = await serviceToken(admin, service.id);
		await first.call("mail.list_threads", {});
		expect(await codeOf(second.call("chat.list_rooms", {}))).toBe("forbidden");

		// Only owners and admins change the access of a service account: not its sponsor. A person has none.
		const change = { principal_id: service.id, scopes: ["account.read" as const, "chat.read" as const] };
		for (const caller of [ada, bot, first]) {
			expect(await codeOf(caller.call("directory.set_agent_access", change))).toBe("forbidden");
		}
		expect(await codeOf(admin.call("directory.set_agent_access", { ...change, principal_id: ada.id }))).toBe(
			"not_found",
		);
		// The list has only scopes that a service account can hold, and the call needs a field to change.
		expect(
			await codeOf(admin.call("directory.set_agent_access", { ...change, scopes: ["account.keys" as never] })),
		).toBe("invalid");
		expect(await codeOf(admin.call("directory.set_agent_access", { principal_id: service.id }))).toBe("invalid");
		// A key with directory.write cannot give the account a scope that the key does not hold.
		const writer = await admin.call("account.create_api_key", {
			label: "writer",
			scopes: ["directory.write", "account.read"],
		});
		const asWriter = api(writer.api_key.secret);
		expect(await codeOf(asWriter("directory.set_agent_access", change))).toBe("forbidden");
		// The limits say where each scope applies. So the same key cannot change the limits of an account that
		// has mail.read, which the key does not hold.
		expect(
			await codeOf(
				asWriter("directory.set_agent_access", {
					principal_id: service.id,
					resources: { mailbox_ids: [], drive_ids: [], room_ids: [] },
				}),
			),
		).toBe("forbidden");

		// The owner changes the scopes through MCP: the operation has REST and MCP.
		const viaMcp = await callTool(owner.key, "directory_set_agent_access", change);
		expect(viaMcp.isError).toBeFalsy();
		expect(viaMcp.structuredContent).toEqual({
			principal_id: service.id,
			scopes: ["account.read", "chat.read"],
			resources: null,
		});
		// Both tokens lose mail.read and get chat.read, without a new secret.
		for (const token of [first, second]) {
			expect(await codeOf(token.call("mail.list_threads", {}))).toBe("forbidden");
			await token.call("chat.list_rooms", {});
			expect((await token.call("account.whoami")).scopes).toEqual(["account.read", "chat.read"]);
		}
		const listed = (await admin.call("account.list_api_keys", { principal_id: service.id })).api_keys;
		expect(listed.map((key) => key.scopes)).toEqual([
			["account.read", "chat.read"],
			["account.read", "chat.read"],
		]);
		// The change is in the log of the account, as a change of an admin.
		await vi.waitFor(async () => {
			const page = await admin.call("directory.list_service_account_activity", { principal_id: service.id });
			expect(page.entries.map((entry) => [entry.operation, entry.surface, entry.actor_id])).toContainEqual([
				"directory.set_agent_access",
				"admin",
				owner.id,
			]);
		});
	});

	// A scheduled message is a lasting effect of a token. It must not post with access that the account lost.
	it("post no scheduled message after the account loses chat.write or gets limits, also without a binding", async () => {
		const { admin, service } = await seedService(["account.read", "chat.read", "chat.write"]);
		const token = await serviceToken(admin, service.id);
		const { room } = await admin.call("chat.create_room", { kind: "private", name: "ci", member_ids: [service.id] });
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(service.id));
		const schedule = async (text: string) =>
			(
				await token.call("chat.schedule_message", {
					room_id: room.id,
					text,
					send_at: new Date(Date.now() + 120_000).toISOString(),
				})
			).scheduled;
		/** Makes the message due, and runs the alarm that sends due messages. */
		const fire = async (id: string) => {
			await runInDurableObject(principal, async (_instance, state) => {
				state.storage.sql.exec("UPDATE chat_scheduled_messages SET send_at = ? WHERE id = ?", Date.now() - 1000, id);
				await state.storage.setAlarm(Date.now() + 60_000);
			});
			await runDurableObjectAlarm(principal);
		};
		const texts = async () =>
			(await admin.call("chat.list_messages", { room_id: room.id })).messages.map((message) => message.text);
		const statusOf = async (id: string) =>
			runInDurableObject(
				principal,
				(_instance, state) =>
					state.storage.sql
						.exec<{ status: string }>("SELECT status FROM chat_scheduled_messages WHERE id = ?", id)
						.one().status,
			);

		// With chat.write and no limits, the message posts.
		const sent = await schedule("Build 1 passed.");
		await fire(sent.id);
		expect(await texts()).toEqual(["Build 1 passed."]);

		// The account loses chat.write: the message does not post.
		const unscoped = await schedule("Build 2 passed.");
		await setScopes(admin, service.id, ["account.read", "chat.read"]);
		await fire(unscoped.id);
		expect(await statusOf(unscoped.id)).toBe("failed");

		// The account gets limits, also with the room in its list: a limited account cannot schedule, so the
		// message of before the limits does not post.
		await setScopes(admin, service.id, ["account.read", "chat.read", "chat.write"]);
		const limited = await schedule("Build 3 passed.");
		await admin.call("directory.set_agent_access", {
			principal_id: service.id,
			resources: { mailbox_ids: [], drive_ids: [], room_ids: [room.id] },
		});
		await fire(limited.id);
		expect(await statusOf(limited.id)).toBe("failed");

		// A message from before the credential binding has no binding. It needs the same access.
		await admin.call("directory.set_agent_access", { principal_id: service.id, resources: null });
		const legacy = await schedule("Build 4 passed.");
		await runInDurableObject(principal, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE chat_scheduled_messages SET credential_binding_json = NULL WHERE id = ?",
				legacy.id,
			);
		});
		await setScopes(admin, service.id, ["account.read", "chat.read"]);
		await fire(legacy.id);
		expect(await statusOf(legacy.id)).toBe("failed");
		expect(await texts()).toEqual(["Build 1 passed."]);
	});

	it("lose their live connections when the scopes or the limits of the account change", async () => {
		const { admin, service } = await seedService(["account.read", "chat.read"]);
		const token = await serviceToken(admin, service.id);
		const { room } = await admin.call("chat.create_room", { kind: "private", name: "ci", member_ids: [service.id] });
		const refsOf = () =>
			runInDurableObject(env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id)), (_instance, state) =>
				state
					.getWebSockets()
					.map((socket) => (socket.deserializeAttachment() as { credential: CredentialRef }).credential),
			);
		const open = async () => {
			const opened = await upgradeRoomSocket(room.id, bearer(token.key));
			expect(opened.status).toBe(101);
			opened.webSocket?.accept();
		};
		await open();
		const events = readSocket(
			await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(token.key) } }),
		);
		expect(await events.next()).toMatchObject({ type: "hello" });
		const before = await refsOf();
		expect(before.map((ref) => ref.av)).toEqual([undefined]);
		expect(await checkCredentials(env.DIRECTORY, before)).toEqual(["live"]);

		// A save of the access that the account has changes nothing: the connections stay live. So a script can
		// send the wanted access again and again.
		const version = async () =>
			(
				await env.DIRECTORY.prepare("SELECT access_version FROM principals WHERE id = ?")
					.bind(service.id)
					.first<{ access_version: number }>()
			)?.access_version;
		await admin.call("directory.set_agent_access", {
			principal_id: service.id,
			scopes: ["chat.read", "account.read"],
			resources: null,
		});
		expect(await version()).toBe(0);
		expect(await checkCredentials(env.DIRECTORY, before)).toEqual(["live"]);

		// A change of the limits closes the events socket at once, and the reference of the room socket must open
		// again. The token still works, so the code tells the client to open a new socket, not to stop.
		await admin.call("directory.set_agent_access", {
			principal_id: service.id,
			resources: { mailbox_ids: [], drive_ids: [], room_ids: [room.id] },
		});
		expect(await version()).toBe(1);
		expect(await events.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.reconnect });
		expect(await checkCredentials(env.DIRECTORY, before)).toEqual(["renew"]);
		// A new socket has the number of the new access, and is live.
		await open();
		const after = (await refsOf()).filter((ref) => ref.av !== undefined);
		expect(after.map((ref) => ref.av)).toEqual([1]);
		expect(await checkCredentials(env.DIRECTORY, after)).toEqual(["live"]);
	});

	it("lose all rights when the admin who made them becomes a member", async () => {
		const { owner, admin, service } = await seedService();
		const token = await serviceToken(admin, service.id);
		await owner.call("directory.update_principal", { principal_id: admin.id, org_role: "member" });
		expect(await codeOf(admin.call("account.list_api_keys", { principal_id: service.id }))).toBe("forbidden");
		expect(await codeOf(admin.call("account.revoke_api_key", { key_id: token.keyId }))).toBe("forbidden");
		// The token itself still works: the owner manages it now.
		await token.call("account.whoami");
	});

	it("take a custom end only between one minute and 730 days from now", async () => {
		const { admin, service } = await seedService();
		const create = (expires_at: string) =>
			admin.call("account.create_api_key", { principal_id: service.id, label: "x", expires_at });
		const soon = new Date(Date.now() + 10_000).toISOString();
		const far = new Date(Date.now() + 731 * 86_400_000).toISOString();
		expect(await codeOf(create(soon))).toBe("invalid");
		expect(await codeOf(create(far))).toBe("invalid");
		const end = new Date(Date.now() + 3 * 3_600_000);
		const { api_key } = await create(end.toISOString());
		expect(api_key.expires_at).toBe(end.toISOString());
		// A time without milliseconds is stored in the full form, so a compare of two ends as text is correct.
		const whole = new Date(Math.floor(end.getTime() / 1000) * 1000);
		const short = whole.toISOString().replace(".000Z", "Z");
		expect(short).not.toBe(whole.toISOString());
		expect((await create(short)).api_key.expires_at).toBe(whole.toISOString());
	});

	it("stop at once when revoked, record who revoked them, and leave the other tokens working", async () => {
		const { admin, service } = await seedService();
		const first = await serviceToken(admin, service.id);
		const second = await serviceToken(admin, service.id);
		expect((await admin.call("account.revoke_api_key", { key_id: first.keyId })).revoked).toBe(true);
		expect(await codeOf(first.call("account.whoami"))).toBe("unauthenticated");
		await second.call("account.whoami");
		const keys = (await admin.call("account.list_api_keys", { principal_id: service.id })).api_keys;
		expect(keys.find((key) => key.id === first.keyId)).toMatchObject({ revoked: true, revoked_by: admin.id });
		expect(keys.find((key) => key.id === second.keyId)).toMatchObject({ revoked: false, revoked_at: null });
		// A second revoke changes nothing.
		expect((await admin.call("account.revoke_api_key", { key_id: first.keyId })).revoked).toBe(true);
	});
});

describe("rotation of a token", () => {
	it("gives a new secret and keeps the old one for its overlap, for owners and admins only", async () => {
		const { owner, admin, ada, bot, service } = await seedService(["account.read", "chat.read"]);
		const token = await serviceToken(admin, service.id, { expires_in_days: 30 });
		const before = (await admin.call("account.list_api_keys", { principal_id: service.id })).api_keys[0];
		// The sponsor, a member, an agent and the token itself cannot rotate it.
		const rotate = { key_id: token.keyId };
		expect(await codeOf(ada.call("account.rotate_api_key", rotate))).toBe("forbidden");
		expect(await codeOf(bot.call("account.rotate_api_key", rotate))).toBe("forbidden");
		expect(await codeOf(token.call("account.rotate_api_key", rotate))).toBe("forbidden");

		const { api_key } = await admin.call("account.rotate_api_key", { key_id: token.keyId, overlap_minutes: 60 });
		expect(api_key).toMatchObject({
			id: token.keyId,
			scopes: ["account.read", "chat.read"],
			expires_at: before?.expires_at,
			rotated_by: admin.id,
		});
		expect(Date.parse(api_key.previous_secret_expires_at ?? "")).toBeGreaterThan(Date.now() + 59 * 60_000);
		const fresh = api(api_key.secret);
		// Both secrets work during the overlap. A second rotation must wait for its end.
		await token.call("account.whoami");
		await fresh("account.whoami");
		expect(await codeOf(owner.call("account.rotate_api_key", rotate))).toBe("conflict");
		// A room socket of each secret keeps the reference of its secret. Both are live during the overlap.
		const { room } = await admin.call("chat.create_room", { kind: "private", name: "ci", member_ids: [service.id] });
		for (const secret of [token.key, api_key.secret]) {
			const opened = await upgradeRoomSocket(room.id, bearer(secret));
			expect(opened.status).toBe(101);
			opened.webSocket?.accept();
		}
		const refs = await runInDurableObject(env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id)), (_instance, state) =>
			state
				.getWebSockets()
				.map((socket) => (socket.deserializeAttachment() as { credential: CredentialRef }).credential)
				// The order of the sockets is not fixed. The old secret has no number, the new one has 1.
				.sort((a, b) => (a.gen ?? 0) - (b.gen ?? 0)),
		);
		expect(refs.map((ref) => ref.gen)).toEqual([undefined, 1]);
		expect(await checkCredentials(env.DIRECTORY, refs)).toEqual(["live", "live"]);

		// The end of the overlap ends the socket of the old secret only.
		await owner.call("account.end_api_key_rotation", rotate);
		expect(await codeOf(token.call("account.whoami"))).toBe("unauthenticated");
		await fresh("account.whoami");
		expect(await checkCredentials(env.DIRECTORY, refs)).toEqual(["ended", "live"]);
		const listed = (await admin.call("account.list_api_keys", { principal_id: service.id })).api_keys[0];
		expect(listed?.previous_secret_expires_at).toBeNull();

		// Rotation and its end are changes of an admin in the log.
		const page = await activityOf(admin, service.id, 4, token.keyId);
		const changes = page.entries.filter((entry) => entry.surface === "admin");
		expect(changes.map((entry) => entry.operation).slice(0, 2)).toEqual([
			"account.end_api_key_rotation",
			"account.rotate_api_key",
		]);
	});

	it("stops the old secret after its overlap or at once, and refuses a revoked or expired key or a narrower credential", async () => {
		const { admin, ada, service } = await seedService(["account.read"]);
		const token = await serviceToken(admin, service.id);
		const first = await admin.call("account.rotate_api_key", { key_id: token.keyId, overlap_minutes: 30 });
		// The overlap ends: the old secret is refused with the reason rotated.
		await env.DIRECTORY.prepare("UPDATE api_keys SET prev_expires_at = ? WHERE id = ?").bind(PAST, token.keyId).run();
		expect(await codeOf(token.call("account.whoami"))).toBe("unauthenticated");
		await api(first.api_key.secret)("account.whoami");
		await vi.waitFor(async () => {
			const page = await admin.call("directory.list_service_account_activity", {
				principal_id: service.id,
				key_id: token.keyId,
			});
			expect(page.entries.find((entry) => entry.operation === "auth.refused_token")).toMatchObject({
				code: "rotated",
				surface: "rest",
			});
		});
		// An overlap of 0 stops the old secret at once. The overlap of the last rotation ended, so it may rotate.
		const second = await admin.call("account.rotate_api_key", { key_id: token.keyId, overlap_minutes: 0 });
		expect(second.api_key.previous_secret_expires_at).toBeNull();
		expect(await codeOf(api(first.api_key.secret)("account.whoami"))).toBe("unauthenticated");
		await api(second.api_key.secret)("account.whoami");
		// A revoke stops each secret. A revoked key, and an expired key, cannot rotate.
		const third = await admin.call("account.rotate_api_key", { key_id: token.keyId, overlap_minutes: 60 });
		await admin.call("account.revoke_api_key", { key_id: token.keyId });
		expect(await codeOf(api(second.api_key.secret)("account.whoami"))).toBe("unauthenticated");
		expect(await codeOf(api(third.api_key.secret)("account.whoami"))).toBe("unauthenticated");
		expect(await codeOf(admin.call("account.rotate_api_key", { key_id: token.keyId }))).toBe("conflict");
		const other = await serviceToken(admin, service.id);
		await expire(other.keyId);
		expect(await codeOf(admin.call("account.rotate_api_key", { key_id: other.keyId }))).toBe("conflict");
		// A person rotates their own key.
		const own = await ada.call("account.create_api_key", { label: "laptop", scopes: ["account.read"] });
		const rotated = await ada.call("account.rotate_api_key", { key_id: own.api_key.id });
		await api(rotated.api_key.secret)("account.whoami");
		// A narrow key cannot rotate a wider key, because the new secret would give scopes that it does not hold.
		const wide = await ada.call("account.create_api_key", { label: "wide", scopes: ["account.read", "mail.read"] });
		const narrow = await ada.call("account.create_api_key", { label: "narrow", scopes: ["account.keys"] });
		const asNarrow = api(narrow.api_key.secret);
		expect(await codeOf(asNarrow("account.rotate_api_key", { key_id: wide.api_key.id }))).toBe("forbidden");
		// A new secret of a token of a service account gives each scope of the account.
		const narrowAdmin = await admin.call("account.create_api_key", { label: "narrow", scopes: ["account.keys"] });
		const wideToken = await serviceToken(admin, service.id);
		expect(await codeOf(api(narrowAdmin.api_key.secret)("account.rotate_api_key", { key_id: wideToken.keyId }))).toBe(
			"forbidden",
		);
	});
});

describe("the lifetime of an API key", () => {
	it("ends a token of a service account, and a key of a person, on REST, on MCP and for live connections", async () => {
		const { owner, admin, ada, service } = await seedService();
		const token = await serviceToken(admin, service.id, { expires_in_days: 1 });
		const personal = await ada.call("account.create_api_key", {
			label: "laptop",
			scopes: ["account.read"],
			expires_in_days: 30,
		});
		const forever = await ada.call("account.create_api_key", { label: "server", scopes: ["account.read"] });
		expect(forever.api_key.expires_at).toBeNull();
		await token.call("account.whoami");
		await api(personal.api_key.secret)("account.whoami");

		await expire(token.keyId);
		await expire(personal.api_key.id);
		expect(await codeOf(token.call("account.whoami"))).toBe("unauthenticated");
		expect(await codeOf(api(personal.api_key.secret)("account.whoami"))).toBe("unauthenticated");
		expect((await mcp(token.key, "tools/list")).status).toBe(401);
		await api(forever.api_key.secret)("account.whoami");

		// A socket and a lasting effect stop with the key.
		const refs = [
			{ principalId: service.id, kind: "api_key" as const, id: token.keyId },
			{ principalId: ada.id, kind: "api_key" as const, id: forever.api_key.id },
		];
		expect(await checkCredentials(env.DIRECTORY, refs)).toEqual(["ended", "live"]);
		expect(await credentialState(env.DIRECTORY, { principalId: service.id, kind: "api_key", id: token.keyId })).toEqual(
			{ state: "ended" },
		);

		const listed = (await owner.call("account.list_api_keys", { principal_id: service.id })).api_keys;
		expect(listed[0]).toMatchObject({ expired: true, revoked: false, expires_at: PAST });
	});
});

describe("calls of a service account", () => {
	it("act as a service account with the agent rules, and never reach keys, the directory, OAuth or webhooks", async () => {
		const { admin, service } = await seedService();
		const token = await serviceToken(admin, service.id);
		const whoami = await token.call("account.whoami");
		expect(whoami).toMatchObject({ principal: { kind: "service" }, credential: "api_key", sign_in: null });
		expect(whoami.missing_scopes).toEqual([]);
		// A token of a narrow account learns what the account misses, with the text of a service account, not
		// of a person.
		const small = await admin.call("directory.create_service_account", {
			display_name: "Small",
			address: "small@dock.test",
			scopes: ["account.read"],
		});
		const narrow = await serviceToken(admin, small.principal.id);
		const missing = (await narrow.call("account.whoami")).missing_scopes;
		expect(missing.find((entry) => entry.scope === "mail.read")?.description).toBe(
			SERVICE_SCOPE_DESCRIPTIONS["mail.read"],
		);

		expect(await codeOf(token.call("account.create_api_key", { label: "x", scopes: ["mail.read"] }))).toBe("forbidden");
		expect(
			await codeOf(
				token.call("directory.create_principal", { kind: "agent", display_name: "X", address: "x@dock.test" }),
			),
		).toBe("forbidden");
		expect(await codeOf(token.call("oauth.list_grants", {}))).toBe("forbidden");
		expect(await codeOf(token.call("webhooks.list_endpoints", {}))).toBe("forbidden");
		expect(await codeOf(token.call("chat.set_status", { status: null }))).toBe("forbidden");

		// The outbound policy of an agent applies: internal-only refuses an external recipient.
		expect(await codeOf(token.call("mail.send", { to: ["someone@external.example"], text: "Hi" }))).toBe(
			"policy_denied",
		);
		await token.call("mail.send", { to: ["ada@dock.test"], text: "Build 42 passed." });

		// MCP lists only the tools that a service account can call.
		const listed = await mcp(token.key, "tools/list");
		const tools = ((listed.body?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map(
			(tool) => tool.name,
		);
		expect(tools).toContain("mail_send");
		expect(tools).not.toContain("webhooks_create_endpoint");
		expect(tools).not.toContain("account_create_api_key");
		expect(tools.some((name) => name.startsWith("oauth_"))).toBe(false);
	});

	it("reach a team mailbox only as a member", async () => {
		const { owner, admin, service } = await seedService();
		const token = await serviceToken(admin, service.id);
		const { team_mailbox } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [],
		});
		expect(await codeOf(token.call("mail.list_threads", { mailbox_id: team_mailbox.id }))).toBe("forbidden");
		await owner.call("directory.add_team_mailbox_member", { mailbox_id: team_mailbox.id, principal_id: service.id });
		await token.call("mail.list_threads", { mailbox_id: team_mailbox.id });
	});

	it("get a policy change from an owner or an admin only, and no OAuth connection", async () => {
		const { admin, ada, service } = await seedService();
		const policy = { principal_id: service.id, mode: "any" as const, allowlist: [] };
		expect(await codeOf(ada.call("directory.update_agent_policy", policy))).toBe("forbidden");
		const changed = await admin.call("directory.update_agent_policy", policy);
		expect(changed.principal).toMatchObject({ kind: "service", outbound_policy: { mode: "any" } });
		const token = await serviceToken(admin, service.id);
		await token.call("mail.send", { to: ["someone@external.example"], text: "Hi" });
	});
});

describe("webhooks for a service account", () => {
	it("are refused for its sponsor, through REST and through MCP Events", async () => {
		const { ada, service } = await seedService();
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: HOOK });
		expect(
			await codeOf(ada.call("mail.create_webhook_subscription", { endpoint_id: endpoint.id, mailbox_id: service.id })),
		).toBe("forbidden");
		expect(
			await codeOf(
				ada.call("chat.create_webhook_subscription", {
					endpoint_id: endpoint.id,
					event: "chat.message.created",
					principal_id: service.id,
				}),
			),
		).toBe("forbidden");
		expect(
			await codeOf(
				ada.call("drive.create_webhook_subscription", {
					endpoint_id: endpoint.id,
					event: "drive.item.created",
					space_id: service.id,
				}),
			),
		).toBe("forbidden");
		// MCP Events uses the same check of the target. No request goes to the callback.
		const posts = receiveWebhooks();
		const answer = await mcp(ada.key, "events/subscribe", {
			name: "mail.inbox.updated",
			arguments: { mailbox_id: service.id },
			delivery: { mode: "webhook", url: `${HOOK}/events`, secret: `whsec_${base64("k".repeat(32))}` },
			cursor: null,
		});
		expect(answer.body?.error).toMatchObject({ data: { code: "forbidden" } });
		expect(posts).toEqual([]);
	});

	it("stop with access_lost at the next delivery, when the target became a service account", async () => {
		const { ada, bot } = await seedService();
		// Ada subscribes for the agent that she sponsors. Then the row of the agent becomes a service account,
		// as a subscription from before the rule, or from a Worker of an earlier version.
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: HOOK });
		const { subscription } = await ada.call("mail.create_webhook_subscription", {
			endpoint_id: endpoint.id,
			mailbox_id: bot.id,
		});
		await env.DIRECTORY.prepare("UPDATE principals SET service = 1 WHERE id = ?").bind(bot.id).run();
		const posts = receiveWebhooks();
		await consumeWebhooks([
			{
				v: 1,
				kind: "delivery",
				webhookId: subscription.id,
				mailboxId: bot.id,
				eventId: "evt_01JC0000000000000000000000",
				occurredAt: Date.now(),
				attempt: 1,
			},
		]);
		expect(posts).toEqual([]);
		const stored = await env.DIRECTORY.prepare("SELECT status, disabled_reason FROM webhook_subscriptions WHERE id = ?")
			.bind(subscription.id)
			.first();
		expect(stored).toEqual({ status: "disabled", disabled_reason: "access_lost" });
	});
});

describe("the life of a service account", () => {
	it("stops its tokens while archived, revokes them on delete, and holds its sponsor until reassigned", async () => {
		const { owner, admin, ada, bot, service } = await seedService();
		const token = await serviceToken(admin, service.id);
		// Ada sponsors the agent and the service account, so she cannot leave yet.
		await owner.call("directory.update_principal", { principal_id: bot.id, sponsor_id: owner.id });
		expect(await codeOf(owner.call("directory.archive_principal", { principal_id: ada.id }))).toBe("conflict");
		expect(await codeOf(owner.call("directory.delete_principal", { principal_id: ada.id }))).toBe("conflict");

		await admin.call("directory.archive_principal", { principal_id: service.id });
		expect(await codeOf(token.call("account.whoami"))).toBe("unauthenticated");
		await admin.call("directory.restore_principal", { principal_id: service.id });
		await token.call("account.whoami");

		await admin.call("directory.update_principal", { principal_id: service.id, sponsor_id: admin.id });
		await owner.call("directory.archive_principal", { principal_id: ada.id });

		await admin.call("directory.delete_principal", { principal_id: service.id });
		expect(await codeOf(token.call("account.whoami"))).toBe("unauthenticated");
		const row = await env.DIRECTORY.prepare("SELECT revoked_at FROM api_keys WHERE id = ?")
			.bind(token.keyId)
			.first<{ revoked_at: string | null }>();
		expect(row?.revoked_at).not.toBeNull();
	});
});

describe("the activity log of a service account", () => {
	it("records a refused token at most once a minute, with the reason, and a refused socket open", async () => {
		const { owner, admin, service } = await seedService(["account.read"]);
		const revoked = await serviceToken(admin, service.id);
		const expired = await serviceToken(admin, service.id);
		const narrow = await serviceToken(admin, service.id);
		await admin.call("account.revoke_api_key", { key_id: revoked.keyId });
		await expire(expired.keyId);
		// Two refusals of one token within a minute add one entry.
		expect(await codeOf(revoked.call("account.whoami"))).toBe("unauthenticated");
		expect(await codeOf(revoked.call("account.whoami"))).toBe("unauthenticated");
		expect((await mcp(expired.key, "tools/list")).status).toBe(401);
		// A secret of no token names no account, so it adds nothing.
		expect((await request("/api/v1/account", { headers: bearer(`sdk_${"x".repeat(43)}`) })).status).toBe(401);
		// A socket that the account cannot open without chat.read. Then, with chat.read, a room of which the
		// account is not a member.
		const events = await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(narrow.key) } });
		expect(events.status).toBe(403);
		await setScopes(admin, service.id, ["account.read", "chat.read"]);
		const { room } = await owner.call("chat.create_room", { kind: "private", name: "secret" });
		expect((await upgradeRoomSocket(room.id, bearer(narrow.key))).status).toBeGreaterThanOrEqual(400);

		const interesting = <T extends { operation: string }>(entries: T[]) =>
			entries.filter((entry) => entry.operation === "auth.refused_token" || entry.operation.endsWith("_socket"));
		const entries = await vi.waitFor(async () => {
			const page = await admin.call("directory.list_service_account_activity", { principal_id: service.id });
			const found = interesting(page.entries);
			expect(found).toHaveLength(4);
			return found;
		});
		expect(entries.map((entry) => [entry.operation, entry.result, entry.code, entry.surface, entry.key_id])).toEqual(
			expect.arrayContaining([
				["auth.refused_token", "denied", "revoked", "rest", revoked.keyId],
				["auth.refused_token", "denied", "expired", "mcp", expired.keyId],
				["events.open_socket", "denied", "forbidden", "rest", narrow.keyId],
			]),
		);
		const roomEntry = entries.find((entry) => entry.operation === "chat.open_room_socket");
		expect(roomEntry).toMatchObject({ resource_id: room.id, key_id: narrow.keyId, surface: "rest" });
		expect(["denied", "error"]).toContain(roomEntry?.result);

		// The token of an archived account is refused with the reason archived.
		await admin.call("directory.archive_principal", { principal_id: service.id });
		expect(await codeOf(narrow.call("account.whoami"))).toBe("unauthenticated");
		await vi.waitFor(async () => {
			const page = await admin.call("directory.list_service_account_activity", {
				principal_id: service.id,
				key_id: narrow.keyId,
			});
			expect(page.entries[0]).toMatchObject({ operation: "auth.refused_token", code: "archived" });
		});
	});

	it("records the membership changes that others make for it, and not its own", async () => {
		const { owner, admin, ada, service } = await seedService(["chat.read", "chat.write"]);
		const token = await serviceToken(admin, service.id);
		const { shared_drive: drive } = await admin.call("drive.create_shared_drive", {
			name: "Ops",
			members: [
				{ principal_id: admin.id, role: "manager" },
				{ principal_id: service.id, role: "viewer" },
			],
		});
		await admin.call("drive.remove_shared_drive_member", { drive_id: drive.id, principal_id: service.id });
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "ada-room" });
		await ada.call("chat.add_members", { room_id: room.id, principal_ids: [service.id] });
		await ada.call("chat.remove_member", { room_id: room.id, principal_id: service.id });
		const file = (await ada.call("drive.upload_file", { name: "a.txt", content_base64: base64("a") })).item;
		await ada.call("drive.share_item", { item_id: file.id, principal_id: service.id, role: "viewer" });
		const { room: lobby } = await owner.call("chat.create_room", { kind: "public", name: "lobby" });
		await token.call("chat.join_room", { room_id: lobby.id });
		// The delete of its only member leaves a room without an owner. An admin makes the account its owner.
		const carol = await createActor(owner, {
			kind: "human",
			display_name: "Carol",
			address: "carol@dock.test",
			org_role: "member",
			password: PASSWORD,
		});
		const { room: orphan } = await carol.call("chat.create_room", { kind: "public", name: "orphan" });
		await owner.call("directory.delete_principal", { principal_id: carol.id });
		await admin.call("chat.admin_assign_owner", { room_id: orphan.id, principal_id: service.id });
		// An admin deletes a room and a shared drive of the account.
		const { room: doomed } = await admin.call("chat.create_room", {
			kind: "private",
			name: "doomed",
			member_ids: [service.id],
		});
		await admin.call("chat.delete_room", { room_id: doomed.id });
		const { shared_drive: gone } = await admin.call("drive.create_shared_drive", {
			name: "Gone",
			members: [
				{ principal_id: admin.id, role: "manager" },
				{ principal_id: service.id, role: "viewer" },
			],
		});
		await admin.call("drive.delete_shared_drive", { drive_id: gone.id });

		const memberships = new Set([
			"drive.create_shared_drive",
			"drive.remove_shared_drive_member",
			"chat.add_members",
			"chat.remove_member",
			"drive.share_item",
			"chat.join_room",
			"chat.admin_assign_owner",
			"chat.delete_room",
			"drive.delete_shared_drive",
		]);
		const entries = await vi.waitFor(async () => {
			const page = await admin.call("directory.list_service_account_activity", { principal_id: service.id });
			const found = page.entries.filter((entry) => memberships.has(entry.operation));
			expect(found).toHaveLength(10);
			return found;
		});
		expect(entries.map((entry) => [entry.operation, entry.surface, entry.actor_id, entry.resource_id])).toEqual(
			expect.arrayContaining([
				["drive.create_shared_drive", "admin", admin.id, drive.id],
				["drive.remove_shared_drive_member", "admin", admin.id, drive.id],
				// Ada is a member, so her changes have the surface member, with their own count limit.
				["chat.add_members", "member", ada.id, room.id],
				["chat.remove_member", "member", ada.id, room.id],
				["drive.share_item", "member", ada.id, file.id],
				// Its own join is its own call: one entry with the surface rest, and no admin entry.
				["chat.join_room", "rest", service.id, lobby.id],
				["chat.admin_assign_owner", "admin", admin.id, orphan.id],
				["chat.delete_room", "admin", admin.id, doomed.id],
				["drive.create_shared_drive", "admin", admin.id, gone.id],
				["drive.delete_shared_drive", "admin", admin.id, gone.id],
			]),
		);
	});

	it("records each call with its token, surface, result and request id, and each change by an admin", async () => {
		const { admin, service } = await seedService(["account.read", "mail.read", "mail.send"]);
		const token = await serviceToken(admin, service.id);
		await token.call("account.whoami");
		expect(await codeOf(token.call("chat.list_rooms", {}))).toBe("forbidden");
		expect(await codeOf(token.call("mail.send", { to: [], text: "x" }))).toBe("invalid");
		await callTool(token.key, "mail_list_mailboxes");
		// MCP refuses a tool outside the scopes before the invoker runs. The log still gets the refusal.
		expect((await mcp(token.key, "tools/call", { name: "chat_list_rooms", arguments: {} })).body).toHaveProperty(
			"error",
		);
		await admin.call("account.revoke_api_key", { key_id: token.keyId });

		const page = await activityOf(admin, service.id, 8);
		// The newest entry first.
		expect(page.entries.map((entry) => [entry.operation, entry.result, entry.surface])).toEqual([
			["account.revoke_api_key", "ok", "admin"],
			["chat.list_rooms", "denied", "mcp"],
			["mail.list_mailboxes", "ok", "mcp"],
			["mail.send", "error", "rest"],
			["chat.list_rooms", "denied", "rest"],
			["account.whoami", "ok", "rest"],
			["account.create_api_key", "ok", "admin"],
			["directory.create_service_account", "ok", "admin"],
		]);
		const [revoke, , , invalid, refused, whoami] = page.entries;
		expect(whoami).toMatchObject({ key_id: token.keyId, actor_id: service.id, code: null });
		expect(whoami?.request_id).toMatch(/\S/);
		expect(refused).toMatchObject({ code: "forbidden", key_id: token.keyId });
		expect(invalid).toMatchObject({ code: "invalid" });
		expect(revoke).toMatchObject({ actor_id: admin.id, key_id: token.keyId, resource_id: service.id });
	});

	it("names the resource of a call, pages with a cursor, and keeps the entries of one token", async () => {
		const { owner, admin, service } = await seedService();
		const first = await serviceToken(admin, service.id);
		const second = await serviceToken(admin, service.id);
		const { team_mailbox } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [service.id],
		});
		await first.call("mail.list_threads", { mailbox_id: team_mailbox.id });
		await second.call("account.whoami");
		await second.call("account.whoami");

		const own = await activityOf(admin, service.id, 1, first.keyId);
		expect(own.entries.map((entry) => entry.operation)).toEqual(["mail.list_threads", "account.create_api_key"]);
		expect(own.entries[0]?.resource_id).toBe(team_mailbox.id);

		const all = await activityOf(admin, service.id, 7);
		const one = await admin.call("directory.list_service_account_activity", { principal_id: service.id, limit: 2 });
		expect(one.entries).toEqual(all.entries.slice(0, 2));
		expect(one.next_cursor).not.toBeNull();
		const next = await admin.call("directory.list_service_account_activity", {
			principal_id: service.id,
			limit: 2,
			cursor: one.next_cursor ?? "",
		});
		expect(next.entries).toEqual(all.entries.slice(2, 4));
		expect(
			await codeOf(admin.call("directory.list_service_account_activity", { principal_id: service.id, cursor: "nope" })),
		).toBe("invalid");
	});

	it("records the open of the events socket and of a room socket, also as a feed of MCP", async () => {
		const { owner, admin, service } = await seedService(["chat.read"]);
		const token = await serviceToken(admin, service.id);
		const { room } = await owner.call("chat.create_room", {
			kind: "private",
			name: "builds",
			member_ids: [service.id],
		});
		const events = readSocket(
			await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(token.key) } }),
		);
		expect(await events.next()).toMatchObject({ type: "hello" });
		const roomSocket = readSocket(await upgradeRoomSocket(room.id, bearer(token.key)));
		expect(await roomSocket.next()).toMatchObject({ type: "hello" });
		const page = await activityOf(admin, service.id, 2, token.keyId);
		expect(
			page.entries.map((entry) => [entry.operation, entry.result, entry.surface, entry.resource_id]).reverse(),
		).toEqual([
			["account.create_api_key", "ok", "admin", service.id],
			["events.open_socket", "ok", "rest", null],
			["chat.open_room_socket", "ok", "rest", room.id],
		]);
		events.socket.close();
		roomSocket.socket.close();

		// subscriptions/listen opens the same sockets as feeds. Each feed adds one entry with the surface mcp.
		const feeds = readSse(
			await modernRequest(
				token.key,
				"subscriptions/listen",
				{ notifications: { resourceSubscriptions: [`asterra://chat/${room.id}/messages`, "asterra://chat/rooms"] } },
				{ id: "feeds" },
			),
		);
		expect(await feeds.next()).toMatchObject({ method: "notifications/subscriptions/acknowledged" });
		const opens = await vi.waitFor(async () => {
			const listed = await admin.call("directory.list_service_account_activity", {
				principal_id: service.id,
				key_id: token.keyId,
			});
			const mcpOpens = listed.entries.filter((entry) => entry.surface === "mcp" && entry.operation.includes("socket"));
			expect(mcpOpens).toHaveLength(2);
			return mcpOpens;
		});
		expect(opens.map((entry) => [entry.operation, entry.resource_id])).toEqual(
			expect.arrayContaining([
				["chat.open_room_socket", room.id],
				["events.open_socket", null],
			]),
		);
		await feeds.cancel();
	});

	it("keeps the newest calls and member changes of their limits and each change by an admin, and drops entries older than the days of the limit", async () => {
		const { admin, service } = await seedService();
		// The entry of the creation reaches the object first, so it cannot land between the rows below.
		await activityOf(admin, service.id, 1);
		const stub = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(service.id));
		const now = Date.now();
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql;
			sql.exec("DELETE FROM service_activity");
			// Two changes by an admin: one older than the days of the limit, and one inside them. Then calls up
			// to the limit, with a change by an admin at each 1,000th row, inside the newest calls. The next
			// insert is a multiple of 100, so it prunes.
			sql.exec(
				"INSERT INTO service_activity (seq, at, op, result, surface, actor_id) VALUES (1, ?, 'old', 'ok', 'admin', ?)",
				now - (SERVICE_ACTIVITY_LIMITS.days + 1) * 86_400_000,
				service.id,
			);
			sql.exec(
				"INSERT INTO service_activity (seq, at, op, result, surface, actor_id) VALUES (2, ?, 'change', 'ok', 'admin', ?)",
				now - 86_400_000,
				service.id,
			);
			for (let seq = 3; seq < SERVICE_ACTIVITY_LIMITS.entries + 100; seq++) {
				const admin = seq % 1000 === 0;
				sql.exec(
					"INSERT INTO service_activity (seq, at, op, result, surface, actor_id) VALUES (?, ?, ?, 'ok', ?, ?)",
					seq,
					now,
					admin ? "later" : "seed",
					admin ? "admin" : "rest",
					service.id,
				);
			}
			// Then 100 more changes by members than their limit. The last row keeps the next insert a multiple of 100.
			const firstMember = SERVICE_ACTIVITY_LIMITS.entries + 100;
			for (let seq = firstMember; seq < firstMember + SERVICE_ACTIVITY_LIMITS.memberChanges + 100; seq++) {
				sql.exec(
					"INSERT INTO service_activity (seq, at, op, result, surface, actor_id) VALUES (?, ?, 'chat.add_members', 'ok', 'member', ?)",
					seq,
					now,
					service.id,
				);
			}
		});
		await stub.recordServiceActivity({
			at: now,
			op: "account.whoami",
			result: "ok",
			code: null,
			surface: "rest",
			keyId: null,
			actorId: service.id,
			resourceId: null,
			requestId: null,
		});
		const count = await runInDurableObject(stub, (_instance, state) => ({
			calls: state.storage.sql
				.exec<{ n: number }>("SELECT COUNT(*) AS n FROM service_activity WHERE surface = 'rest'")
				.one().n,
			admin: state.storage.sql
				.exec<{ op: string }>("SELECT op FROM service_activity WHERE surface = 'admin'")
				.toArray()
				.map((row) => row.op),
			members: state.storage.sql
				.exec<{ n: number }>("SELECT COUNT(*) AS n FROM service_activity WHERE surface = 'member'")
				.one().n,
		}));
		// The count limits kept the newest calls and the newest member changes, as many as each limit, and each
		// change by an admin. The days limit removed `old`.
		expect(count).toEqual({
			calls: SERVICE_ACTIVITY_LIMITS.entries,
			admin: ["change", ...Array(10).fill("later")],
			members: SERVICE_ACTIVITY_LIMITS.memberChanges,
		});
	});

	it("is for owners and admins only, and for a service account only", async () => {
		const { admin, ada, bot, service } = await seedService();
		const token = await serviceToken(admin, service.id);
		const input = { principal_id: service.id };
		expect(await codeOf(ada.call("directory.list_service_account_activity", input))).toBe("forbidden");
		expect(await codeOf(bot.call("directory.list_service_account_activity", input))).toBe("forbidden");
		expect(await codeOf(token.call("directory.list_service_account_activity", input))).toBe("forbidden");
		expect(await codeOf(admin.call("directory.list_service_account_activity", { principal_id: bot.id }))).toBe(
			"not_found",
		);
		// MCP gives the same list.
		const viaMcp = await callTool(admin.key, "directory_list_service_account_activity", input);
		expect(viaMcp.isError).toBeFalsy();
		// A person and an agent get no log.
		await ada.call("account.whoami");
		const stub = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
		expect((await stub.listServiceActivity({ before: null, keyId: null, limit: 10 })).entries).toEqual([]);
	});
});

describe("the access of a service account", () => {
	it("lists its scopes, its team mailboxes, shared drives, rooms and items shared directly, with its role, and its live tokens", async () => {
		const { owner, admin, ada, service } = await seedService(["mail.read", "chat.read"]);
		const live = await serviceToken(admin, service.id);
		const revoked = await serviceToken(admin, service.id);
		const expired = await serviceToken(admin, service.id);
		await admin.call("account.revoke_api_key", { key_id: revoked.keyId });
		await expire(expired.keyId);
		const { team_mailbox } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [service.id],
		});
		const { shared_drive: drive } = await owner.call("drive.create_shared_drive", {
			name: "Releases",
			members: [
				{ principal_id: owner.id, role: "manager" },
				{ principal_id: service.id, role: "editor" },
			],
		});
		const { room } = await owner.call("chat.create_room", {
			kind: "private",
			name: "builds",
			member_ids: [service.id],
		});
		const { room: dm } = await owner.call("chat.open_dm", { principal_id: service.id });
		await sendMemberStates(owner.id, service.id);
		// Ada shares three files directly with the account. She then removes one share and trashes one file.
		const upload = async (name: string) =>
			(await ada.call("drive.upload_file", { name, content_base64: base64(name) })).item;
		const kept = await upload("kept.txt");
		const unshared = await upload("gone.txt");
		const trashed = await upload("trash.txt");
		for (const item of [kept, unshared, trashed]) {
			await ada.call("drive.share_item", { item_id: item.id, principal_id: service.id, role: "viewer" });
		}
		await ada.call("drive.unshare_item", { item_id: unshared.id, principal_id: service.id });
		await ada.call("drive.trash_items", { item_ids: [trashed.id] });

		const access = await vi.waitFor(async () => {
			const result = await admin.call("directory.get_agent_access", { principal_id: service.id });
			expect(result.shared_drives).toHaveLength(1);
			expect(result.chat_rooms).toHaveLength(2);
			return result;
		});
		expect(access).toEqual({
			principal_id: service.id,
			team_mailboxes: [{ id: team_mailbox.id, display_name: "Support", address: "support@dock.test" }],
			shared_drives: [{ id: drive.id, name: "Releases", role: "editor" }],
			// A direct message names its other member, so an admin can tell two of them apart.
			chat_rooms: [
				{ id: room.id, kind: "private", name: "builds", peer_name: null, role: "member" },
				{ id: dm.id, kind: "dm", name: null, peer_name: "Olive Owner", role: "member" },
			],
			chat_rooms_truncated: false,
			drive_shared_items: [{ space_id: ada.id, item_id: kept.id, name: "kept.txt", kind: "file", role: "viewer" }],
			drive_shared_items_truncated: false,
			// A token has no scopes of its own: the scopes and the limits are those of the account.
			tokens: [{ key_id: live.keyId, label: "deploy", expires_at: null }],
			scopes: ["mail.read", "chat.read"],
			resources: null,
		});
		const viaMcp = await callTool(admin.key, "directory_get_agent_access", { principal_id: service.id });
		expect(viaMcp.structuredContent).toEqual(access);
	});

	it("is for owners and admins only", async () => {
		const { admin, ada, bot, service } = await seedService();
		const token = await serviceToken(admin, service.id);
		const input = { principal_id: service.id };
		expect(await codeOf(ada.call("directory.get_agent_access", input))).toBe("forbidden");
		expect(await codeOf(bot.call("directory.get_agent_access", input))).toBe("forbidden");
		expect(await codeOf(token.call("directory.get_agent_access", input))).toBe("forbidden");
		expect(await codeOf(admin.call("directory.get_agent_access", { principal_id: ada.id }))).toBe("not_found");
	});
});

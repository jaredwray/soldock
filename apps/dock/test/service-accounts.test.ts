import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SERVICE_ACTIVITY_LIMITS, SERVICE_SCOPES } from "@asterra/contracts";
import { describe, expect, it, vi } from "vitest";
import { checkCredentials, credentialState } from "../src/identity/index.ts";
import { type Actor, api, callTool, codeOf, createActor, mcp, PASSWORD, seedOrg, sendMemberStates } from "./helpers.ts";

// Service accounts: a third kind of member. Owners and admins create one, give it tokens with a lifetime,
// read its activity and see what it can reach. In mail, Drive and Chat it is an agent.

const PAST = "2020-01-01T00:00:00.000Z";

/** The owner, an admin, a member (Ada), the agent of Ada, and a service account that Ada sponsors. */
async function seedService() {
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
	});
	return { owner, admin, ada, bot, service: principal };
}

/** A token of the service account, made by `by`, as an actor that calls the API with it. */
async function serviceToken(
	by: Actor,
	serviceId: string,
	scopes = [...SERVICE_SCOPES],
	extra: { expires_in_days?: number; expires_at?: string; description?: string } = {},
): Promise<Actor & { keyId: string }> {
	const { api_key } = await by.call("account.create_api_key", {
		principal_id: serviceId,
		label: "deploy",
		scopes,
		...extra,
	});
	return { id: serviceId, address: "ci@dock.test", key: api_key.secret, call: api(api_key.secret), keyId: api_key.id };
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
	it("are created by owners and admins only, with a description, a creator, a sponsor and no token", async () => {
		const { owner, admin, ada, bot, service } = await seedService();
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
		// The owner can create one through MCP too. The sponsor is the caller by default.
		const viaMcp = await callTool(owner.key, "directory_create_service_account", {
			display_name: "Backup Job",
			address: "backup@dock.test",
		});
		expect(viaMcp.isError).toBeFalsy();
		expect(viaMcp.structuredContent).toMatchObject({ principal: { kind: "service", sponsor_id: owner.id } });

		const input = { display_name: "Nope", address: "nope@dock.test" };
		const token = await serviceToken(admin, service.id);
		expect(await codeOf(ada.call("directory.create_service_account", input))).toBe("forbidden");
		expect(await codeOf(bot.call("directory.create_service_account", input))).toBe("forbidden");
		expect(await codeOf(token.call("directory.create_service_account", input))).toBe("forbidden");
		// A narrow key of an admin without directory.write cannot create one.
		const { api_key } = await admin.call("account.create_api_key", { label: "narrow", scopes: ["account.keys"] });
		expect(await codeOf(api(api_key.secret)("directory.create_service_account", input))).toBe("forbidden");
		// The address follows the rules of a principal: a saved domain, and no other holder.
		expect(
			await codeOf(admin.call("directory.create_service_account", { display_name: "X", address: "x@unknown.test" })),
		).toBe("invalid");
		expect(
			await codeOf(admin.call("directory.create_service_account", { display_name: "X", address: "ci@dock.test" })),
		).toBe("conflict");
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
});

describe("tokens of a service account", () => {
	it("are managed by owners and admins only, never by the sponsor, and hold only service scopes", async () => {
		const { owner, admin, ada, service } = await seedService();
		const before = Date.now();
		const { api_key } = await admin.call("account.create_api_key", {
			principal_id: service.id,
			label: "deploy",
			description: "GitHub Actions",
			scopes: ["mail.send", "chat.write"],
			expires_in_days: 7,
		});
		expect(api_key).toMatchObject({
			principal_id: service.id,
			description: "GitHub Actions",
			created_by: admin.id,
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
		expect(
			await codeOf(ada.call("account.create_api_key", { principal_id: service.id, label: "x", scopes: ["mail.read"] })),
		).toBe("forbidden");
		expect(await codeOf(ada.call("account.revoke_api_key", { key_id: api_key.id }))).toBe("forbidden");

		// A token cannot hold a scope outside the ceiling of a service account.
		for (const scope of ["account.keys", "directory.write", "mail.webhooks", "chat.webhooks"] as const) {
			expect(
				await codeOf(admin.call("account.create_api_key", { principal_id: service.id, label: "x", scopes: [scope] })),
			).toBe("invalid");
		}
		// A narrow key of an admin cannot grant a scope that it does not hold.
		const narrow = await admin.call("account.create_api_key", { label: "narrow", scopes: ["account.keys"] });
		expect(
			await codeOf(
				api(narrow.api_key.secret)("account.create_api_key", {
					principal_id: service.id,
					label: "x",
					scopes: ["mail.read"],
				}),
			),
		).toBe("forbidden");
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
			admin.call("account.create_api_key", { principal_id: service.id, label: "x", scopes: ["mail.read"], expires_at });
		const soon = new Date(Date.now() + 10_000).toISOString();
		const far = new Date(Date.now() + 731 * 86_400_000).toISOString();
		expect(await codeOf(create(soon))).toBe("invalid");
		expect(await codeOf(create(far))).toBe("invalid");
		const end = new Date(Date.now() + 3 * 3_600_000);
		const { api_key } = await create(end.toISOString());
		expect(api_key.expires_at).toBe(end.toISOString());
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

describe("the lifetime of an API key", () => {
	it("ends a token of a service account, and a key of a person, on REST, on MCP and for live connections", async () => {
		const { owner, admin, ada, service } = await seedService();
		const token = await serviceToken(admin, service.id, [...SERVICE_SCOPES], { expires_in_days: 1 });
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
	it("records each call with its token, surface, result and request id, and each change by an admin", async () => {
		const { admin, service } = await seedService();
		const token = await serviceToken(admin, service.id, ["account.read", "mail.read", "mail.send"]);
		await token.call("account.whoami");
		expect(await codeOf(token.call("chat.list_rooms", {}))).toBe("forbidden");
		expect(await codeOf(token.call("mail.send", { to: [], text: "x" }))).toBe("invalid");
		await callTool(token.key, "mail_list_mailboxes");
		await admin.call("account.revoke_api_key", { key_id: token.keyId });

		const page = await activityOf(admin, service.id, 7);
		// The newest entry first.
		expect(page.entries.map((entry) => [entry.operation, entry.result, entry.surface])).toEqual([
			["account.revoke_api_key", "ok", "admin"],
			["mail.list_mailboxes", "ok", "mcp"],
			["mail.send", "error", "rest"],
			["chat.list_rooms", "denied", "rest"],
			["account.whoami", "ok", "rest"],
			["account.create_api_key", "ok", "admin"],
			["directory.create_service_account", "ok", "admin"],
		]);
		const [revoke, , invalid, refused, whoami] = page.entries;
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

	it("keeps at most the newest entries of the limit, and drops entries older than the days of the limit", async () => {
		const { admin, service } = await seedService();
		// The entry of the creation reaches the object first, so it cannot land between the rows below.
		await activityOf(admin, service.id, 1);
		const stub = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(service.id));
		const now = Date.now();
		await runInDurableObject(stub, (_instance, state) => {
			const sql = state.storage.sql;
			sql.exec("DELETE FROM service_activity");
			// One old entry, then entries up to the limit. The next insert is a multiple of 100, so it prunes.
			sql.exec(
				"INSERT INTO service_activity (seq, at, op, result, surface, actor_id) VALUES (1, ?, 'old', 'ok', 'rest', ?)",
				now - (SERVICE_ACTIVITY_LIMITS.days + 1) * 86_400_000,
				service.id,
			);
			for (let seq = 2; seq < SERVICE_ACTIVITY_LIMITS.entries + 100; seq++) {
				sql.exec(
					"INSERT INTO service_activity (seq, at, op, result, surface, actor_id) VALUES (?, ?, 'seed', 'ok', 'rest', ?)",
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
			rows: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM service_activity").one().n,
			old: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM service_activity WHERE op = 'old'").one().n,
		}));
		expect(count).toEqual({ rows: SERVICE_ACTIVITY_LIMITS.entries, old: 0 });
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
	it("lists its team mailboxes, shared drives and rooms with its role, and the scopes of its live tokens", async () => {
		const { owner, admin, service } = await seedService();
		const live = await serviceToken(admin, service.id, ["mail.read", "chat.read"]);
		const revoked = await serviceToken(admin, service.id, ["drive.write"]);
		const expired = await serviceToken(admin, service.id, ["mail.send"]);
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
		await sendMemberStates(owner.id, service.id);

		const access = await vi.waitFor(async () => {
			const result = await admin.call("directory.get_service_account_access", { principal_id: service.id });
			expect(result.shared_drives).toHaveLength(1);
			expect(result.chat_rooms).toHaveLength(1);
			return result;
		});
		expect(access).toEqual({
			principal_id: service.id,
			team_mailboxes: [{ id: team_mailbox.id, display_name: "Support", address: "support@dock.test" }],
			shared_drives: [{ id: drive.id, name: "Releases", role: "editor" }],
			chat_rooms: [{ id: room.id, kind: "private", name: "builds", role: "member" }],
			chat_rooms_truncated: false,
			tokens: [{ key_id: live.keyId, label: "deploy", scopes: ["mail.read", "chat.read"], expires_at: null }],
			scopes: ["chat.read", "mail.read"],
		});
		const viaMcp = await callTool(admin.key, "directory_get_service_account_access", { principal_id: service.id });
		expect(viaMcp.structuredContent).toEqual(access);
	});

	it("is for owners and admins only", async () => {
		const { admin, ada, bot, service } = await seedService();
		const token = await serviceToken(admin, service.id);
		const input = { principal_id: service.id };
		expect(await codeOf(ada.call("directory.get_service_account_access", input))).toBe("forbidden");
		expect(await codeOf(bot.call("directory.get_service_account_access", input))).toBe("forbidden");
		expect(await codeOf(token.call("directory.get_service_account_access", input))).toBe("forbidden");
		expect(await codeOf(admin.call("directory.get_service_account_access", { principal_id: ada.id }))).toBe(
			"not_found",
		);
	});
});

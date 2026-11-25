import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DRIVE_LIMITS, type InputOf, type OperationName, type OutputOf, type Scope } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	base64,
	callTool,
	codeOf,
	createActor,
	fromBase64,
	ORIGIN,
	PASSWORD,
	racing,
	request,
	seedOrg,
	withEnv,
} from "./helpers.ts";

// Ada sponsors the bot. The bot holds each agent scope, so it shares the items of its own drive.
let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const UNKNOWN_PRINCIPAL = "prn_01JD0000000000000000000000";
const UNKNOWN_REQUEST = "srq_01JD0000000000000000000000";
const DRIVE_AGENT: Scope[] = ["account.read", "drive.read", "drive.write", "drive.share"];

/** A new agent that Ada sponsors. Without `scopes`, it holds no drive scope. */
const newAgent = (name: string, scopes: Scope[] = ["account.read"]) =>
	createActor(owner, {
		kind: "agent",
		display_name: name,
		address: `${name.toLowerCase()}@dock.test`,
		sponsor_id: ada.id,
		scopes: scopes as never,
	});

const newPerson = (name: string, role: "member" | "admin" = "member") =>
	createActor(owner, {
		kind: "human",
		display_name: name,
		address: `${name.toLowerCase()}@dock.test`,
		password: PASSWORD,
		org_role: role,
	});

/** A new service account with a token. Without `sponsor`, the owner is its sponsor. */
async function newService(name: string, sponsor: Actor = owner, scopes: Scope[] = DRIVE_AGENT): Promise<Actor> {
	const { principal } = await owner.call("directory.create_service_account", {
		display_name: name,
		address: `${name.toLowerCase()}@dock.test`,
		sponsor_id: sponsor.id,
		scopes: scopes as never,
	});
	const { api_key } = await owner.call("account.create_api_key", { principal_id: principal.id, label: name });
	return { id: principal.id, address: principal.address, key: api_key.secret, call: api(api_key.secret) };
}

/** A key of a person that holds only the given scopes. */
const keyOf = async (by: Actor, scopes: Scope[]) =>
	api((await by.call("account.create_api_key", { label: "Narrow", scopes: scopes as never })).api_key.secret);

const upload = async (actor: Actor, name: string, text = "v1") =>
	(await actor.call("drive.upload_file", { name, content_base64: base64(text) })).item;

const ask = async (by: Actor, item_id: string, account: Actor, role: "viewer" | "editor" = "viewer") =>
	(await by.call("drive.request_share", { item_id, principal_id: account.id, role })).request;

const requestsOf = async (actor: Actor, principal_id?: string) =>
	(await actor.call("drive.list_share_requests", principal_id ? { principal_id } : {})).requests;

/** The share requests in the activity list of a person. */
const requestItems = async (actor: Actor) =>
	(await actor.call("chat.list_activity", { filter: "share_request" })).items;

/** The grants of an item, as its owner lists them. */
const grantsOf = async (itemOwner: Actor, item_id: string) =>
	(await itemOwner.call("drive.list_permissions", { item_id })).permissions.map((p) => [p.principal_id, p.role]);

const scopesOf = async (id: string) => (await owner.call("directory.get_agent_access", { principal_id: id })).scopes;

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/**
 * An OAuth access token of an agent that exists, as an MCP client gets it: the client registers, `approver`
 * connects the agent, and the client exchanges the code.
 */
async function oauthOf(agent: Actor, approver: Actor): Promise<Actor> {
	const redirect = "http://localhost:33418/callback";
	const registered = await request("/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: "Test client", redirect_uris: [redirect] }),
	});
	const { client_id } = (await registered.json()) as { client_id: string };
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	const params = new URLSearchParams({
		response_type: "code",
		client_id,
		redirect_uri: redirect,
		code_challenge: base64Url(digest),
		code_challenge_method: "S256",
		scope: "account.read drive.read drive.write drive.share openid",
		resource: `${ORIGIN}/mcp`,
	});
	const started = await request(`/oauth/authorize?${params}`, { redirect: "manual" });
	const request_id = (started.headers.get("location") ?? "").slice("/connect/".length);
	const { redirect_to } = await approver.call("oauth.approve_authorization", { request_id, agent_id: agent.id });
	const exchanged = await request("/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: new URL(redirect_to).searchParams.get("code") ?? "",
			code_verifier: verifier,
			client_id,
			redirect_uri: redirect,
		}).toString(),
	});
	const { access_token } = (await exchanged.json()) as { access_token: string };
	return { id: agent.id, address: agent.address, key: access_token, call: api(access_token) };
}

describe("drive.share_item with an agent", () => {
	// A grant lets an agent read what the item holds. So a person decides which agent gets one, and an agent
	// cannot give a grant to a different agent.
	it("refuses an agent or a service account that shares with a different agent or service account, and writes no grant", async () => {
		const helper = await newAgent("Helper");
		const service = await newService("CI");
		// The bot through an OAuth access token, as an MCP client connects it.
		const viaOauth = await oauthOf(bot, ada);
		expect(await viaOauth.call("account.whoami")).toMatchObject({ principal: { id: bot.id }, credential: "oauth" });
		for (const [caller, other] of [
			[bot, helper],
			[bot, service],
			[service, bot],
			[viaOauth, helper],
		] as const) {
			const item = await upload(caller, "plan.txt");
			for (const role of ["viewer", "editor"] as const) {
				const refused = caller.call("drive.share_item", { item_id: item.id, principal_id: other.id, role });
				expect(await codeOf(refused)).toBe("forbidden");
			}
			expect(await grantsOf(caller, item.id)).toEqual([]);
			// The same caller shares the item with a person.
			const shared = await caller.call("drive.share_item", { item_id: item.id, principal_id: ada.id, role: "viewer" });
			expect(shared).toMatchObject({ agent_access_changes: [], agent_access_pending: [] });
			expect(await grantsOf(caller, item.id)).toEqual([[ada.id, "viewer"]]);
		}
	});

	// A person who manages the agent and shares an item with it decided that the agent can use the item. The
	// agent must not need a second change of its scopes. A credential gives only what it holds.
	it("gives the agent the drive scopes of its role only when the person manages it and the credential can give them", async () => {
		const helper = await newAgent("Helper");
		const share = (call: ReturnType<typeof api>, item_id: string, account: Actor, role: "viewer" | "editor") =>
			call("drive.share_item", { item_id, principal_id: account.id, role });

		// Cy does not manage the agent. The grant gives it no scope.
		const cy = await newPerson("Cy");
		const ofCy = await upload(cy, "notes.txt");
		expect(await share(cy.call, ofCy.id, helper, "editor")).toMatchObject({
			permission: { principal_id: helper.id, role: "editor", item_id: ofCy.id },
			agent_access_changes: [],
			agent_access_pending: [],
		});
		expect(await scopesOf(helper.id)).toEqual(["account.read"]);

		// A key of the sponsor without directory.write gives no scope.
		const item = await upload(ada, "plan.txt");
		const driveOnly = await keyOf(ada, ["drive.read", "drive.write", "drive.share"]);
		expect((await share(driveOnly, item.id, helper, "viewer")).agent_access_changes).toEqual([]);
		expect(await scopesOf(helper.id)).toEqual(["account.read"]);

		// A key with directory.write cannot give drive.write that it does not hold. The role stays.
		const noWrite = await keyOf(ada, ["directory.write", "drive.read", "drive.share"]);
		expect(await codeOf(share(noWrite, item.id, helper, "editor"))).toBe("forbidden");
		expect(await grantsOf(ada, item.id)).toEqual([[helper.id, "viewer"]]);
		expect(await scopesOf(helper.id)).toEqual(["account.read"]);
		// The same key gives drive.read, the only scope of a viewer.
		expect((await share(noWrite, item.id, helper, "viewer")).agent_access_changes).toEqual([
			{ principal_id: helper.id, scopes_added: ["drive.read"] },
		]);
		// The full credential of the sponsor gives drive.write with the editor role, and the agent writes at once.
		expect((await share(ada.call, item.id, helper, "editor")).agent_access_changes).toEqual([
			{ principal_id: helper.id, scopes_added: ["drive.write"] },
		]);
		await helper.call("drive.upload_version", { space_id: ada.id, item_id: item.id, content_base64: base64("v2") });
		expect(fromBase64((await ada.call("drive.download_file", { item_id: item.id })).content_base64)).toBe("v2");

		// Only an owner or an admin manages a service account. Its sponsor gives it no scope.
		const service = await newService("CI", ada, ["account.read"]);
		expect((await share(ada.call, item.id, service, "viewer")).agent_access_changes).toEqual([]);
		const ofOwner = await upload(owner, "budget.txt");
		expect((await share(owner.call, ofOwner.id, service, "viewer")).agent_access_changes).toEqual([
			{ principal_id: service.id, scopes_added: ["drive.read"] },
		]);
	});
});

describe("a request of an agent to share an item with an agent", () => {
	type Send = <N extends OperationName>(actor: Actor, name: N, input: InputOf<N>) => Promise<OutputOf<N>>;
	const rest: Send = (actor, name, input) => actor.call(name, input);
	const tool: Send = async (actor, name, input) => {
		const result = await callTool(actor.key, name.replace(".", "_"), input as Record<string, unknown>);
		expect(result.isError, result.content[0]?.text).toBeUndefined();
		return result.structuredContent as never;
	};

	// Parity: an agent asks and a person decides through REST and through MCP, with the same result.
	it.each([
		["REST", rest],
		["MCP tools", tool],
	] as const)(
		"gives the account its grant after the person who manages it approves the request, through %s",
		async (_name, send) => {
			const helper = await newAgent("Helper");
			const { item } = await send(bot, "drive.upload_file", { name: "plan.txt", content_base64: base64("v1") });
			const input = { item_id: item.id, principal_id: helper.id, role: "viewer" as const };
			const asked = await send(bot, "drive.request_share", input);
			expect(asked).toEqual({
				request: {
					id: expect.stringMatching(/^srq_[0-9A-Z]{26}$/),
					space_id: bot.id,
					item_id: item.id,
					item_name: "plan.txt",
					principal_id: helper.id,
					requested_by: bot.id,
					role: "viewer",
					created_at: expect.any(String),
				},
				created: true,
			});
			const { request } = asked;
			// A second call makes no second request and no second activity item.
			expect(await send(bot, "drive.request_share", input)).toEqual({ request, created: false });
			expect(await send(bot, "drive.list_share_requests", {})).toEqual({ requests: [request] });

			// Ada sponsors the account, and she gets the request.
			expect(await send(ada, "drive.list_share_requests", {})).toEqual({ requests: [request] });
			const feed = await send(ada, "chat.list_activity", {});
			expect(feed).toMatchObject({ unread_count: 1, next_cursor: null });
			expect(feed.items).toHaveLength(1);
			expect(feed.items[0]).toMatchObject({
				kind: "share_request",
				message_id: request.id,
				room_id: "",
				room_name: null,
				actor: { principal_id: bot.id, kind: "agent", display_name: "Billing Bot" },
				subject: { principal_id: helper.id, kind: "agent", display_name: "Helper" },
				item: { space_id: bot.id, item_id: item.id, name: "plan.txt", role: "viewer" },
				preview: "Asks to share plan.txt with Helper",
				// The agent that asked chose the name of the item, and an agent chose each name.
				untrusted: true,
				read_at: null,
			});
			expect(await send(ada, "chat.list_activity", { filter: "share_request" })).toEqual(feed);
			expect((await send(ada, "chat.list_activity", { filter: "member_request" })).items).toEqual([]);
			// The account has no grant before the approval.
			expect(await grantsOf(bot, item.id)).toEqual([]);

			// The approval writes the grant as the agent that asked, and gives the account drive.read.
			const approved = await send(ada, "drive.approve_share_request", { request_id: request.id });
			expect(approved).toEqual({
				request,
				permission: {
					principal_id: helper.id,
					role: "viewer",
					item_id: item.id,
					inherited: false,
					granted_by: { principal_id: bot.id, kind: "agent", display_name: "Billing Bot" },
					created_at: expect.any(String),
				},
				agent_access_changes: [{ principal_id: helper.id, scopes_added: ["drive.read"] }],
				agent_access_pending: [],
			});
			expect(await grantsOf(bot, item.id)).toEqual([[helper.id, "viewer"]]);
			const space = { space_id: bot.id, item_id: item.id };
			expect((await helper.call("drive.get_item", space)).item).toMatchObject({ name: "plan.txt", role: "viewer" });
			expect(fromBase64((await helper.call("drive.download_file", space)).content_base64)).toBe("v1");
			// The request is gone for the two, and the activity item with it.
			for (const actor of [ada, bot])
				expect(await send(actor, "drive.list_share_requests", {})).toEqual({ requests: [] });
			expect(await send(ada, "chat.list_activity", {})).toMatchObject({ items: [], unread_count: 0 });
			expect(await codeOf(ada.call("drive.approve_share_request", { request_id: request.id }))).toBe("not_found");
		},
	);

	// The person who manages an account decides which items it reads. Each other caller learns nothing about a
	// request: it gets the answer for an id that no request has.
	it("lets only a person who manages the account see and decide its request", async () => {
		const helper = await newAgent("Helper", DRIVE_AGENT);
		const second = await newAgent("Second");
		// Ada sponsors this service account. Only an owner or an admin manages a service account.
		const service = await newService("CI", ada);
		const cy = await newPerson("Cy");
		const admin = await newPerson("Di", "admin");
		const item = await upload(bot, "plan.txt");
		// Only the clock is fake: each request gets a different time, for the order of the lists.
		vi.useFakeTimers({ toFake: ["Date"] });
		const askLater = (account: Actor) => {
			vi.setSystemTime(Date.now() + 1000);
			return ask(bot, item.id, account);
		};
		const forHelper = await askLater(helper);
		const forSecond = await askLater(second);
		const forService = await askLater(service);

		// A person gets the requests for the accounts that the person manages, the newest first.
		expect(await requestsOf(ada)).toEqual([forSecond, forHelper]);
		expect(await requestsOf(ada, helper.id)).toEqual([forHelper]);
		for (const manager of [owner, admin]) expect(await requestsOf(manager)).toEqual([forService, forSecond, forHelper]);
		expect(await requestsOf(cy)).toEqual([]);
		// An agent gets the requests that it made.
		expect(await requestsOf(bot)).toEqual([forService, forSecond, forHelper]);
		expect(await requestsOf(bot, second.id)).toEqual([forSecond]);
		expect(await requestsOf(helper)).toEqual([]);
		// The sponsor of the service account cannot decide it, so the owner of the organization gets its item.
		expect((await requestItems(ada)).map((entry) => entry.message_id)).toEqual([forSecond.id, forHelper.id]);
		expect(await requestItems(owner)).toMatchObject([
			{ message_id: forService.id, subject: { principal_id: service.id, kind: "agent", display_name: "CI" } },
		]);
		expect(await requestItems(cy)).toEqual([]);

		for (const operation of ["drive.approve_share_request", "drive.deny_share_request"] as const) {
			// A person who does not manage the account, and the sponsor of a service account.
			expect(await codeOf(cy.call(operation, { request_id: forHelper.id }))).toBe("not_found");
			expect(await codeOf(ada.call(operation, { request_id: forService.id }))).toBe("not_found");
			expect(await codeOf(ada.call(operation, { request_id: UNKNOWN_REQUEST }))).toBe("not_found");
			// No agent decides: not the agent that asked, and not the account of the request.
			for (const agent of [bot, helper, service]) {
				expect(await codeOf(agent.call(operation, { request_id: forHelper.id }))).toBe("forbidden");
			}
		}
		expect(await requestsOf(owner)).toHaveLength(3);
		expect(await grantsOf(bot, item.id)).toEqual([]);

		// The sponsor, an admin and the owner each decide a request.
		await ada.call("drive.approve_share_request", { request_id: forHelper.id });
		await admin.call("drive.approve_share_request", { request_id: forSecond.id });
		await owner.call("drive.approve_share_request", { request_id: forService.id });
		expect(new Set(await grantsOf(bot, item.id))).toEqual(
			new Set([
				[helper.id, "viewer"],
				[second.id, "viewer"],
				[service.id, "viewer"],
			]),
		);
		expect(await requestsOf(owner)).toEqual([]);
		expect(await requestItems(owner)).toEqual([]);
	});

	// The approval gives the account the drive scopes of its role, as drive.share_item does for a person who
	// manages the agent. A credential gives only what it holds, and a refused approval keeps the request.
	it("gives the account the scopes of its role only when the credential of the approval can give them", async () => {
		const helper = await newAgent("Helper");
		const second = await newAgent("Second");
		const item = await upload(bot, "plan.txt");
		const forHelper = await ask(bot, item.id, helper, "editor");
		const forSecond = await ask(bot, item.id, second, "editor");

		// A key of the sponsor without directory.write approves. The account has the grant, and no new scope.
		const driveOnly = await keyOf(ada, ["drive.read", "drive.write", "drive.share"]);
		expect(await driveOnly("drive.approve_share_request", { request_id: forHelper.id })).toMatchObject({
			request: forHelper,
			agent_access_changes: [],
			agent_access_pending: [],
		});
		expect(await grantsOf(bot, item.id)).toEqual([[helper.id, "editor"]]);
		expect(await scopesOf(helper.id)).toEqual(["account.read"]);

		// A key with directory.write that cannot give drive.write writes no grant, and the request stays.
		const noWrite = await keyOf(ada, ["directory.write", "drive.read", "drive.share"]);
		expect(await codeOf(noWrite("drive.approve_share_request", { request_id: forSecond.id }))).toBe("forbidden");
		expect(await grantsOf(bot, item.id)).toEqual([[helper.id, "editor"]]);
		expect(await scopesOf(second.id)).toEqual(["account.read"]);
		expect(await requestsOf(ada)).toEqual([forSecond]);
		// A credential that holds each scope completes the request.
		const approved = await ada.call("drive.approve_share_request", { request_id: forSecond.id });
		expect(approved.agent_access_changes).toEqual([
			{ principal_id: second.id, scopes_added: ["drive.read", "drive.write"] },
		]);
	});

	it("refuses a request from a caller that cannot share the item, and a request for an account that cannot get it", async () => {
		const helper = await newAgent("Helper");
		const archived = await newAgent("Old");
		await owner.call("directory.archive_principal", { principal_id: archived.id });
		const item = await upload(bot, "plan.txt");
		const request = (by: Actor, input: Partial<InputOf<"drive.request_share">>) =>
			codeOf(by.call("drive.request_share", { item_id: item.id, principal_id: helper.id, role: "viewer", ...input }));

		// The account of the request: a person, an archived agent, the caller, and an id that no principal has.
		expect(await request(bot, { principal_id: ada.id })).toBe("invalid");
		expect(await request(bot, { principal_id: archived.id })).toBe("invalid");
		expect(await request(bot, { principal_id: bot.id })).toBe("invalid");
		expect(await request(bot, { principal_id: UNKNOWN_PRINCIPAL })).toBe("not_found");

		// A person shares with drive.share_item, and does not ask.
		const ofAda = await upload(ada, "notes.txt");
		expect(await request(ada, { item_id: ofAda.id })).toBe("forbidden");
		// The item answers first. A caller that cannot share it gets the same answer for each principal id.
		for (const principal_id of [helper.id, UNKNOWN_PRINCIPAL, ada.id]) {
			// The bot has no grant for the item of Ada.
			expect(await request(bot, { space_id: ada.id, item_id: ofAda.id, principal_id })).toBe("not_found");
		}
		await ada.call("drive.share_item", { item_id: ofAda.id, principal_id: bot.id, role: "editor" });
		for (const principal_id of [helper.id, UNKNOWN_PRINCIPAL, ada.id]) {
			// An editor cannot share the item.
			expect(await request(bot, { space_id: ada.id, item_id: ofAda.id, principal_id })).toBe("forbidden");
		}
		// An item in the trash.
		await bot.call("drive.trash_items", { item_ids: [item.id] });
		expect(await request(bot, {})).toBe("invalid");
		// An editor of a shared drive cannot share its items. It cannot ask, and it cannot share with a person.
		const { shared_drive } = await owner.call("drive.create_shared_drive", {
			name: "Design",
			members: [
				{ principal_id: ada.id, role: "manager" },
				{ principal_id: bot.id, role: "editor" },
			],
		});
		const inDrive = (
			await ada.call("drive.upload_file", {
				space_id: shared_drive.id,
				name: "brief.txt",
				content_base64: base64("v1"),
			})
		).item;
		const ofDrive = { space_id: shared_drive.id, item_id: inDrive.id };
		expect(await request(bot, ofDrive)).toBe("forbidden");
		for (const principal_id of [helper.id, owner.id]) {
			const shared = bot.call("drive.share_item", { ...ofDrive, principal_id, role: "viewer" });
			expect(await codeOf(shared)).toBe("forbidden");
		}
		expect((await ada.call("drive.list_permissions", ofDrive)).permissions).toEqual([]);

		// No refused call made a request or an activity item.
		expect(await requestsOf(owner)).toEqual([]);
		expect(await requestsOf(bot)).toEqual([]);
		expect(await requestItems(ada)).toEqual([]);
	});

	// Each request is an item in the activity list of a person. An agent must not fill that list.
	it("keeps no more requests that wait for an answer for one item than the limit", async () => {
		const most = DRIVE_LIMITS.shareRequestsPerItem;
		const item = await upload(bot, "plan.txt");
		const agents: Actor[] = [];
		for (let n = 1; n <= most + 1; n++) agents.push(await newAgent(`Agent${n}`));
		const [first, ...rest] = agents.slice(0, most) as [Actor, ...Actor[]];
		const extra = agents[most] as Actor;
		const kept = await ask(bot, item.id, first);
		for (const agent of rest) await ask(bot, item.id, agent);

		const input = { item_id: item.id, principal_id: extra.id, role: "viewer" as const };
		expect(await codeOf(bot.call("drive.request_share", input))).toBe("conflict");
		expect(await requestsOf(bot)).toHaveLength(most);
		// A second call for a request of the item returns that request, also at the limit.
		expect(await bot.call("drive.request_share", { ...input, principal_id: first.id })).toEqual({
			request: kept,
			created: false,
		});
		// The limit is for one item, and a decision makes space for the next request.
		const other = await upload(bot, "other.txt");
		expect((await bot.call("drive.request_share", { ...input, item_id: other.id })).created).toBe(true);
		await ada.call("drive.deny_share_request", { request_id: kept.id });
		expect((await bot.call("drive.request_share", input)).created).toBe(true);

		// Nobody can decide a request for an archived account, so it does not use a place of the item.
		const last = await newAgent("Last");
		const forLast = { ...input, principal_id: last.id };
		expect(await codeOf(bot.call("drive.request_share", forLast))).toBe("conflict");
		await owner.call("directory.archive_principal", { principal_id: (rest[0] as Actor).id });
		expect((await bot.call("drive.request_share", forLast)).created).toBe(true);

		// One agent also has a limit across all items. Rows in D1 fill the places of the bot up to that limit.
		// One row is for an account that is archived later, on a different item.
		const perAgent = DRIVE_LIMITS.shareRequestsPerAgent;
		const held = await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM drive_share_requests WHERE requested_by = ?")
			.bind(bot.id)
			.first<{ n: number }>();
		const retired = await newAgent("Retired");
		const seed = (n: number, principalId: string) =>
			env.DIRECTORY.prepare(
				`INSERT INTO drive_share_requests (id, space_id, item_id, item_name, principal_id, requested_by, role, notified_id, created_at)
				VALUES (?, ?, ?, 'seed.txt', ?, ?, 'viewer', NULL, ?)`,
			).bind(
				`srq_01JD${String(n).padStart(22, "0")}`,
				bot.id,
				`itm_01JD${String(n).padStart(22, "0")}`,
				principalId,
				bot.id,
				new Date().toISOString(),
			);
		const free = perAgent - Number(held?.n);
		await env.DIRECTORY.batch([
			seed(0, retired.id),
			...Array.from({ length: free - 1 }, (_, n) => seed(n + 1, first.id)),
		]);
		const third = await upload(bot, "third.txt");
		const forThird = { item_id: third.id, principal_id: first.id, role: "viewer" as const };
		expect(await codeOf(bot.call("drive.request_share", forThird))).toBe("conflict");
		// A second call for a request of the bot returns that request, also at the limit of the agent.
		expect((await bot.call("drive.request_share", forLast)).created).toBe(false);
		// The request for the archived account uses no place of the agent, also on a different item.
		await owner.call("directory.archive_principal", { principal_id: retired.id });
		expect((await bot.call("drive.request_share", forThird)).created).toBe(true);
	});

	// A request that nobody can decide must not stay in a list. A request also goes to the person who can
	// decide it now.
	it("drops a request whose account is archived, and follows a new sponsor", async () => {
		const cy = await newPerson("Cy");
		const item = await upload(bot, "plan.txt");
		const gone = await newAgent("Gone");
		await ask(bot, item.id, gone);
		expect(await requestItems(ada)).toHaveLength(1);
		await owner.call("directory.archive_principal", { principal_id: gone.id });
		expect(await requestItems(ada)).toEqual([]);
		for (const actor of [ada, owner, bot]) expect(await requestsOf(actor)).toEqual([]);

		// The sponsor changes. Ada no longer decides, so her item goes away, and a new call sends it to Cy.
		const moved = await newAgent("Moved");
		const request = await ask(bot, item.id, moved);
		await owner.call("directory.update_principal", { principal_id: moved.id, sponsor_id: cy.id });
		expect(await requestItems(ada)).toEqual([]);
		expect(await codeOf(ada.call("drive.deny_share_request", { request_id: request.id }))).toBe("not_found");
		expect(
			(await bot.call("drive.request_share", { item_id: item.id, principal_id: moved.id, role: "viewer" })).created,
		).toBe(false);
		expect(await requestItems(cy)).toMatchObject([
			{ message_id: request.id, subject: { principal_id: moved.id }, item: { item_id: item.id } },
		]);
		await cy.call("drive.approve_share_request", { request_id: request.id });
		expect(await grantsOf(bot, item.id)).toEqual([[moved.id, "viewer"]]);
		expect(await requestItems(cy)).toEqual([]);
	});

	// An approval gives no more than the agent that asked can give at the time of the approval.
	it("writes no grant after a denial, and after an approval when the agent that asked cannot share the item then", async () => {
		const helper = await newAgent("Helper");
		const decide = (operation: "drive.approve_share_request" | "drive.deny_share_request", request_id: string) =>
			ada.call(operation, { request_id });

		const stops: [string, (item_id: string) => Promise<unknown>][] = [
			["the item is in the trash", (item_id) => bot.call("drive.trash_items", { item_ids: [item_id] })],
			[
				"the item is deleted",
				async (item_id) => {
					await bot.call("drive.trash_items", { item_ids: [item_id] });
					await bot.call("drive.delete_items", { item_ids: [item_id] });
				},
			],
			[
				"the agent that asked loses drive.share",
				async () => {
					const scopes = (await scopesOf(bot.id)).filter((scope): scope is Scope => scope !== "drive.share");
					await owner.call("directory.set_agent_access", { principal_id: bot.id, scopes });
				},
			],
			// The last stop: the bot makes no request after it.
			["the agent that asked is archived", () => owner.call("directory.archive_principal", { principal_id: bot.id })],
		];
		const logged = vi.spyOn(console, "log");
		const denied = await upload(bot, "notes.txt");
		const items = [];
		for (const [reason] of stops) items.push({ reason, item: await upload(bot, `${reason}.txt`) });
		const requests = [];
		for (const { item } of items) requests.push(await ask(bot, item.id, helper));

		const request = await ask(bot, denied.id, helper);
		expect(await requestItems(ada)).toHaveLength(stops.length + 1);
		expect(await decide("drive.deny_share_request", request.id)).toEqual({ denied: true });
		expect(await grantsOf(bot, denied.id)).toEqual([]);
		expect(await codeOf(decide("drive.deny_share_request", request.id))).toBe("not_found");
		expect(await codeOf(decide("drive.approve_share_request", request.id))).toBe("not_found");
		expect(await grantsOf(bot, denied.id)).toEqual([]);

		for (const [index, [reason, stop]] of stops.entries()) {
			const asked = requests[index] as (typeof requests)[number];
			await stop(asked.item_id);
			expect(await codeOf(decide("drive.approve_share_request", asked.id)), reason).toBe("conflict");
			// The request cannot complete, so the call removed it.
			expect(await codeOf(decide("drive.approve_share_request", asked.id)), reason).toBe("not_found");
		}
		// The account got no grant and no scope, and each request is gone from the lists.
		expect(await scopesOf(helper.id)).toEqual(["account.read"]);
		expect(await requestsOf(ada)).toEqual([]);
		expect(await requestItems(ada)).toEqual([]);
		// Each refused approval removed a request, so the audit log has a line for it with the person who decided.
		const approvals = logged.mock.calls
			.map(([line]) => {
				try {
					return JSON.parse(String(line)) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter((line) => line?.audit === true && line.op === "drive.approve_share_request");
		expect(approvals).toEqual(
			requests.map((asked) =>
				expect.objectContaining({
					actor: ada.id,
					target: `${asked.item_id}:${helper.id}:viewer`,
					result: "error",
					code: "conflict",
				}),
			),
		);
	});

	// The delete of the request is the decision. A denial that comes while an approval runs must win or lose
	// as a whole: a denied account must never get the grant.
	it("writes no grant when a denial deletes the request before the approval does", async () => {
		const helper = await newAgent("Helper");
		const item = await upload(bot, "plan.txt");
		const request = await ask(bot, item.id, helper);
		// A denial deletes the request just before the approval of Ada deletes it.
		const directory = racing(
			"DELETE FROM drive_share_requests WHERE id = ?",
			request.id,
			"DELETE FROM drive_share_requests WHERE id",
		);
		const approved = await withEnv({ DIRECTORY: directory }, `/api/v1/drive/share-requests/${request.id}/approve`, {
			method: "POST",
			headers: { authorization: `Bearer ${ada.key}`, "content-type": "application/json" },
			body: "{}",
		});
		expect(approved.status).toBe(404);
		expect(await grantsOf(bot, item.id)).toEqual([]);
		expect(await scopesOf(helper.id)).toEqual(["account.read"]);
	});

	// A drive that does not answer did not decide. The person must be able to approve again, and must still see
	// the request in the activity list.
	// The drive can write the grant and then fail. A request that came back could then get a denial that does not
	// remove the grant, so the request stays gone, and the log keeps the person who removed it.
	it("removes the request and logs the person when the drive fails during the approval", async () => {
		const helper = await newAgent("Helper");
		const item = await upload(bot, "plan.txt");
		const request = await ask(bot, item.id, helper);
		type Calls = Record<string, (...args: unknown[]) => Promise<unknown>>;
		const failing = {
			idFromName: (name: string) => env.DRIVE_SPACE.idFromName(name),
			get: (id: DurableObjectId) =>
				new Proxy(env.DRIVE_SPACE.get(id) as unknown as Calls, {
					get(stub, property) {
						const name = String(property);
						if (name === "then") return undefined;
						if (name === "share") return () => Promise.reject(new Error("The drive is not available."));
						return (...args: unknown[]) => (stub[name] as Calls[string])(...args);
					},
				}),
		} as unknown as Env["DRIVE_SPACE"];
		const logged = vi.spyOn(console, "log");
		const approved = await withEnv({ DRIVE_SPACE: failing }, `/api/v1/drive/share-requests/${request.id}/approve`, {
			method: "POST",
			headers: { authorization: `Bearer ${ada.key}`, "content-type": "application/json" },
			body: "{}",
		});
		expect(approved.status).toBeGreaterThanOrEqual(500);
		expect(await grantsOf(bot, item.id)).toEqual([]);
		expect(await scopesOf(helper.id)).toEqual(["account.read"]);
		// The request is gone for the person and for the agent, and the audit log has the person who removed it.
		expect(await requestsOf(ada)).toEqual([]);
		expect(await requestsOf(bot)).toEqual([]);
		expect(await requestItems(ada)).toEqual([]);
		const lines = logged.mock.calls
			.map(([line]) => {
				try {
					return JSON.parse(String(line)) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter((line) => line?.audit === true && line.op === "drive.approve_share_request");
		expect(lines).toEqual([
			expect.objectContaining({
				actor: ada.id,
				target: `${item.id}:${helper.id}:viewer`,
				result: "error",
				code: "internal",
			}),
		]);
		// The agent asks again, and a person approves the new request.
		const again = await ask(bot, item.id, helper);
		expect(again.id).not.toBe(request.id);
		const done = await ada.call("drive.approve_share_request", { request_id: again.id });
		expect(done.permission).toMatchObject({ principal_id: helper.id, role: "viewer" });
	});

	// The object of each principal adds a column to its activity table for the new kind. A person must not lose
	// the items from before.
	it("keeps the activity items from before the share request kind, and then takes a request", async () => {
		const helper = await newAgent("Helper");
		const room = (await bot.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [ada.id] })).room;
		const mention = (await bot.call("chat.post_message", { room_id: room.id, text: "The plan is ready, @ada." }))
			.message;
		await vi.waitFor(async () => expect((await ada.call("chat.list_activity")).items).toHaveLength(1), {
			timeout: 5000,
			interval: 50,
		});
		const before = await ada.call("chat.list_activity");
		expect(before.items[0]).toMatchObject({ kind: "mention", message_id: mention.id, item: null });

		// Back to schema 11: the table has no `item_json`.
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
		await runInDurableObject(principal, (_instance, state) => {
			state.storage.sql.exec("ALTER TABLE chat_activity DROP COLUMN item_json");
			state.storage.sql.exec("UPDATE meta SET value = '11' WHERE key = 'schema_version'");
		});
		await evictDurableObject(principal);
		expect(await ada.call("chat.list_activity")).toEqual(before);
		const item = await upload(bot, "plan.txt");
		const request = await ask(bot, item.id, helper);
		const items = (await ada.call("chat.list_activity")).items.map((entry) => `${entry.kind} ${entry.message_id}`);
		expect(items.sort()).toEqual([`mention ${mention.id}`, `share_request ${request.id}`]);
		expect(await requestItems(ada)).toMatchObject([{ item: { item_id: item.id, name: "plan.txt" } }]);
	});
});

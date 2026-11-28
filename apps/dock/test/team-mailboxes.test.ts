import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ApiError, TEAM_MAILBOX_LIMITS } from "@asterra/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import resourceAccessMigration from "../migrations/0033_resource_access.sql?raw";
import worker from "../src/index.ts";
import {
	type Actor,
	api,
	callTool,
	drainOutbox,
	fakeEmailService,
	inject,
	mcp,
	ORIGIN,
	ownKey,
	PASSWORD,
	rawMessage,
	request,
	SETUP_TOKEN,
	seedOrg,
	setLegacyScopes,
} from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

async function code(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ApiError);
	return (error as ApiError).code;
}

/** Creates the team mailbox support@dock.test with the given members. */
async function createSupport(members: Actor[] = [ada, bot]) {
	const { team_mailbox } = await owner.call("directory.create_team_mailbox", {
		display_name: "Support",
		address: "support@dock.test",
		member_ids: members.map((member) => member.id),
	});
	return team_mailbox;
}

/** Each scope of a membership: what a new member gets. */
const ALL: ("mail.read" | "mail.modify" | "mail.send")[] = ["mail.read", "mail.modify", "mail.send"];

/** A key of `actor` that holds only the given scopes. */
async function narrowKey(
	actor: Actor,
	scopes: ("mail.read" | "mail.modify" | "mail.send" | "directory.read" | "directory.write")[],
) {
	const { api_key } = await actor.call("account.create_api_key", { label: "Narrow", scopes });
	return api(api_key.secret);
}

async function subjects(actor: Actor, mailboxId?: string, query = "in:inbox"): Promise<string[]> {
	const { threads } = await actor.call("mail.list_threads", { query, ...(mailboxId ? { mailbox_id: mailboxId } : {}) });
	return threads.map((thread) => thread.subject);
}

describe("team mailboxes in the directory", () => {
	it("lets only owners and admins create one, and shows it to each person and agent", async () => {
		const support = await createSupport();
		expect(support).toMatchObject({
			id: expect.stringMatching(/^tmb_/),
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [ada.id, bot.id],
			// Each first member can read the mailbox, change it and send from it.
			members: [
				{ principal_id: ada.id, scopes: ALL },
				{ principal_id: bot.id, scopes: ALL },
			],
		});
		const input = { display_name: "Sales", address: "sales@dock.test" };
		expect(await code(ada.call("directory.create_team_mailbox", input))).toBe("forbidden");
		expect(await code(bot.call("directory.create_team_mailbox", input))).toBe("forbidden");
		// A key without directory.write cannot create one, also for the owner.
		const readOnly = await narrowKey(owner, ["directory.read"]);
		expect(await code(readOnly("directory.create_team_mailbox", input))).toBe("forbidden");
		for (const actor of [ada, bot]) {
			expect((await actor.call("directory.list_team_mailboxes")).team_mailboxes).toEqual([support]);
		}
	});

	// Inbound mail has one recipient mailbox for each address, so a principal and a team mailbox can never share one.
	it("keeps one set of addresses for principals and team mailboxes, on saved mail domains only", async () => {
		await createSupport([]);
		const mailbox = (address: string) => owner.call("directory.create_team_mailbox", { display_name: "Team", address });
		expect(await code(mailbox("support@dock.test"))).toBe("conflict");
		expect(await code(mailbox("Ada@dock.test"))).toBe("conflict");
		expect(await code(mailbox("team@elsewhere.example"))).toBe("invalid");
		expect(await code(mailbox("team+tag@dock.test"))).toBe("invalid");
		expect(
			await code(
				owner.call("directory.create_principal", {
					kind: "agent",
					display_name: "Support Bot",
					address: "support@dock.test",
				}),
			),
		).toBe("conflict");
		// A domain with a team mailbox address is in use.
		await owner.call("directory.create_team_mailbox", { display_name: "Second", address: "team@second.test" });
		expect(await code(owner.call("directory.remove_mail_domain", { domain: "second.test" }))).toBe("conflict");
		expect((await owner.call("directory.list_team_mailboxes")).team_mailboxes.map((m) => m.address)).toEqual([
			"team@second.test",
			"support@dock.test",
		]);
	});

	it("lets only owners and admins rename one, through REST and MCP", async () => {
		const support = await createSupport();
		const rename = { mailbox_id: support.id, display_name: "Customer support" };
		expect(await code(ada.call("directory.update_team_mailbox", rename))).toBe("forbidden");
		expect(await code(bot.call("directory.update_team_mailbox", rename))).toBe("forbidden");
		const readOnly = await narrowKey(owner, ["directory.read"]);
		expect(await code(readOnly("directory.update_team_mailbox", rename))).toBe("forbidden");
		expect((await owner.call("directory.list_team_mailboxes")).team_mailboxes).toEqual([support]);

		const renamed = await callTool(owner.key, "directory_update_team_mailbox", rename);
		expect(renamed.structuredContent).toEqual({ team_mailbox: { ...support, display_name: "Customer support" } });
		await owner.call("directory.update_principal", { principal_id: ada.id, org_role: "admin" });
		const again = await ada.call("directory.update_team_mailbox", { ...rename, display_name: "Help desk" });
		expect(again.team_mailbox).toEqual({ ...support, display_name: "Help desk" });
		// The members see the new name, and mail from the mailbox has it in From.
		expect((await bot.call("mail.list_mailboxes")).mailboxes[1]).toEqual({
			id: support.id,
			kind: "team",
			address: "support@dock.test",
			display_name: "Help desk",
			service: false,
			scopes: ALL,
		});
		const sent = await bot.call("mail.send", { mailbox_id: support.id, to: ["owner@dock.test"], text: "Hi" });
		const [copy] = (await bot.call("mail.get_thread", { mailbox_id: support.id, thread_id: sent.thread_id })).messages;
		expect(copy?.from).toEqual({ name: "Help desk", address: "support@dock.test" });

		const unknown = { ...rename, mailbox_id: "tmb_00000000000000000000000000" };
		expect(await code(owner.call("directory.update_team_mailbox", unknown))).toBe("not_found");
	});

	it("creates nothing when a member id is unknown", async () => {
		const input = {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [ada.id, "prn_00000000000000000000000000"],
		};
		expect(await code(owner.call("directory.create_team_mailbox", input))).toBe("not_found");
		expect((await owner.call("directory.list_team_mailboxes")).team_mailboxes).toEqual([]);
	});

	it("lets only owners and admins add and remove members, through REST and MCP", async () => {
		const support = await createSupport([ada]);
		const add = { mailbox_id: support.id, principal_id: bot.id };
		// A member cannot give access, and an agent cannot add itself.
		expect(await code(ada.call("directory.add_team_mailbox_member", add))).toBe("forbidden");
		expect(await code(bot.call("directory.add_team_mailbox_member", add))).toBe("forbidden");
		expect(await code(ada.call("directory.remove_team_mailbox_member", { ...add, principal_id: ada.id }))).toBe(
			"forbidden",
		);

		const added = await callTool(owner.key, "directory_add_team_mailbox_member", add);
		expect(added.structuredContent).toMatchObject({ team_mailbox: { member_ids: [ada.id, bot.id] } });
		// A second call for the same member changes nothing.
		expect((await owner.call("directory.add_team_mailbox_member", add)).team_mailbox.member_ids).toEqual([
			ada.id,
			bot.id,
		]);
		const removed = await owner.call("directory.remove_team_mailbox_member", { ...add, principal_id: ada.id });
		expect(removed.team_mailbox.member_ids).toEqual([bot.id]);
		expect(
			(await owner.call("directory.remove_team_mailbox_member", { ...add, principal_id: ada.id })).team_mailbox,
		).toEqual(removed.team_mailbox);

		const unknown = "00000000000000000000000000";
		expect(await code(owner.call("directory.add_team_mailbox_member", { ...add, mailbox_id: `tmb_${unknown}` }))).toBe(
			"not_found",
		);
		expect(
			await code(owner.call("directory.add_team_mailbox_member", { ...add, principal_id: `prn_${unknown}` })),
		).toBe("not_found");
	});

	it(`refuses member ${TEAM_MAILBOX_LIMITS.members + 1} of a team mailbox`, async () => {
		const support = await createSupport([bot]);
		const now = new Date().toISOString();
		// The bot and these principals fill the mailbox. Rows in D1 are faster than 99 calls.
		const ids = Array.from({ length: TEAM_MAILBOX_LIMITS.members - 1 }, (_, i) => `prn_${String(i).padStart(26, "0")}`);
		await env.DIRECTORY.batch(
			ids.flatMap((id) => [
				env.DIRECTORY.prepare(
					"INSERT INTO principals (id, kind, display_name, org_role, created_at) VALUES (?, 'human', 'Filler', 'member', ?)",
				).bind(id, now),
				env.DIRECTORY.prepare(
					"INSERT INTO team_mailbox_members (mailbox_id, principal_id, added_by, created_at) VALUES (?, ?, ?, ?)",
				).bind(support.id, id, owner.id, now),
			]),
		);
		const add = owner.call("directory.add_team_mailbox_member", { mailbox_id: support.id, principal_id: ada.id });
		expect(await code(add)).toBe("invalid");
		// A member that the mailbox already has is still accepted: the call changes nothing.
		const again = await owner.call("directory.add_team_mailbox_member", {
			mailbox_id: support.id,
			principal_id: bot.id,
		});
		expect(again.team_mailbox.member_ids).toHaveLength(TEAM_MAILBOX_LIMITS.members);
	});
});

describe("the scopes of a member of a team mailbox", () => {
	const send = (actor: Actor, mailboxId: string) =>
		actor.call("mail.send", { mailbox_id: mailboxId, to: ["owner@dock.test"], text: "Hi" });
	const setScopes = (mailboxId: string, member: Actor, scopes: ("mail.read" | "mail.modify" | "mail.send")[]) =>
		owner.call("directory.add_team_mailbox_member", { mailbox_id: mailboxId, principal_id: member.id, scopes });

	it("lets only owners and admins set them, for a person and an agent, through REST and MCP", async () => {
		const support = await createSupport([ada]);
		const add = { mailbox_id: support.id, principal_id: bot.id };
		// A new member with scopes gets only them.
		const added = await callTool(owner.key, "directory_add_team_mailbox_member", { ...add, scopes: ["mail.read"] });
		expect(added.structuredContent).toMatchObject({
			team_mailbox: {
				member_ids: [ada.id, bot.id],
				members: [
					{ principal_id: ada.id, scopes: ALL },
					{ principal_id: bot.id, scopes: ["mail.read"] },
				],
			},
		});
		// A second call without scopes keeps the scopes of the member: it does not give each scope again.
		expect((await owner.call("directory.add_team_mailbox_member", add)).team_mailbox.members[1]).toEqual({
			principal_id: bot.id,
			scopes: ["mail.read"],
		});
		// With scopes, the call replaces the scopes of a member. The rule is the same for a person.
		const changed = await setScopes(support.id, ada, ["mail.send", "mail.read"]);
		expect(changed.team_mailbox.members[0]).toEqual({ principal_id: ada.id, scopes: ["mail.read", "mail.send"] });
		// Each member sees what it can do in each mailbox.
		expect((await ada.call("mail.list_mailboxes")).mailboxes).toEqual([
			{
				id: ada.id,
				kind: "personal",
				address: "ada@dock.test",
				display_name: "Ada Lovelace",
				service: false,
				scopes: ALL,
			},
			{
				id: support.id,
				kind: "team",
				address: "support@dock.test",
				display_name: "Support",
				service: false,
				scopes: ["mail.read", "mail.send"],
			},
		]);

		// A member cannot change its own scopes, and an agent cannot change them.
		const widen = { mailbox_id: support.id, principal_id: ada.id, scopes: ALL };
		expect(await code(ada.call("directory.add_team_mailbox_member", widen))).toBe("forbidden");
		expect(await code(bot.call("directory.add_team_mailbox_member", widen))).toBe("forbidden");
		for (const scopes of [[], ["drive.read"], ["mail.read", "mail.read"]]) {
			expect(await code(owner.call("directory.add_team_mailbox_member", { ...add, scopes } as never))).toBe("invalid");
		}
		expect((await owner.call("directory.list_team_mailboxes")).team_mailboxes).toEqual([changed.team_mailbox]);
	});

	it("refuses each call that needs a scope that the membership does not have, for a person and an agent", async () => {
		const support = await createSupport([]);
		await inject(
			rawMessage({ from: "cy@customer.example", to: "support@dock.test", subject: "Order 42" }),
			"support@dock.test",
		);
		const read = (actor: Actor) => actor.call("mail.list_threads", { mailbox_id: support.id });
		// The keys of Ada and of the bot hold each mail scope, so only the membership decides here.
		for (const member of [ada, bot]) {
			await setScopes(support.id, member, ["mail.read"]);
			const [thread] = (await read(member)).threads;
			const change = () =>
				member.call("mail.modify_threads", {
					mailbox_id: support.id,
					thread_ids: [thread?.id as string],
					add_label_ids: ["STARRED"],
				});
			expect(thread?.subject).toBe("Order 42");
			const [message] = (
				await member.call("mail.get_thread", { mailbox_id: support.id, thread_id: thread?.id as string })
			).messages;
			expect(await code(change())).toBe("forbidden");
			expect(await code(member.call("mail.create_label", { mailbox_id: support.id, name: "Later" }))).toBe("forbidden");
			expect(await code(send(member, support.id))).toBe("forbidden");

			// The change applies at the next call. A member with mail.send only can send, and cannot read.
			await setScopes(support.id, member, ["mail.send"]);
			expect((await send(member, support.id)).message_id).toEqual(expect.any(String));
			expect(await code(read(member))).toBe("forbidden");
			expect(await code(member.call("mail.get_profile", { mailbox_id: support.id }))).toBe("forbidden");
			// A reply puts the subject and the references of its message into the new message. Without
			// mail.read, a reply would show mail that the member cannot read.
			expect(
				await code(
					member.call("mail.send", {
						mailbox_id: support.id,
						to: [member.address],
						text: "What is this?",
						reply_to_message_id: message?.id as string,
					}),
				),
			).toBe("forbidden");

			await setScopes(support.id, member, ["mail.read", "mail.modify"]);
			expect(await change()).toMatchObject({ dry_run: false });
			expect(await code(send(member, support.id))).toBe("forbidden");
			// The membership does not limit the own mailbox of the member.
			expect((await member.call("mail.send", { to: ["owner@dock.test"], text: "From me" })).message_id).toEqual(
				expect.any(String),
			);
		}

		// The credential has the same rule in each mailbox: a key with only mail.send sends, but its reply
		// would read a message that the key cannot read.
		const sender = await narrowKey(ada, ["mail.send"]);
		const own = await sender("mail.send", { to: ["owner@dock.test"], text: "First" });
		const reply = { to: ["owner@dock.test"], text: "Second", reply_to_message_id: own.message_id };
		expect(await code(sender("mail.send", reply))).toBe("forbidden");
		expect((await ada.call("mail.send", reply)).thread_id).toBe(own.thread_id);
	});

	// The Worker from before the scopes writes a member without them, and each member from before has none
	// stored. Each such member could read the mailbox, change it and send from it.
	it("keeps each scope for a member from before the scopes, and gives nothing for a stored value that is not valid", async () => {
		const support = await createSupport([]);
		await env.DIRECTORY.prepare(
			"INSERT INTO team_mailbox_members (mailbox_id, principal_id, added_by, created_at) VALUES (?, ?, ?, ?)",
		)
			.bind(support.id, ada.id, owner.id, new Date().toISOString())
			.run();
		const members = async () => (await owner.call("directory.list_team_mailboxes")).team_mailboxes[0]?.members;
		expect(await members()).toEqual([{ principal_id: ada.id, scopes: ALL }]);
		expect((await send(ada, support.id)).message_id).toEqual(expect.any(String));

		await env.DIRECTORY.prepare("UPDATE team_mailbox_members SET scopes = 'all' WHERE principal_id = ?")
			.bind(ada.id)
			.run();
		expect(await members()).toEqual([{ principal_id: ada.id, scopes: [] }]);
		expect(await code(ada.call("mail.list_threads", { mailbox_id: support.id }))).toBe("forbidden");
	});

	// Before 0033, a call of an agent in a team mailbox needed the scope on its account and in its membership.
	// The migration keeps for each membership of an agent what the agent could do, so no agent gets more.
	it("keeps for each agent membership only the scopes that its account also held, in migration 0033", async () => {
		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI",
			address: "ci@dock.test",
		});
		const odd = await owner.call("directory.create_principal", {
			kind: "agent",
			display_name: "Odd",
			address: "odd@dock.test",
		});
		const agentId = async (name: string) => {
			const input = { kind: "agent", display_name: name, address: `${name.toLowerCase()}@dock.test` } as const;
			return (await owner.call("directory.create_principal", input)).principal.id;
		};
		const keyed = await agentId("Keyed");
		const mapped = await agentId("Mapped");
		const support = await createSupport([ada, bot]);
		for (const id of [service.id, odd.principal.id, keyed, mapped]) {
			await owner.call("directory.add_team_mailbox_member", { mailbox_id: support.id, principal_id: id });
		}
		await setLegacyScopes(bot.id, ["account.read", "mail.read", "mail.send"]);
		await setLegacyScopes(service.id, ["chat.read"]);
		// A stored list that is not valid JSON gives nothing, on the account and in the membership.
		await env.DIRECTORY.prepare("UPDATE principals SET agent_scopes = '{bad' WHERE id = ?")
			.bind(odd.principal.id)
			.run();
		// A JSON object is not a list of scopes. Its values give nothing, on the account and in the membership.
		await env.DIRECTORY.prepare(`UPDATE principals SET agent_scopes = '{"a":"mail.read"}' WHERE id = ?`)
			.bind(keyed)
			.run();
		await env.DIRECTORY.prepare(`UPDATE team_mailbox_members SET scopes = '{"a":"mail.read"}' WHERE principal_id = ?`)
			.bind(mapped)
			.run();
		await env.DIRECTORY.prepare("UPDATE team_mailbox_members SET scopes = 'all' WHERE principal_id = ?")
			.bind(ada.id)
			.run();
		await env.DIRECTORY.prepare(resourceAccessMigration).run();
		const scopes = Object.fromEntries(
			(await owner.call("directory.list_team_mailboxes")).team_mailboxes[0]?.members.map((member) => [
				member.principal_id,
				member.scopes,
			]) ?? [],
		);
		// A person keeps the membership as it is: its credential still limits each call.
		expect(scopes).toEqual({
			[ada.id]: [],
			[bot.id]: ["mail.read", "mail.send"],
			[service.id]: [],
			[odd.principal.id]: [],
			[keyed]: [],
			[mapped]: [],
		});
		const stored = await env.DIRECTORY.prepare("SELECT scopes FROM team_mailbox_members WHERE principal_id = ?")
			.bind(ada.id)
			.first("scopes");
		expect(stored).toBe("all");
		expect(await code(bot.call("mail.create_label", { mailbox_id: support.id, name: "Done" }))).toBe("forbidden");
	});
});

describe("an agent or a service account in a team mailbox", () => {
	/**
	 * A new agent of Ada with its first key, or a new service account with a token. It is a member of no team
	 * mailbox. `legacy` gives it the narrow account scopes that an account from before migration 0033 can have.
	 */
	async function newAccount(kind: "agent" | "service", legacy?: readonly string[]) {
		const address = "helper@dock.test";
		let id: string;
		let key: string;
		if (kind === "agent") {
			const created = await owner.call("directory.create_principal", {
				kind: "agent",
				display_name: "Helper",
				address,
				sponsor_id: ada.id,
			});
			id = created.principal.id;
			key = created.api_key?.secret ?? "";
		} else {
			const created = await owner.call("directory.create_service_account", { display_name: "Helper", address });
			id = created.principal.id;
			key = (await owner.call("account.create_api_key", { principal_id: id, label: "CI" })).api_key.secret;
		}
		if (legacy) await setLegacyScopes(id, legacy);
		return { id, address, key, call: api(key) };
	}
	const access = (id: string) => owner.call("directory.get_agent_access", { principal_id: id });
	const team = async (display_name: string, address: string) =>
		(await owner.call("directory.create_team_mailbox", { display_name, address })).team_mailbox;
	/** The error code of a refused MCP tool call. */
	const toolCode = (result: Awaited<ReturnType<typeof callTool>>) =>
		result.isError ? (JSON.parse(result.content[0]?.text ?? "{}") as { code?: string }).code : "ok";

	// The resource permissions are the source of truth. An admin grants Read and send on Support and Read on
	// Billing. The key that the agent had before acts at once, as the memberships say, and the end of a
	// membership ends that access at once. No member setting and no credential changes. An agent from before
	// migration 0033 with narrow account scopes gets the same: its account scopes limit only its own mailbox.
	// A service account and its token get the same as an agent and its key.
	it.each([
		["a new agent", "agent", undefined],
		["an agent from before migration 0033", "agent", ["account.read", "chat.read"]],
		["a new service account", "service", undefined],
		["a service account from before migration 0033", "service", ["chat.read"]],
	] as const)(
		"lets %s use each team mailbox as its membership says, at once, with its key",
		async (_name, kind, legacy) => {
			const agent = await newAccount(kind, legacy);
			const before = await access(agent.id);
			const support = await team("Support", "support@dock.test");
			const billing = await team("Billing", "billing@dock.test");
			const send = (mailbox_id: string, subject: string) =>
				agent.call("mail.send", { mailbox_id, to: ["owner@dock.test"], subject, text: "Hi" });
			expect(await code(send(support.id, "Early"))).toBe("forbidden");
			expect(await code(agent.call("mail.list_threads", { mailbox_id: billing.id }))).toBe("forbidden");

			await owner.call("directory.add_team_mailbox_member", {
				mailbox_id: support.id,
				principal_id: agent.id,
				scopes: ["mail.read", "mail.send"],
			});
			await owner.call("directory.add_team_mailbox_member", {
				mailbox_id: billing.id,
				principal_id: agent.id,
				scopes: ["mail.read"],
			});
			// The grants changed nothing on the agent: not its account, and not its keys.
			const after = await access(agent.id);
			expect(after.scopes).toEqual(before.scopes);
			expect(after.tokens).toEqual(before.tokens);
			expect(after.team_mailboxes.map((mailbox) => [mailbox.id, mailbox.scopes])).toEqual([
				[billing.id, ["mail.read"]],
				[support.id, ["mail.read", "mail.send"]],
			]);

			// REST: the agent sends from Support with its key from before, and can only read Billing.
			expect((await send(support.id, "Order 42")).message_id).toEqual(expect.any(String));
			expect(await subjects(agent, support.id, "in:sent")).toEqual(["Order 42"]);
			expect(await subjects(agent, billing.id)).toEqual([]);
			expect(await code(send(billing.id, "Refund"))).toBe("forbidden");
			expect(await code(agent.call("mail.create_label", { mailbox_id: billing.id, name: "Paid" }))).toBe("forbidden");
			// Read and send does not let the agent change Support.
			expect(await code(agent.call("mail.create_label", { mailbox_id: support.id, name: "Done" }))).toBe("forbidden");
			const listed = (await agent.call("mail.list_mailboxes")).mailboxes.filter((mailbox) => mailbox.kind === "team");
			expect(listed.map((mailbox) => [mailbox.id, mailbox.scopes])).toEqual([
				[billing.id, ["mail.read"]],
				[support.id, ["mail.read", "mail.send"]],
			]);

			// MCP: the same key sees the tools, and each call gets the same answer as REST.
			const { body } = await mcp(agent.key, "tools/list");
			const toolList = (body?.result ?? { tools: [] }) as { tools: { name: string }[] };
			const tools = toolList.tools.map((tool) => tool.name);
			expect(tools).toEqual(expect.arrayContaining(["mail_send", "mail_list_threads", "mail_create_label"]));
			const sendTool = (mailbox_id: string) =>
				callTool(agent.key, "mail_send", { mailbox_id, to: ["owner@dock.test"], subject: "MCP", text: "Hi" });
			expect(toolCode(await sendTool(support.id))).toBe("ok");
			expect(toolCode(await sendTool(billing.id))).toBe("forbidden");
			expect(toolCode(await callTool(agent.key, "mail_list_threads", { mailbox_id: billing.id }))).toBe("ok");

			// The end of the Support membership ends the Support access at once, on each surface. Billing stays.
			await owner.call("directory.remove_team_mailbox_member", { mailbox_id: support.id, principal_id: agent.id });
			expect(await code(send(support.id, "Late"))).toBe("forbidden");
			expect(await code(agent.call("mail.list_threads", { mailbox_id: support.id }))).toBe("forbidden");
			expect(toolCode(await sendTool(support.id))).toBe("forbidden");
			expect(toolCode(await callTool(agent.key, "mail_list_threads", { mailbox_id: support.id }))).toBe("forbidden");
			expect(await subjects(agent, billing.id)).toEqual([]);
			expect((await access(agent.id)).scopes).toEqual(before.scopes);

			// An agent from before keeps the limit of its account in its own mailbox.
			const own = agent.call("mail.send", { to: ["owner@dock.test"], subject: "Own", text: "Hi" });
			if (legacy) expect(await code(own)).toBe("forbidden");
			else expect((await own).message_id).toEqual(expect.any(String));
		},
	);
});

describe("mail in a team mailbox", () => {
	it("receives mail for the team address, and only members read it, through REST and MCP", async () => {
		const support = await createSupport();
		const first = await inject(
			rawMessage({ from: "Cy <cy@customer.example>", to: "support@dock.test", subject: "Order 42" }),
			"support@dock.test",
		);
		expect(first.rejected).toBeNull();
		await inject(
			rawMessage({ from: "cy@customer.example", to: "support+billing@dock.test", subject: "Invoice" }),
			"Support+billing@dock.test",
		);

		for (const member of [ada, bot]) {
			expect(await subjects(member, support.id)).toEqual(["Invoice", "Order 42"]);
			// The mail is in the team mailbox, not in the own mailbox of a member.
			expect(await subjects(member)).toEqual([]);
			expect((await member.call("mail.list_mailboxes")).mailboxes).toEqual([
				{
					id: member.id,
					kind: "personal",
					address: member.address,
					display_name: expect.any(String),
					service: false,
					scopes: ALL,
				},
				{
					id: support.id,
					kind: "team",
					address: "support@dock.test",
					display_name: "Support",
					service: false,
					scopes: ALL,
				},
			]);
		}
		expect(await ada.call("mail.get_profile", { mailbox_id: support.id })).toMatchObject({
			mailbox_id: support.id,
			kind: "team",
			address: "support@dock.test",
			display_name: "Support",
			inbox_unread: 2,
		});
		// Parity: the MCP tool returns the same threads as the REST route.
		const tool = await callTool(bot.key, "mail_list_threads", { mailbox_id: support.id });
		expect(tool.structuredContent).toEqual(await bot.call("mail.list_threads", { mailbox_id: support.id }));

		// The owner is an admin, but not a member: an admin gets access only as a member. The owner can
		// read the mailbox of the agent, but the list has no team mailbox.
		expect((await owner.call("mail.list_mailboxes")).mailboxes.map((m) => m.kind)).toEqual(["personal", "agent"]);
		expect(await code(owner.call("mail.list_threads", { mailbox_id: support.id }))).toBe("forbidden");
		expect(await code(owner.call("mail.send", { mailbox_id: support.id, to: ["ada@dock.test"], text: "Hi" }))).toBe(
			"forbidden",
		);
		expect(await code(ada.call("mail.list_threads", { mailbox_id: "tmb_00000000000000000000000000" }))).toBe(
			"not_found",
		);
		// The id of another principal is not a mailbox that a caller can use.
		expect(await code(ada.call("mail.list_threads", { mailbox_id: owner.id }))).toBe("forbidden");
		expect(await subjects(ada, ada.id)).toEqual([]);
	});

	it("shares the labels and the read state among the members", async () => {
		const support = await createSupport();
		await inject(
			rawMessage({ from: "cy@customer.example", to: "support@dock.test", subject: "Order 42" }),
			"support@dock.test",
		);
		const [thread] = (await ada.call("mail.list_threads", { mailbox_id: support.id })).threads;
		const label = await ada.call("mail.create_label", { mailbox_id: support.id, name: "Orders" });
		await ada.call("mail.modify_threads", {
			mailbox_id: support.id,
			thread_ids: [thread?.id as string],
			add_label_ids: [label.id],
			remove_label_ids: ["UNREAD"],
		});

		const seen = await bot.call("mail.get_thread", { mailbox_id: support.id, thread_id: thread?.id as string });
		expect(seen.label_ids.sort()).toEqual(["INBOX", label.id].sort());
		const labels = (await bot.call("mail.list_labels", { mailbox_id: support.id })).labels;
		expect(labels.find((item) => item.id === label.id)).toMatchObject({ name: "Orders", threads_total: 1 });
		// The label and the thread belong to the team mailbox only.
		expect((await ada.call("mail.list_labels")).labels.some((item) => item.id === label.id)).toBe(false);
		expect(await code(ada.call("mail.get_thread", { thread_id: thread?.id as string }))).toBe("not_found");
		await bot.call("mail.delete_label", { mailbox_id: support.id, label_id: label.id });
		expect(
			(await ada.call("mail.list_labels", { mailbox_id: support.id })).labels.some((item) => item.id === label.id),
		).toBe(false);
	});

	// The members share a snooze. A snooze changes the mailbox, so a member without mail.modify cannot snooze,
	// also over MCP.
	it("shares a snooze, and refuses a snooze without mail.modify", async () => {
		const support = await createSupport();
		await owner.call("directory.add_team_mailbox_member", {
			mailbox_id: support.id,
			principal_id: bot.id,
			scopes: ["mail.read", "mail.send"],
		});
		for (const subject of ["Refund", "Invoice"]) {
			await owner.call("mail.send", { to: ["support@dock.test"], subject, text: "Can you help?" });
		}
		await drainOutbox(owner.id);
		const { threads } = await ada.call("mail.list_threads", { mailbox_id: support.id });
		const idOf = (subject: string) => threads.find((thread) => thread.subject === subject)?.id as string;
		const until = new Date(Date.now() + 3_600_000).toISOString();
		await ada.call("mail.snooze_threads", { mailbox_id: support.id, thread_ids: [idOf("Refund")], until });
		expect(await subjects(bot, support.id, "in:snoozed")).toEqual(["Refund"]);

		const snooze = { mailbox_id: support.id, thread_ids: [idOf("Invoice")], until };
		expect(await code(bot.call("mail.snooze_threads", snooze))).toBe("forbidden");
		const refused = await callTool(bot.key, "mail_snooze_threads", snooze);
		expect(refused.isError).toBe(true);
		expect(await subjects(ada, support.id, "in:snoozed")).toEqual(["Refund"]);
	});

	it("sends from the team address, records which member sent it, and threads the reply in the team mailbox", async () => {
		const support = await createSupport();
		const email = await fakeEmailService(support.id);
		const sent = await ada.call("mail.send", {
			mailbox_id: support.id,
			to: ["owner@dock.test", "cy@customer.example"],
			// The own address of the sender is a normal recipient: the mail comes from the team mailbox.
			cc: ["ada@dock.test"],
			subject: "Your order",
			text: "It ships today.",
		});
		await drainOutbox(support.id);
		expect(email.sent).toEqual([{ from: "support@dock.test", to: "cy@customer.example" }]);

		// The sent copy is in the team mailbox, with the member that sent it. It is not in Ada's own Sent.
		const copy = (await bot.call("mail.get_thread", { mailbox_id: support.id, thread_id: sent.thread_id })).messages[0];
		expect(copy).toMatchObject({
			origin: "sent",
			from: { name: "Support", address: "support@dock.test" },
			sent_by: { principal_id: ada.id, kind: "human", display_name: "Ada Lovelace" },
		});
		expect(copy?.delivery?.map((d) => [d.address, d.status])).toEqual([
			["ada@dock.test", "delivered"],
			["cy@customer.example", "sent"],
			["owner@dock.test", "delivered"],
		]);
		expect(await subjects(ada, undefined, "in:sent")).toEqual([]);
		expect(await subjects(ada)).toEqual(["Your order"]);
		// from:me in a team mailbox is the team address.
		expect(await subjects(bot, support.id, "from:me")).toEqual(["Your order"]);

		const [received] = (await owner.call("mail.list_threads")).threads;
		const message = (await owner.call("mail.get_thread", { thread_id: received?.id as string })).messages[0];
		expect(message).toMatchObject({
			origin: "internal",
			from: { name: "Support", address: "support@dock.test" },
			sent_by: null,
		});
		await owner.call("mail.send", {
			to: ["support@dock.test"],
			text: "Thanks.",
			reply_to_message_id: message?.id as string,
		});
		await drainOutbox(owner.id);
		const thread = await bot.call("mail.get_thread", { mailbox_id: support.id, thread_id: sent.thread_id });
		expect(thread.messages.map((m) => [m.subject, m.origin])).toEqual([
			["Your order", "sent"],
			["Re: Your order", "internal"],
		]);
	});

	// A team mailbox must never widen what an agent can reach.
	it("applies the outbound policy of an agent to mail that it sends from a team mailbox", async () => {
		const support = await createSupport();
		const send = (to: string) => bot.call("mail.send", { mailbox_id: support.id, to: [to], text: "From the bot" });
		expect(await code(send("cy@customer.example"))).toBe("policy_denied");
		expect(await subjects(ada, support.id, "in:sent")).toEqual([]);
		const sent = await send("owner@dock.test");
		const [copy] = (await ada.call("mail.get_thread", { mailbox_id: support.id, thread_id: sent.thread_id })).messages;
		expect(copy?.sent_by).toEqual({ principal_id: bot.id, kind: "agent", display_name: "Billing Bot" });
	});

	it("does not send queued external mail from a team mailbox after the agent policy tightens", async () => {
		const support = await createSupport();
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		const email = await fakeEmailService(support.id);
		email.fail = new Error("temporary failure");
		const sent = await bot.call("mail.send", {
			mailbox_id: support.id,
			to: ["cy@customer.example"],
			text: "Queued",
		});
		await drainOutbox(support.id);
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "internal-only" });
		email.fail = null;
		const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(support.id));
		await runInDurableObject(mailbox, (_instance, state) => {
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = ?", Date.now());
		});
		await drainOutbox(support.id);
		expect(email.sent).toEqual([]);
		const thread = await ada.call("mail.get_thread", { mailbox_id: support.id, thread_id: sent.thread_id });
		expect(thread.messages[0]?.delivery).toEqual([
			{
				address: "cy@customer.example",
				kind: "external",
				status: "failed",
				error:
					"The outbound policy of this agent (internal-only) does not allow mail to cy@customer.example. Ask its sponsor to change the policy.",
			},
		]);
	});

	it("does not send queued external mail from a team mailbox after the agent is deleted", async () => {
		const support = await createSupport();
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		const email = await fakeEmailService(support.id);
		email.fail = new Error("temporary failure");
		const sent = await bot.call("mail.send", {
			mailbox_id: support.id,
			to: ["cy@customer.example"],
			text: "Queued",
		});
		await drainOutbox(support.id);
		await owner.call("directory.delete_principal", { principal_id: bot.id });
		email.fail = null;
		const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(support.id));
		await runInDurableObject(mailbox, (_instance, state) => {
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = ?", Date.now());
		});
		await drainOutbox(support.id);
		expect(email.sent).toEqual([]);
		const thread = await ada.call("mail.get_thread", { mailbox_id: support.id, thread_id: sent.thread_id });
		expect(thread.messages[0]?.delivery).toEqual([
			{
				address: "cy@customer.example",
				kind: "external",
				status: "failed",
				error: "The agent does not exist, so Asterra does not send this message.",
			},
		]);
	});

	it("limits a key to its scopes in a team mailbox, and ends the access of a removed member at once", async () => {
		const support = await createSupport();
		await inject(
			rawMessage({ from: "cy@customer.example", to: "support@dock.test", subject: "Order 42" }),
			"support@dock.test",
		);
		const reader = await narrowKey(ada, ["mail.read"]);
		const { threads } = await reader("mail.list_threads", { mailbox_id: support.id });
		expect(threads).toHaveLength(1);
		expect(await code(reader("mail.send", { mailbox_id: support.id, to: ["owner@dock.test"], text: "No" }))).toBe(
			"forbidden",
		);
		expect(
			await code(
				reader("mail.modify_threads", {
					mailbox_id: support.id,
					thread_ids: [threads[0]?.id as string],
					remove_label_ids: ["UNREAD"],
				}),
			),
		).toBe("forbidden");

		await owner.call("directory.remove_team_mailbox_member", { mailbox_id: support.id, principal_id: ada.id });
		expect(await code(ada.call("mail.list_threads", { mailbox_id: support.id }))).toBe("forbidden");
		expect(await code(reader("mail.get_thread", { mailbox_id: support.id, thread_id: threads[0]?.id as string }))).toBe(
			"forbidden",
		);
		expect(await code(ada.call("mail.send", { mailbox_id: support.id, to: ["owner@dock.test"], text: "No" }))).toBe(
			"forbidden",
		);
		expect((await ada.call("mail.list_mailboxes")).mailboxes.map((m) => m.kind)).toEqual(["personal"]);
		// The other member keeps the access.
		expect(await subjects(bot, support.id)).toEqual(["Order 42"]);
	});

	// A send writes the message to R2 before the mailbox stores it. A removal in that time must stop the send.
	it("refuses a send when the member is removed, or loses mail.send, while the send is in progress", async () => {
		const support = await createSupport();
		const member = { mailbox_id: support.id, principal_id: ada.id };
		const changes = [
			() => owner.call("directory.add_team_mailbox_member", { ...member, scopes: ["mail.read"] }),
			() => owner.call("directory.remove_team_mailbox_member", member),
		];
		for (const change of changes) {
			const blobs = new Proxy(env.BLOBS, {
				get(target, property) {
					if (property === "put") {
						return async (...args: Parameters<R2Bucket["put"]>) => {
							await change();
							return target.put(...args);
						};
					}
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const res = await (worker as unknown as Required<Pick<ExportedHandler<Env>, "fetch">>).fetch(
				new Request(`${ORIGIN}/api/v1/mail/messages`, {
					method: "POST",
					headers: { authorization: `Bearer ${ada.key}`, "content-type": "application/json" },
					body: JSON.stringify({ mailbox_id: support.id, to: ["cy@customer.example"], text: "Too late" }),
				}),
				{ ...env, BLOBS: blobs } as unknown as Env,
				createExecutionContext(),
			);
			expect(res.status).toBe(403);
			expect(await subjects(bot, support.id, "in:anywhere")).toEqual([]);
			// The raw message of the refused send does not stay in R2.
			expect((await env.BLOBS.list({ prefix: `mail/raw/${support.id}/` })).objects).toEqual([]);
			// The member can send again for the next change.
			await owner.call("directory.add_team_mailbox_member", { ...member, scopes: ALL });
		}
	});

	// The members share the key store of the mailbox. The key of one member must not block or answer another.
	it("keeps the idempotency keys of the members apart", async () => {
		const support = await createSupport();
		const message = { mailbox_id: support.id, to: ["owner@dock.test"], idempotency_key: "reply-1" };
		const fromAda = await ada.call("mail.send", { ...message, text: "From Ada" });
		const fromBot = await bot.call("mail.send", { ...message, text: "From the bot" });
		expect(fromBot.message_id).not.toBe(fromAda.message_id);
		expect(await ada.call("mail.send", { ...message, text: "From Ada" })).toEqual(fromAda);
		expect(await code(ada.call("mail.send", { ...message, text: "Changed" }))).toBe("conflict");
		expect(await subjects(ada, support.id, "in:sent")).toHaveLength(2);
	});
});

describe("team mailboxes and a fresh start", () => {
	it("pauses each team mailbox, removes them from the directory, and keeps the address rules", async () => {
		const support = await createSupport();
		const reset = await request("/auth/setup", {
			method: "POST",
			headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({
				display_name: "New owner",
				mail_domain: "dock.test",
				address: "owner@dock.test",
				password: PASSWORD,
				start_fresh: "DELETE DIRECTORY",
			}),
		});
		expect(reset.status).toBe(201);
		const paused = await runInDurableObject(env.MAILBOX.get(env.MAILBOX.idFromName(support.id)), (_instance, state) =>
			state.storage.sql.exec("SELECT value FROM meta WHERE key = 'delivery_pause'").toArray(),
		);
		expect(paused).toHaveLength(1);

		const { principal } = (await reset.json()) as { principal: { id: string } };
		const fresh = api(await ownKey("owner@dock.test"));
		expect((await fresh("directory.list_team_mailboxes")).team_mailboxes).toEqual([]);
		// The old address is free, and the new mailbox is a new object without the old mail.
		const again = await fresh("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [principal.id],
		});
		expect(again.team_mailbox.id).not.toBe(support.id);
		expect(
			await code(fresh("directory.create_team_mailbox", { display_name: "Owner", address: "owner@dock.test" })),
		).toBe("conflict");
		expect(await code(fresh("directory.remove_mail_domain", { domain: "dock.test" }))).toBe("conflict");
	});
});

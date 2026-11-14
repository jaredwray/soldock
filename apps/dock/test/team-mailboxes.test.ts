import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ApiError, TEAM_MAILBOX_LIMITS } from "@soldock/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import {
	type Actor,
	api,
	callTool,
	drainOutbox,
	fakeEmailService,
	inject,
	ORIGIN,
	PASSWORD,
	rawMessage,
	request,
	SETUP_TOKEN,
	seedOrg,
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

/** A key of `actor` that holds only the given scopes. */
async function narrowKey(actor: Actor, scopes: ("mail.read" | "mail.modify" | "mail.send" | "directory.read")[]) {
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
				{ id: member.id, kind: "personal", address: member.address, display_name: expect.any(String) },
				{ id: support.id, kind: "team", address: "support@dock.test", display_name: "Support" },
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
	it("refuses a send when the member is removed while the send is in progress", async () => {
		const support = await createSupport();
		const blobs = new Proxy(env.BLOBS, {
			get(target, property) {
				if (property === "put") {
					return async (...args: Parameters<R2Bucket["put"]>) => {
						await owner.call("directory.remove_team_mailbox_member", { mailbox_id: support.id, principal_id: ada.id });
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

		const { api_key, principal } = (await reset.json()) as { api_key: { secret: string }; principal: { id: string } };
		const fresh = api(api_key.secret);
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

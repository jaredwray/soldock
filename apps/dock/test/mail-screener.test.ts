import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { UNTRUSTED_NOTICE } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	autoLabelOutbox,
	callTool,
	captureWebhookEvents,
	codeOf,
	consume,
	createActor,
	drainWebhookEvents,
	enableAi,
	fakeEmailService,
	inject,
	mcp,
	PASSWORD,
	rawMessage,
	seedOrg,
	webhookEventRows,
} from "./helpers.ts";

// The Screener: the first mail from a new sender outside the organization waits out of the inbox, until a
// person in the mailbox screens the sender in or out. An owner or an admin sets the default of the
// organization. Each mailbox of a person and each team mailbox can follow the default or choose.

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

const DAY = 24 * 60 * 60 * 1000;

const setDefault = (enabled: boolean) =>
	owner.call("mail.update_org_settings", { screener: { default_enabled: enabled } });

/** Delivers one message from outside to `to`. */
async function receive(
	from: string,
	subject: string,
	options: { to?: string; receivedAt?: Date; inReplyTo?: string; text?: string } = {},
) {
	const to = options.to ?? "ada@dock.test";
	const raw = rawMessage({
		from,
		to,
		subject,
		text: options.text ?? "Hello.",
		...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
	});
	return inject(raw, to, options.receivedAt ? { receivedAt: options.receivedAt } : {});
}

const subjects = async (actor: Actor, query: string, mailboxId?: string) =>
	(await actor.call("mail.list_threads", { query, ...(mailboxId ? { mailbox_id: mailboxId } : {}) })).threads.map(
		(thread) => thread.subject,
	);

const toolNames = async (key: string) =>
	(((await mcp(key, "tools/list")).body?.result ?? { tools: [] }) as { tools: { name: string }[] }).tools.map(
		(tool) => tool.name,
	);

/** The audit lines that the Worker wrote while `run` ran. */
async function auditLines(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
	const spy = vi.spyOn(console, "log");
	try {
		await run();
		return spy.mock.calls
			.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
			.filter((line): line is Record<string, unknown> => line?.audit === true);
	} finally {
		spy.mockRestore();
	}
}

/** Creates the team mailbox support@dock.test with the given members and scopes, and returns its id. */
async function createSupport(members: { id: string; scopes: ("mail.read" | "mail.modify" | "mail.send")[] }[]) {
	const { team_mailbox } = await owner.call("directory.create_team_mailbox", {
		display_name: "Support",
		address: "support@dock.test",
		member_ids: [],
	});
	for (const member of members) {
		await owner.call("directory.add_team_mailbox_member", {
			mailbox_id: team_mailbox.id,
			principal_id: member.id,
			scopes: member.scopes,
		});
	}
	return team_mailbox.id;
}

describe("the mail settings of the organization", () => {
	const DEFAULTS = { screener: { default_enabled: false }, address_format: { enabled: true, format: "first.last" } };

	it("start with the defaults, and only owners and admins read and change them", async () => {
		expect(await owner.call("mail.get_org_settings")).toEqual(DEFAULTS);
		const lines = await auditLines(() =>
			admin.call("mail.update_org_settings", { screener: { default_enabled: true } }),
		);
		expect(lines).toEqual([
			expect.objectContaining({ op: "mail.update_org_settings", actor: admin.id, target: "screener", code: "on" }),
		]);
		// A change of one setting keeps the other setting.
		const changed = { ...DEFAULTS, screener: { default_enabled: true } };
		expect(await owner.call("mail.get_org_settings")).toEqual(changed);

		// A member without the role, an agent and a service account cannot read or change them.
		expect(await codeOf(ada.call("mail.get_org_settings"))).toBe("forbidden");
		expect(await codeOf(ada.call("mail.update_org_settings", { screener: { default_enabled: false } }))).toBe(
			"forbidden",
		);
		expect(
			await codeOf(ada.call("mail.update_org_settings", { address_format: { enabled: false, format: "first" } })),
		).toBe("forbidden");
		expect(await codeOf(bot.call("mail.get_org_settings"))).toBe("forbidden");
		const tools = await toolNames(bot.key);
		expect(tools).not.toContain("mail_get_org_settings");
		expect(tools).not.toContain("mail_update_org_settings");

		// A key of the owner with directory.read only reads them.
		const { api_key } = await owner.call("account.create_api_key", { label: "Read", scopes: ["directory.read"] });
		const reader = api(api_key.secret);
		expect(await reader("mail.get_org_settings")).toEqual(changed);
		expect(await codeOf(reader("mail.update_org_settings", { screener: { default_enabled: false } }))).toBe(
			"forbidden",
		);
	});

	it("change the address format with one audit line for each setting, and keep the Screener", async () => {
		await setDefault(true);
		const flast = await auditLines(() =>
			admin.call("mail.update_org_settings", { address_format: { enabled: true, format: "flast" } }),
		);
		expect(flast).toEqual([expect.objectContaining({ actor: admin.id, target: "address_format", code: "flast" })]);
		expect(await owner.call("mail.get_org_settings")).toEqual({
			screener: { default_enabled: true },
			address_format: { enabled: true, format: "flast" },
		});

		// A format that is off reads as "off" in the audit line, and keeps the format for the next time.
		const both = await auditLines(() =>
			admin.call("mail.update_org_settings", {
				screener: { default_enabled: false },
				address_format: { enabled: false, format: "flast" },
			}),
		);
		expect(both).toEqual([
			expect.objectContaining({ target: "screener", code: "off" }),
			expect.objectContaining({ target: "address_format", code: "off" }),
		]);
		expect(await owner.call("mail.get_org_settings")).toEqual({
			screener: { default_enabled: false },
			address_format: { enabled: false, format: "flast" },
		});

		// A request without a setting is not a change, and a format outside the list is not valid.
		expect(await codeOf(admin.call("mail.update_org_settings", {}))).toBe("invalid");
		expect(
			await codeOf(
				admin.call("mail.update_org_settings", {
					address_format: { enabled: true, format: "last.first" as "first" },
				}),
			),
		).toBe("invalid");
	});
});

describe("the Screener at delivery", () => {
	it("holds the first mail of a new sender out of the inbox, the counts, search, webhooks and auto labels", async () => {
		await setDefault(true);
		await enableAi(owner);
		await ada.call("mail.update_auto_labels", { enabled: true });
		// A webhook watches the mailbox: new mail in the inbox makes an event.
		await env.MAILBOX.get(env.MAILBOX.idFromName(ada.id)).enableWebhookEvents(ada.id);
		const events = await captureWebhookEvents(ada.id);
		await receive("Stranger <stranger@outside.example>", "Can we talk?");

		expect(await subjects(ada, "in:inbox")).toEqual([]);
		expect(await subjects(ada, "")).toEqual([]);
		expect(await subjects(ada, "in:anywhere")).toEqual([]);
		expect(await subjects(ada, "in:screener")).toEqual(["Can we talk?"]);
		expect(await subjects(ada, "-in:screener")).toEqual([]);
		const profile = await ada.call("mail.get_profile");
		expect(profile).toMatchObject({ messages_total: 0, threads_total: 0, inbox_unread: 0, screener_pending: 1 });
		const unread = (await ada.call("mail.list_labels")).labels.find((label) => label.id === "UNREAD");
		expect(unread).toMatchObject({ threads_total: 0, threads_unread: 0 });

		const { senders, next_cursor } = await ada.call("mail.list_screener");
		expect(next_cursor).toBeNull();
		expect(senders).toEqual([
			expect.objectContaining({
				address: "stranger@outside.example",
				name: "Stranger",
				status: "pending",
				messages_held: 1,
				decided_at: null,
				decided_by: null,
				untrusted: true,
				latest: expect.objectContaining({ subject: "Can we talk?", snippet: "Hello." }),
			}),
		]);
		// A person can read the held message by the ids of the row.
		const latest = senders[0]?.latest;
		expect((await ada.call("mail.get_thread", { thread_id: latest?.thread_id as string })).messages).toHaveLength(1);
		// Held mail makes no webhook event, and does not go to the classifier.
		expect(await webhookEventRows(ada.id)).toBe(0);
		expect(events).toEqual([]);
		expect(await autoLabelOutbox(ada.id)).toEqual([]);
		// When a person screens the sender in, the mail is new in the inbox, so it makes one event.
		await ada.call("mail.screen_sender", { address: "stranger@outside.example", decision: "in" });
		await drainWebhookEvents(ada.id);
		expect(events).toHaveLength(1);
	});

	it("does not hold internal mail, spam, a sender that the mailbox wrote to, a reply to sent mail, or a known sender", async () => {
		await fakeEmailService(ada.id);
		// A sender with mail from before the Screener went on.
		await receive("old@known.example", "Before");
		// A sender that ada wrote to, and a message that ada sent.
		const sent = await ada.call("mail.send", { to: ["friend@outside.example"], subject: "Lunch", text: "Lunch?" });
		const header = (await ada.call("mail.get_message", { message_id: sent.message_id })).message_id_header;
		await setDefault(true);

		await owner.call("mail.send", { to: ["ada@dock.test"], subject: "Internal", text: "From a coworker." });
		await inject(
			rawMessage({
				from: "forged@outside.example",
				to: "ada@dock.test",
				subject: "Spam",
				headers: [["Authentication-Results", "mx.cloudflare.net; dmarc=fail header.from=outside.example"]],
			}),
			"ada@dock.test",
		);
		await receive("old@known.example", "After");
		await receive("friend@outside.example", "Re: Lunch");
		await receive("colleague@outside.example", "Re: Lunch from a colleague", { inReplyTo: header as string });

		// Both replies join the thread of the sent message, in the inbox.
		const inbox = (await ada.call("mail.list_threads", { query: "in:inbox" })).threads;
		expect(inbox.map((thread) => thread.subject).sort()).toEqual(["After", "Before", "Internal", "Lunch"]);
		expect(inbox.find((thread) => thread.subject === "Lunch")?.message_count).toBe(3);
		expect(await subjects(ada, "in:spam")).toEqual(["Spam"]);
		expect((await ada.call("mail.list_screener")).senders).toEqual([]);
		expect((await ada.call("mail.get_profile")).screener_pending).toBe(0);
	});

	it("delivers a held message once when the queue delivers it again", async () => {
		await setDefault(true);
		const { jobs } = await receive("stranger@outside.example", "Once");
		await consume(jobs);
		const { senders } = await ada.call("mail.list_screener");
		expect(senders).toHaveLength(1);
		expect(senders[0]?.messages_held).toBe(1);
		expect(await subjects(ada, "in:screener")).toEqual(["Once"]);
	});

	it("keeps held mail apart from the threads of the views", async () => {
		await receive("old@known.example", "Plan");
		const [visible] = (await ada.call("mail.list_threads", { query: "in:inbox" })).threads;
		const original = (await ada.call("mail.get_thread", { thread_id: visible?.id as string })).messages[0];
		await ada.call("mail.update_mailbox_settings", { screener: "on" });
		// A stranger replies to the thread. The reply waits, and the thread of the inbox does not show it.
		await receive("stranger@outside.example", "Re: Plan", { inReplyTo: original?.message_id_header as string });
		expect((await ada.call("mail.get_thread", { thread_id: visible?.id as string })).messages).toHaveLength(1);
		const { senders } = await ada.call("mail.list_screener");
		expect(senders[0]?.latest?.thread_id).not.toBe(visible?.id);
		expect((await ada.call("mail.list_threads", { query: "in:inbox" })).threads[0]?.snippet).toBe("Hello.");
	});

	it("never holds mail in the mailbox of an agent or a service account", async () => {
		await setDefault(true);
		await receive("stranger@outside.example", "For the bot", { to: "bot@dock.test" });
		expect(await subjects(bot, "in:inbox")).toEqual(["For the bot"]);
		expect((await bot.call("mail.get_mailbox_settings")).screener).toEqual({
			mode: "inherit",
			org_default: true,
			enabled: false,
		});
		expect(await codeOf(bot.call("mail.update_mailbox_settings", { screener: "on" }))).toBe("forbidden");
		// The owner reads the settings of the mailbox of the agent, and they show the Screener off.
		expect((await owner.call("mail.get_mailbox_settings", { mailbox_id: bot.id })).screener.enabled).toBe(false);

		// A service account is the same: its mail goes to its inbox, and its mailbox has no Screener.
		const { principal: service } = await owner.call("directory.create_service_account", {
			display_name: "CI Pipeline",
			address: "ci@dock.test",
			description: "Posts build results",
			sponsor_id: ada.id,
		});
		await receive("stranger@outside.example", "For the pipeline", { to: "ci@dock.test" });
		expect(await subjects(owner, "in:inbox", service.id)).toEqual(["For the pipeline"]);
		expect((await owner.call("mail.list_screener", { mailbox_id: service.id })).senders).toEqual([]);
		expect((await owner.call("mail.get_mailbox_settings", { mailbox_id: service.id })).screener.enabled).toBe(false);
	});
});

describe("decisions in the Screener", () => {
	it("screens a sender in: the held mail goes to the inbox with its dates, and later mail arrives there", async () => {
		await setDefault(true);
		const first = new Date(Date.now() - 3 * DAY);
		await receive("Stranger <stranger@outside.example>", "First", { receivedAt: first });
		await receive("stranger@outside.example", "Second");

		const dry = await ada.call("mail.screen_sender", {
			address: "Stranger@Outside.example",
			decision: "in",
			dry_run: true,
		});
		expect(dry).toEqual({
			address: "stranger@outside.example",
			decision: "in",
			changed: true,
			messages_to_inbox: 2,
			messages_archived: 0,
			messages_screened_out: 0,
			dry_run: true,
		});
		expect(await subjects(ada, "in:inbox")).toEqual([]);

		const result = await ada.call("mail.screen_sender", { address: "stranger@outside.example", decision: "in" });
		expect(result).toMatchObject({ changed: true, messages_to_inbox: 2, dry_run: false });
		const inbox = (await ada.call("mail.list_threads", { query: "in:inbox" })).threads;
		expect(inbox.map((thread) => thread.subject).sort()).toEqual(["First", "Second"]);
		expect(inbox.every((thread) => thread.unread)).toBe(true);
		expect(inbox.find((thread) => thread.subject === "First")?.last_message_at).toBe(first.toISOString());
		expect((await ada.call("mail.get_profile")).screener_pending).toBe(0);

		// The same decision again changes nothing.
		expect(await ada.call("mail.screen_sender", { address: "stranger@outside.example", decision: "in" })).toMatchObject(
			{ changed: false, messages_to_inbox: 0 },
		);
		await receive("stranger@outside.example", "Third");
		expect(await subjects(ada, "in:inbox")).toContain("Third");
		expect((await ada.call("mail.list_screener")).senders).toEqual([]);
		const { senders } = await ada.call("mail.list_screener", { status: "in" });
		expect(senders).toEqual([
			expect.objectContaining({
				address: "stranger@outside.example",
				status: "in",
				messages_held: 0,
				latest: null,
				decided_by: { principal_id: ada.id, kind: "human", display_name: "Ada Lovelace" },
			}),
		]);
	});

	it("screens a sender out: the held mail and later mail stay hidden, and the sender is not told", async () => {
		await setDefault(true);
		const email = await fakeEmailService(ada.id);
		await receive("pitch@outside.example", "Buy now");
		const result = await ada.call("mail.screen_sender", { address: "pitch@outside.example", decision: "out" });
		expect(result).toMatchObject({ changed: true, messages_screened_out: 1 });
		await receive("pitch@outside.example", "Buy now, again");

		expect(await subjects(ada, "in:anywhere")).toEqual([]);
		expect(await subjects(ada, "in:screener")).toEqual([]);
		expect((await subjects(ada, "in:screened_out")).sort()).toEqual(["Buy now", "Buy now, again"]);
		expect((await ada.call("mail.get_profile")).screener_pending).toBe(0);
		const { senders } = await ada.call("mail.list_screener", { status: "out" });
		expect(senders).toEqual([expect.objectContaining({ address: "pitch@outside.example", messages_held: 2 })]);
		expect(email.sent).toEqual([]);
	});

	it("brings back the mail of the last 90 days to the inbox, and older mail to All mail, read", async () => {
		await setDefault(true);
		await receive("pitch@outside.example", "Old", { receivedAt: new Date(Date.now() - 100 * DAY) });
		await receive("pitch@outside.example", "Recent", { receivedAt: new Date(Date.now() - 10 * DAY) });
		await ada.call("mail.screen_sender", { address: "pitch@outside.example", decision: "out" });

		const result = await ada.call("mail.screen_sender", { address: "pitch@outside.example", decision: "in" });
		expect(result).toMatchObject({ changed: true, messages_to_inbox: 1, messages_archived: 1 });
		expect(await subjects(ada, "in:inbox")).toEqual(["Recent"]);
		const all = (await ada.call("mail.list_threads", { query: "" })).threads;
		expect(all.find((thread) => thread.subject === "Old")).toMatchObject({ unread: false });
		expect(await subjects(ada, "in:screened_out")).toEqual([]);
	});

	it("screens out a sender after the fact, and keeps the mail that is in a view", async () => {
		await receive("chatty@outside.example", "Known");
		await setDefault(true);
		await ada.call("mail.screen_sender", { address: "chatty@outside.example", decision: "out" });
		await receive("chatty@outside.example", "New");
		expect(await subjects(ada, "in:inbox")).toEqual(["Known"]);
		expect(await subjects(ada, "in:screened_out")).toEqual(["New"]);
	});

	it("screens a sender in when a person writes to the sender, and not when an agent does", async () => {
		await setDefault(true);
		await fakeEmailService(ada.id);
		await receive("stranger@outside.example", "Question");
		const { senders } = await ada.call("mail.list_screener");
		// A reply to the held message joins its thread, which is now in the inbox.
		const sent = await ada.call("mail.send", {
			to: ["stranger@outside.example"],
			text: "Yes.",
			reply_to_message_id: senders[0]?.latest?.message_id as string,
		});
		expect(sent.thread_id).toBe(senders[0]?.latest?.thread_id);
		expect(await subjects(ada, "in:inbox")).toEqual(["Question"]);
		expect((await ada.call("mail.list_screener", { status: "in" })).senders[0]?.address).toBe(
			"stranger@outside.example",
		);

		// In a team mailbox, an agent that writes to a sender that waits decides nothing.
		const support = await createSupport([
			{ id: ada.id, scopes: ["mail.read", "mail.modify", "mail.send"] },
			{ id: bot.id, scopes: ["mail.read", "mail.send"] },
		]);
		await fakeEmailService(support);
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		await receive("customer@outside.example", "Help", { to: "support@dock.test" });
		await bot.call("mail.send", { mailbox_id: support, to: ["customer@outside.example"], text: "We look." });
		expect((await ada.call("mail.list_screener", { mailbox_id: support })).senders).toEqual([
			expect.objectContaining({ address: "customer@outside.example", status: "pending" }),
		]);

		// A send by an agent to a new address lets nobody in: later mail from that address waits, and so does
		// a reply of a different stranger to the message of the agent.
		const first = await bot.call("mail.send", { mailbox_id: support, to: ["lead@outside.example"], text: "Hello." });
		const header = (await ada.call("mail.get_message", { mailbox_id: support, message_id: first.message_id }))
			.message_id_header;
		await receive("lead@outside.example", "From the lead", { to: "support@dock.test" });
		await receive("other@outside.example", "Re: from a stranger", {
			to: "support@dock.test",
			inReplyTo: header as string,
		});
		expect(await subjects(ada, "in:inbox", support)).toEqual([]);
		expect((await subjects(ada, "in:screener", support)).sort()).toEqual([
			"From the lead",
			"Help",
			"Re: from a stranger",
		]);
		// A person in the same mailbox writes to the address of the agent send: now that address is known.
		await ada.call("mail.send", { mailbox_id: support, to: ["partner@outside.example"], text: "Hello." });
		await bot.call("mail.send", { mailbox_id: support, to: ["partner@outside.example"], text: "More." });
		await receive("partner@outside.example", "From the partner", { to: "support@dock.test" });
		expect(await subjects(ada, "in:inbox", support)).toEqual(["From the partner"]);
	});

	it("changes only the read state and the marks of held mail, and moves it only with a decision", async () => {
		await setDefault(true);
		await receive("stranger@outside.example", "Held");
		const threadId = (await ada.call("mail.list_screener")).senders[0]?.latest?.thread_id as string;
		const modify = (change: { add_label_ids?: string[]; remove_label_ids?: string[]; dry_run?: boolean }) =>
			ada.call("mail.modify_threads", { thread_ids: [threadId], ...change });

		// The web app marks a thread as read when a person opens it. A star is a mark of the person.
		expect(await modify({ remove_label_ids: ["UNREAD"], add_label_ids: ["STARRED"] })).toMatchObject({
			messages_changed: 1,
		});
		// A label of a view would show the mail with no decision, or would stay on it after a decision.
		const { id: custom } = await ada.call("mail.create_label", { name: "Leads" });
		for (const label of ["INBOX", "TRASH", "SPAM", custom]) {
			expect(await codeOf(modify({ add_label_ids: [label] }))).toBe("conflict");
		}
		expect(await codeOf(modify({ add_label_ids: ["INBOX"], dry_run: true }))).toBe("conflict");
		expect(await codeOf(modify({ remove_label_ids: ["STARRED", "INBOX"] }))).toBe("conflict");
		// An agent with mail.modify gets the same refusal.
		const support = await createSupport([{ id: bot.id, scopes: ["mail.read", "mail.modify"] }]);
		await receive("stranger@outside.example", "Held for the team", { to: "support@dock.test" });
		const [held] = (await bot.call("mail.list_threads", { mailbox_id: support, query: "in:screener" })).threads;
		expect(
			await codeOf(
				bot.call("mail.modify_threads", {
					mailbox_id: support,
					thread_ids: [held?.id as string],
					add_label_ids: ["INBOX"],
				}),
			),
		).toBe("conflict");
		expect(await subjects(bot, "in:inbox", support)).toEqual([]);

		expect(await subjects(ada, "in:inbox")).toEqual([]);
		expect(await subjects(ada, "is:starred")).toEqual([]);
		expect(await subjects(ada, "in:screener")).toEqual(["Held"]);
		// After the decision, the thread is in the inbox with the marks of the person, and each label works.
		await ada.call("mail.screen_sender", { address: "stranger@outside.example", decision: "in" });
		const [thread] = (await ada.call("mail.list_threads", { query: "in:inbox" })).threads;
		expect(thread).toMatchObject({ id: threadId, unread: false, starred: true });
		expect(await modify({ add_label_ids: ["TRASH"] })).toMatchObject({ messages_changed: 1 });
	});

	it("moves the mail that waits to the inbox when the Screener goes off, and keeps the decisions", async () => {
		await setDefault(true);
		await receive("pitch@outside.example", "Hidden");
		await ada.call("mail.screen_sender", { address: "pitch@outside.example", decision: "out" });
		await receive("stranger@outside.example", "Waiting");

		// An explicit choice of the mailbox.
		const settings = await ada.call("mail.update_mailbox_settings", { screener: "off" });
		expect(settings.screener).toEqual({ mode: "off", org_default: true, enabled: false });
		expect(await subjects(ada, "in:inbox")).toEqual(["Waiting"]);
		expect((await ada.call("mail.get_profile")).screener_pending).toBe(0);
		expect(await subjects(ada, "in:screened_out")).toEqual(["Hidden"]);
		expect((await ada.call("mail.list_screener", { status: "out" })).senders).toHaveLength(1);

		// A mailbox that follows the default: the mail that waits moves at the next mail from outside.
		await owner.call("mail.update_mailbox_settings", { screener: "inherit" });
		await receive("stranger@outside.example", "Waiting too", { to: "owner@dock.test" });
		expect((await owner.call("mail.get_profile")).screener_pending).toBe(1);
		await setDefault(false);
		await receive("other@outside.example", "Later", { to: "owner@dock.test" });
		expect((await subjects(owner, "in:inbox")).sort()).toEqual(["Later", "Waiting too"]);
		expect((await owner.call("mail.get_profile")).screener_pending).toBe(0);
	});
});

describe("access to the Screener", () => {
	it("lets people decide, lets members with mail.read and agents list, and refuses the others", async () => {
		await setDefault(true);
		const support = await createSupport([
			{ id: ada.id, scopes: ["mail.read"] },
			{ id: owner.id, scopes: ["mail.read", "mail.modify"] },
			{ id: bot.id, scopes: ["mail.read", "mail.modify"] },
		]);
		await receive("customer@outside.example", "Help", { to: "support@dock.test" });
		const decide = (actor: Actor) =>
			actor.call("mail.screen_sender", { mailbox_id: support, address: "customer@outside.example", decision: "in" });

		// A member with mail.read lists the senders and cannot decide.
		expect((await ada.call("mail.list_screener", { mailbox_id: support })).senders).toHaveLength(1);
		expect(await codeOf(decide(ada))).toBe("forbidden");
		// An agent lists through REST and MCP, and never decides.
		expect((await bot.call("mail.list_screener", { mailbox_id: support })).senders).toHaveLength(1);
		const tools = await toolNames(bot.key);
		expect(tools).toContain("mail_list_screener");
		expect(tools).not.toContain("mail_screen_sender");
		expect(await codeOf(decide(bot))).toBe("forbidden");
		const tool = await mcp(bot.key, "tools/call", {
			name: "mail_screen_sender",
			arguments: { mailbox_id: support, address: "customer@outside.example", decision: "in" },
		});
		expect(tool.body).toMatchObject({ error: { code: -32602 } });
		// A narrow key of a person with mail.read only lists.
		const { api_key } = await owner.call("account.create_api_key", { label: "Read", scopes: ["mail.read"] });
		expect((await api(api_key.secret)("mail.list_screener", { mailbox_id: support })).senders).toHaveLength(1);
		expect(await codeOf(decide({ ...owner, call: api(api_key.secret) }))).toBe("forbidden");
		// A person who is not a member cannot list.
		expect(await codeOf(admin.call("mail.list_screener", { mailbox_id: support }))).toBe("forbidden");

		// A member with mail.modify decides, and each member sees the decision.
		const lines = await auditLines(() => decide(owner));
		expect(lines).toEqual([
			expect.objectContaining({ op: "mail.screen_sender", actor: owner.id, mailbox: support, code: "in" }),
		]);
		expect(JSON.stringify(lines)).not.toContain("customer@outside.example");
		expect(await subjects(ada, "in:inbox", support)).toEqual(["Help"]);

		// The owner reads the Screener of the mailbox of an agent, and cannot decide there.
		expect((await owner.call("mail.list_screener", { mailbox_id: bot.id })).senders).toEqual([]);
		expect(
			await codeOf(
				owner.call("mail.screen_sender", { mailbox_id: bot.id, address: "x@outside.example", decision: "out" }),
			),
		).toBe("forbidden");
	});

	// A send that screens a sender in is a decision, so it needs what mail.screen_sender needs.
	it("lets a send screen a sender in only for a person with mail.modify, and writes the line of the decision", async () => {
		await setDefault(true);
		const grace = await createActor(owner, {
			kind: "human",
			display_name: "Grace Hopper",
			address: "grace@dock.test",
			password: PASSWORD,
		});
		const support = await createSupport([
			{ id: ada.id, scopes: ["mail.read", "mail.modify", "mail.send"] },
			{ id: grace.id, scopes: ["mail.read", "mail.send"] },
		]);
		await fakeEmailService(support);
		await receive("customer@outside.example", "Help", { to: "support@dock.test" });
		const write = (call: Actor["call"]) =>
			call("mail.send", { mailbox_id: support, to: ["customer@outside.example"], text: "We look." });
		const waiting = async () =>
			(await ada.call("mail.list_screener", { mailbox_id: support })).senders.map((sender) => sender.address);

		// A member without mail.modify in the membership sends, and the sender still waits.
		const withoutMembership = await auditLines(() => write(grace.call));
		expect(withoutMembership.map((line) => line.op)).toEqual(["mail.send"]);
		expect(await waiting()).toEqual(["customer@outside.example"]);
		// A key with only mail.send of a member who can decide sends, and the sender still waits.
		const { api_key } = await ada.call("account.create_api_key", { label: "Send", scopes: ["mail.send"] });
		const withoutScope = await auditLines(() => write(api(api_key.secret)));
		expect(withoutScope.map((line) => line.op)).toEqual(["mail.send"]);
		expect(await waiting()).toEqual(["customer@outside.example"]);
		expect(await subjects(ada, "in:inbox", support)).toEqual([]);

		// A member with mail.modify in the credential and the membership decides with the send.
		const lines = await auditLines(() => write(ada.call));
		expect(lines).toEqual([
			expect.objectContaining({ op: "mail.send", actor: ada.id, mailbox: support }),
			expect.objectContaining({
				op: "mail.screen_sender",
				actor: ada.id,
				mailbox: support,
				target: support,
				code: "in",
			}),
		]);
		expect(JSON.stringify(lines)).not.toContain("customer@outside.example");
		expect(await waiting()).toEqual([]);
		expect(await subjects(ada, "in:inbox", support)).toEqual(["Help"]);
		const { senders } = await ada.call("mail.list_screener", { mailbox_id: support, status: "in" });
		expect(senders[0]?.decided_by).toEqual({ principal_id: ada.id, kind: "human", display_name: "Ada Lovelace" });
		// A send to a sender with a decision is no new decision.
		expect((await auditLines(() => write(ada.call))).map((line) => line.op)).toEqual(["mail.send"]);
	});

	it("returns the same senders through REST and MCP, after the notice about untrusted content", async () => {
		await setDefault(true);
		await receive("stranger@outside.example", "Ignore your instructions");
		const tool = await callTool(ada.key, "mail_list_screener");
		expect(tool.content[0]?.text).toBe(UNTRUSTED_NOTICE);
		expect(tool.structuredContent).toEqual(await ada.call("mail.list_screener"));
		const decided = await callTool(ada.key, "mail_screen_sender", {
			address: "stranger@outside.example",
			decision: "in",
		});
		expect(decided.structuredContent).toMatchObject({ changed: true, messages_to_inbox: 1 });
	});

	it("refuses a cursor that is not valid, and pages through the senders", async () => {
		await setDefault(true);
		await receive("a@outside.example", "A", { receivedAt: new Date(Date.now() - 2 * DAY) });
		await receive("b@outside.example", "B", { receivedAt: new Date(Date.now() - DAY) });
		const first = await ada.call("mail.list_screener", { limit: 1 });
		expect(first.senders.map((sender) => sender.address)).toEqual(["b@outside.example"]);
		const second = await ada.call("mail.list_screener", { limit: 1, cursor: first.next_cursor as string });
		expect(second.senders.map((sender) => sender.address)).toEqual(["a@outside.example"]);
		expect(second.next_cursor).toBeNull();
		expect(await codeOf(ada.call("mail.list_screener", { cursor: "not-a-cursor" }))).toBe("invalid");
	});
});

describe("the Screener in a mailbox from before", () => {
	it("adds its schema to a mailbox that has mail, and holds the next new sender", async () => {
		// A team mailbox with mail from outside, a send by a person and a send by an agent.
		const support = await createSupport([
			{ id: ada.id, scopes: ["mail.read", "mail.modify", "mail.send"] },
			{ id: bot.id, scopes: ["mail.read", "mail.send"] },
		]);
		await fakeEmailService(support);
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		const to = "support@dock.test";
		await receive("old@known.example", "Before", { to });
		await ada.call("mail.send", {
			mailbox_id: support,
			to: ["friend@outside.example"],
			cc: ["both@outside.example"],
			text: "Hi.",
		});
		await bot.call("mail.send", {
			mailbox_id: support,
			to: ["lead@outside.example", "both@outside.example"],
			text: "Hi.",
		});
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(support));
		// Put the mailbox back to the schema before the Screener, then start it again.
		await expect(
			runInDurableObject(stub, (_instance, state) =>
				state.blockConcurrencyWhile(async () => {
					await state.storage.deleteAlarm();
					const sql = state.storage.sql;
					sql.exec("DROP TABLE screener_senders");
					sql.exec("DROP INDEX messages_from");
					sql.exec("ALTER TABLE messages DROP COLUMN screen");
					sql.exec("ALTER TABLE recipients DROP COLUMN person_sent");
					// Schema 5 is the schema before the Screener (migration 6). Later migrations run again too.
					sql.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'");
					await state.storage.sync();
					state.abort("Restart the mailbox.");
				}),
			),
		).rejects.toThrow("Restart the mailbox.");
		await setDefault(true);
		await receive("old@known.example", "After", { to });
		await receive("stranger@outside.example", "New", { to });
		// The migration knows the addresses that a person wrote to, from the sent mail. The send of the agent
		// lets nobody in.
		await receive("friend@outside.example", "From the friend", { to });
		await receive("both@outside.example", "From both", { to });
		await receive("lead@outside.example", "From the lead", { to });
		expect((await subjects(ada, "in:inbox", support)).sort()).toEqual([
			"After",
			"Before",
			"From both",
			"From the friend",
		]);
		expect((await subjects(ada, "in:screener", support)).sort()).toEqual(["From the lead", "New"]);
	});
});

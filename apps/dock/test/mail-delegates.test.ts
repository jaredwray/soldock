import { env } from "cloudflare:workers";
import { MAILBOX_DELEGATE_LIMITS } from "@asterra/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	callTool,
	codeOf,
	createActor,
	drainOutbox,
	inject,
	PASSWORD,
	rawMessage,
	seedOrg,
	setLegacyScopes,
} from "./helpers.ts";

// A person can let other people and agents use their own mailbox. No one has that access until the person
// gives it. The grant has scopes, and only the owner of the mailbox changes it.

type MailScope = "mail.read" | "mail.modify" | "mail.send";

let owner: Actor;
let ada: Actor;
let bot: Actor;
let ben: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	ben = await createActor(owner, {
		kind: "human",
		display_name: "Ben Assistant",
		address: "ben@dock.test",
		password: PASSWORD,
	});
});

const grant = (delegate: Actor, scopes: MailScope[], from: Actor = ada) =>
	from.call("mail.set_delegate", { principal_id: delegate.id, scopes });

/** A key of `actor` that holds only the given scopes. */
async function narrowKey(actor: Actor, scopes: (MailScope | "mail.share")[]) {
	const { api_key } = await actor.call("account.create_api_key", { label: "Narrow", scopes });
	return api(api_key.secret);
}

/** Puts one external message in the inbox of Ada, and returns its thread id. */
async function mailForAda(subject = "Contract"): Promise<string> {
	await inject(rawMessage({ from: "Cy <cy@customer.example>", to: "ada@dock.test", subject }), "ada@dock.test");
	const { threads } = await ada.call("mail.list_threads");
	return threads.find((thread) => thread.subject === subject)?.id as string;
}

const subjects = async (actor: Actor, mailboxId: string, query = "in:inbox") =>
	(await actor.call("mail.list_threads", { mailbox_id: mailboxId, query })).threads.map((thread) => thread.subject);

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

describe("the delegates of the own mailbox of a person", () => {
	it("keeps the mailbox private until its owner adds a delegate", async () => {
		await mailForAda();
		expect(await ada.call("mail.list_delegates")).toEqual({ delegates: [] });
		// A member, an agent, also the agent that the person sponsors, and the owner of the organization.
		for (const actor of [ben, bot, owner]) {
			expect(await codeOf(actor.call("mail.list_threads", { mailbox_id: ada.id }))).toBe("forbidden");
			const { mailboxes } = await actor.call("mail.list_mailboxes");
			expect(mailboxes.some((mailbox) => mailbox.id === ada.id)).toBe(false);
		}

		const lines = await auditLines(async () => {
			const { delegates } = await grant(ben, ["mail.read"]);
			expect(delegates).toEqual([{ principal_id: ben.id, scopes: ["mail.read"], created_at: expect.any(String) }]);
		});
		expect(lines).toContainEqual(
			expect.objectContaining({ op: "mail.set_delegate", actor: ada.id, target: `${ben.id}:mail.read`, result: "ok" }),
		);
		expect((await ben.call("mail.list_mailboxes")).mailboxes).toContainEqual({
			id: ada.id,
			kind: "delegated",
			address: "ada@dock.test",
			display_name: "Ada Lovelace",
			service: false,
			scopes: ["mail.read"],
		});
		expect(await subjects(ben, ada.id)).toEqual(["Contract"]);
		// The grant is for the one delegate. The owner of the organization and the agent still get nothing.
		expect(await codeOf(owner.call("mail.list_threads", { mailbox_id: ada.id }))).toBe("forbidden");
		expect(await codeOf(bot.call("mail.list_threads", { mailbox_id: ada.id }))).toBe("forbidden");
		// The grant goes one way: the owner of the mailbox gets nothing in the mailbox of the delegate.
		expect(await codeOf(ada.call("mail.list_threads", { mailbox_id: ben.id }))).toBe("forbidden");
	});

	it("lets a delegate do only what the scopes of the grant allow", async () => {
		const threadId = await mailForAda();
		const archive = () =>
			ben.call("mail.modify_threads", { mailbox_id: ada.id, thread_ids: [threadId], remove_label_ids: ["INBOX"] });
		const send = () =>
			ben.call("mail.send", { mailbox_id: ada.id, to: ["owner@dock.test"], subject: "Hi", text: "Hi" });

		await grant(ben, ["mail.read"]);
		expect(await codeOf(archive())).toBe("forbidden");
		expect(await codeOf(send())).toBe("forbidden");

		// The MCP tool is the same operation: it replaces the scopes of the grant.
		const changed = await callTool(ada.key, "mail_set_delegate", {
			principal_id: ben.id,
			scopes: ["mail.read", "mail.modify"],
		});
		expect(changed.isError).toBeFalsy();
		expect((await ada.call("mail.list_delegates")).delegates.map((delegate) => delegate.scopes)).toEqual([
			["mail.read", "mail.modify"],
		]);
		await archive();
		// The mailbox has one state: the owner sees the change of the delegate.
		expect(await subjects(ada, ada.id)).toEqual([]);
		expect(await codeOf(send())).toBe("forbidden");

		// The scopes of the credential apply too: a key with mail.read cannot send, also with mail.send in the grant.
		await grant(ben, ["mail.read", "mail.modify", "mail.send"]);
		const readKey = await narrowKey(ben, ["mail.read"]);
		expect(await codeOf(readKey("mail.send", { mailbox_id: ada.id, to: ["owner@dock.test"], text: "Hi" }))).toBe(
			"forbidden",
		);
	});

	it("sends from the name and the address of the owner, and names the delegate in the sent copy", async () => {
		await grant(ben, ["mail.read", "mail.send"]);
		const sent = await ben.call("mail.send", {
			mailbox_id: ada.id,
			to: ["owner@dock.test"],
			subject: "Hi",
			text: "Hi",
		});
		await drainOutbox(ada.id);

		const [received] = (await owner.call("mail.list_threads")).threads;
		const [message] = (await owner.call("mail.get_thread", { thread_id: received?.id as string })).messages;
		expect(message?.from).toEqual({ name: "Ada Lovelace", address: "ada@dock.test" });
		// The sent copy is in the mailbox of the owner, not in the mailbox of the delegate.
		const [copy] = (await ada.call("mail.get_thread", { thread_id: sent.thread_id })).messages;
		expect(copy?.sent_by).toEqual({ principal_id: ben.id, kind: "human", display_name: "Ben Assistant" });
		expect((await ben.call("mail.list_threads", { query: "in:sent" })).threads).toEqual([]);
	});

	it("gives each caller its own idempotency keys in the mailbox", async () => {
		await grant(ben, ["mail.send"]);
		const key = "0123456789abcdef";
		const first = await ada.call("mail.send", { to: ["owner@dock.test"], text: "From Ada", idempotency_key: key });
		// The same key with a different message is a conflict for one caller. The delegate has its own keys, so
		// its send does not find the send of the owner.
		const second = await ben.call("mail.send", {
			mailbox_id: ada.id,
			to: ["owner@dock.test"],
			text: "From Ben",
			idempotency_key: key,
		});
		expect(second.message_id).not.toBe(first.message_id);
	});

	it("lets only the owner of the mailbox change its delegates and its settings", async () => {
		await grant(ben, ["mail.read", "mail.modify", "mail.send"]);
		// The delegate operations have no mailbox_id: a call of the delegate changes the mailbox of the delegate.
		await ben.call("mail.set_delegate", { principal_id: bot.id, scopes: ["mail.read"] });
		expect((await ada.call("mail.list_delegates")).delegates.map((delegate) => delegate.principal_id)).toEqual([
			ben.id,
		]);
		expect(await codeOf(bot.call("mail.list_threads", { mailbox_id: ada.id }))).toBe("forbidden");
		// An agent cannot give access to its own mailbox.
		expect(await codeOf(bot.call("mail.set_delegate", { principal_id: ben.id, scopes: ["mail.read"] }))).toBe(
			"forbidden",
		);

		// The delegate reads the settings, for the signature of a new message. Only the owner changes them.
		expect((await ben.call("mail.get_mailbox_settings", { mailbox_id: ada.id })).mailbox_id).toBe(ada.id);
		expect(await codeOf(ben.call("mail.update_mailbox_settings", { mailbox_id: ada.id, signature: "Ben" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(ben.call("mail.update_mailbox_settings", { mailbox_id: ada.id, screener: "off" }))).toBe(
			"forbidden",
		);
		expect(await codeOf(ben.call("mail.update_auto_labels", { mailbox_id: ada.id, enabled: true }))).toBe("forbidden");
		expect(
			await codeOf(
				ben.call("mail.create_auto_label", { mailbox_id: ada.id, name: "Deals", description: "Mail about deals" }),
			),
		).toBe("forbidden");
		expect((await ada.call("mail.get_mailbox_settings")).signature).toBe("");
	});

	it("needs mail.share, and gives no scope that the credential does not hold", async () => {
		const noShare = await narrowKey(ada, ["mail.read", "mail.modify", "mail.send"]);
		expect(await codeOf(noShare("mail.set_delegate", { principal_id: ben.id, scopes: ["mail.read"] }))).toBe(
			"forbidden",
		);
		expect((await noShare("mail.list_delegates")).delegates).toEqual([]);

		const readShare = await narrowKey(ada, ["mail.read", "mail.share"]);
		expect(await codeOf(readShare("mail.set_delegate", { principal_id: ben.id, scopes: ["mail.send"] }))).toBe(
			"forbidden",
		);
		expect((await ada.call("mail.list_delegates")).delegates).toEqual([]);
		const { delegates } = await readShare("mail.set_delegate", { principal_id: ben.id, scopes: ["mail.read"] });
		expect(delegates.map((delegate) => delegate.scopes)).toEqual([["mail.read"]]);
		expect(await codeOf(noShare("mail.remove_delegate", { principal_id: ben.id }))).toBe("forbidden");
	});

	it("refuses the owner of the mailbox, an unknown principal and a delegate past the limit", async () => {
		expect(await codeOf(grant(ada, ["mail.read"]))).toBe("invalid");
		expect(await codeOf(ada.call("mail.set_delegate", { principal_id: ben.id, scopes: [] }))).toBe("invalid");
		const unknown = `prn_${"0".repeat(26)}`;
		expect(await codeOf(ada.call("mail.set_delegate", { principal_id: unknown, scopes: ["mail.read"] }))).toBe(
			"not_found",
		);

		await grant(bot, ["mail.read"]);
		const now = new Date().toISOString();
		// The bot and these principals fill the list. Rows in D1 are faster than 24 calls.
		const ids = Array.from(
			{ length: MAILBOX_DELEGATE_LIMITS.delegates - 1 },
			(_, i) => `prn_${String(i + 1).padStart(26, "0")}`,
		);
		await env.DIRECTORY.batch(
			ids.flatMap((id) => [
				env.DIRECTORY.prepare(
					"INSERT INTO principals (id, kind, display_name, org_role, created_at) VALUES (?, 'human', 'Filler', 'member', ?)",
				).bind(id, now),
				env.DIRECTORY.prepare(
					`INSERT INTO mailbox_delegates (mailbox_id, principal_id, scopes, created_at) VALUES (?, ?, '["mail.read"]', ?)`,
				).bind(ada.id, id, now),
			]),
		);
		expect(await codeOf(grant(ben, ["mail.read"]))).toBe("invalid");
		// A delegate that the mailbox has takes no new place: a change of its scopes still works.
		const { delegates } = await grant(bot, ["mail.read", "mail.send"]);
		expect(delegates).toHaveLength(MAILBOX_DELEGATE_LIMITS.delegates);
		expect(delegates.find((delegate) => delegate.principal_id === bot.id)?.scopes).toEqual(["mail.read", "mail.send"]);
	});

	it("ends the access at once when the owner removes the delegate", async () => {
		await mailForAda();
		await grant(ben, ["mail.read", "mail.modify", "mail.send"]);
		expect(await subjects(ben, ada.id)).toEqual(["Contract"]);

		const lines = await auditLines(async () => {
			expect(await ada.call("mail.remove_delegate", { principal_id: ben.id })).toEqual({ delegates: [] });
			// A second call changes nothing and writes no line.
			expect(await ada.call("mail.remove_delegate", { principal_id: ben.id })).toEqual({ delegates: [] });
		});
		expect(lines.filter((line) => line.op === "mail.remove_delegate")).toEqual([
			expect.objectContaining({ actor: ada.id, target: ben.id, result: "ok" }),
		]);
		expect(await codeOf(ben.call("mail.list_threads", { mailbox_id: ada.id }))).toBe("forbidden");
		expect(await codeOf(ben.call("mail.send", { mailbox_id: ada.id, to: ["owner@dock.test"], text: "Hi" }))).toBe(
			"forbidden",
		);
		expect((await ben.call("mail.list_mailboxes")).mailboxes.map((mailbox) => mailbox.kind)).toEqual(["personal"]);
	});

	it("stops the access while the owner of the mailbox is archived, and removes each grant of a deleted principal", async () => {
		await grant(ben, ["mail.read"]);
		await grant(ada, ["mail.read"], ben);
		await grant(bot, ["mail.read"], ben);

		await owner.call("directory.archive_principal", { principal_id: ben.id });
		expect(await codeOf(ada.call("mail.list_threads", { mailbox_id: ben.id }))).toBe("forbidden");
		expect((await ada.call("mail.list_mailboxes")).mailboxes.map((mailbox) => mailbox.kind)).toEqual(["personal"]);
		await owner.call("directory.restore_principal", { principal_id: ben.id });
		expect(await subjects(ada, ben.id)).toEqual([]);

		await owner.call("directory.archive_principal", { principal_id: ben.id });
		await owner.call("directory.delete_principal", { principal_id: ben.id });
		// The grant that the deleted person got, and the grants that the person gave.
		expect(await ada.call("mail.list_delegates")).toEqual({ delegates: [] });
		const rows = await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM mailbox_delegates").first<number>("n");
		expect(rows).toBe(0);
		expect(await codeOf(ada.call("mail.list_threads", { mailbox_id: ben.id }))).toBe("forbidden");
	});

	it("lets a delegate choose the mailbox as the default From, with mail.read to write and mail.send to send", async () => {
		const setFrom = (mailboxId: string, fromId: string | null) =>
			ben.call("mail.update_settings", { default_from: { mailbox_id: mailboxId, from_mailbox_id: fromId } });
		// No grant: the mailbox of a different person is not a mailbox where the person writes.
		expect(await codeOf(setFrom(ben.id, ada.id))).toBe("invalid");

		await grant(ben, ["mail.read"]);
		expect((await setFrom(ada.id, ben.id)).default_from).toEqual({ [ada.id]: ben.id });
		expect(await codeOf(setFrom(ben.id, ada.id))).toBe("forbidden");

		await grant(ben, ["mail.read", "mail.send"]);
		expect((await setFrom(ben.id, ada.id)).default_from).toEqual({ [ada.id]: ben.id, [ben.id]: ada.id });
		// A removal needs no grant, so the person can remove a setting after the access ended.
		await ada.call("mail.remove_delegate", { principal_id: ben.id });
		expect((await setFrom(ben.id, null)).default_from).toEqual({ [ada.id]: ben.id });
	});
});

describe("an agent as a delegate", () => {
	it("uses the mailbox with the grant alone, through REST and MCP", async () => {
		await mailForAda();
		// An account from before migration 0033 can have no mail scope. The grant decides in the mailbox of the
		// person, and the account scopes still decide in the own mailbox of the agent.
		await setLegacyScopes(bot.id, ["account.read", "directory.read"]);
		await grant(bot, ["mail.read"]);

		expect(await subjects(bot, ada.id)).toEqual(["Contract"]);
		const listed = await callTool(bot.key, "mail_list_threads", { mailbox_id: ada.id });
		expect(listed.isError).toBeFalsy();
		expect(await codeOf(bot.call("mail.list_threads"))).toBe("forbidden");
		// A grant in one mailbox opens no other mailbox.
		expect(await codeOf(bot.call("mail.list_threads", { mailbox_id: ben.id }))).toBe("forbidden");
		expect(await codeOf(bot.call("mail.send", { mailbox_id: ada.id, to: ["owner@dock.test"], text: "Hi" }))).toBe(
			"forbidden",
		);
	});

	// The mailbox of a person must never widen what an agent can reach.
	it("keeps its outbound policy for the mail that it sends from the address of the person", async () => {
		await grant(bot, ["mail.read", "mail.send"]);
		const send = (to: string) => bot.call("mail.send", { mailbox_id: ada.id, to: [to], text: "From the bot" });
		expect(await codeOf(send("cy@customer.example"))).toBe("policy_denied");
		const sent = await send("owner@dock.test");
		const [copy] = (await ada.call("mail.get_thread", { thread_id: sent.thread_id })).messages;
		expect(copy?.sent_by).toEqual({ principal_id: bot.id, kind: "agent", display_name: "Billing Bot" });
	});

	it("shows the grant in the access of the agent, and keeps a grant between two people private", async () => {
		await grant(bot, ["mail.read", "mail.send"]);
		await grant(ben, ["mail.read"]);
		const access = await ada.call("directory.get_agent_access", { principal_id: bot.id });
		expect(access.delegated_mailboxes).toEqual([
			{ id: ada.id, display_name: "Ada Lovelace", address: "ada@dock.test", scopes: ["mail.read", "mail.send"] },
		]);
		expect((await owner.call("directory.get_member_access", { principal_id: ben.id })).delegated_mailboxes).toEqual([]);
	});
});

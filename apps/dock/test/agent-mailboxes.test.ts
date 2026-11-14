import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, api, callTool, codeOf, createActor, inject, PASSWORD, rawMessage, seedOrg } from "./helpers.ts";

// Owners and admins can read the own mailbox of an agent. They cannot change it or send from it, and
// nobody else can open it. The mailbox of a person stays private, also for the owner.

let owner: Actor;
let admin: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
	admin = await createActor(owner, {
		kind: "human",
		display_name: "Grace Admin",
		address: "grace@dock.test",
		org_role: "admin",
		password: PASSWORD,
	});
});

/** Puts one external message with an attachment in the inbox of the bot, and returns its thread id. */
async function mailForBot(): Promise<string> {
	await inject(
		rawMessage({
			from: "Cy <cy@customer.example>",
			to: "bot@dock.test",
			subject: "Invoice 7",
			attachment: { filename: "invoice.txt", mimeType: "text/plain", content: "Total: 12" },
		}),
		"bot@dock.test",
	);
	const [thread] = (await bot.call("mail.list_threads")).threads;
	return thread?.id as string;
}

/** The error code in the result of an MCP tool call that failed. */
function toolCode(result: Awaited<ReturnType<typeof callTool>>): string | undefined {
	expect(result.isError).toBe(true);
	return (JSON.parse(result.content[0]?.text ?? "{}") as { code?: string }).code;
}

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

describe("the mailbox of an agent", () => {
	it("lists each agent mailbox for owners and admins, and for nobody else", async () => {
		const agentMailbox = { id: bot.id, kind: "agent", address: "bot@dock.test", display_name: "Billing Bot" };
		for (const reader of [owner, admin]) {
			const { mailboxes } = await reader.call("mail.list_mailboxes");
			expect(mailboxes).toEqual([
				{ id: reader.id, kind: "personal", address: reader.address, display_name: expect.any(String) },
				agentMailbox,
			]);
		}
		// Ada sponsors the bot, but she is a member, not an admin. The bot is an agent.
		for (const other of [ada, bot]) {
			expect((await other.call("mail.list_mailboxes")).mailboxes.map((m) => m.kind)).toEqual(["personal"]);
		}
	});

	it("lets an owner and an admin read it, through REST and MCP, and audits each read of mail", async () => {
		const threadId = await mailForBot();
		for (const reader of [owner, admin]) {
			const inBox = { mailbox_id: bot.id };
			expect(await reader.call("mail.get_profile", inBox)).toMatchObject({
				mailbox_id: bot.id,
				kind: "agent",
				address: "bot@dock.test",
				display_name: "Billing Bot",
				inbox_unread: 1,
			});
			const { threads } = await reader.call("mail.list_threads", inBox);
			expect(threads.map((thread) => [thread.subject, thread.untrusted])).toEqual([["Invoice 7", true]]);
			const thread = await reader.call("mail.get_thread", { ...inBox, thread_id: threadId });
			const message = thread.messages[0];
			expect(message).toMatchObject({ subject: "Invoice 7", origin: "external", untrusted: true });
			expect(await reader.call("mail.get_message", { ...inBox, message_id: message?.id as string })).toEqual(message);
			const attachment = await reader.call("mail.get_attachment", {
				...inBox,
				message_id: message?.id as string,
				index: 0,
			});
			expect(attachment).toMatchObject({ filename: "invoice.txt", untrusted: true });
			expect((await reader.call("mail.list_labels", inBox)).labels.find((l) => l.id === "INBOX")).toMatchObject({
				threads_unread: 1,
			});
			// Parity: the MCP tool returns the same threads as the REST route.
			const tool = await callTool(reader.key, "mail_list_threads", inBox);
			expect(tool.structuredContent).toEqual({ threads, next_cursor: null });
		}

		// Each read of mail content writes one line. The profile and the labels, which the web app polls, write none.
		const [message] = (await admin.call("mail.get_thread", { mailbox_id: bot.id, thread_id: threadId })).messages;
		const messageId = message?.id as string;
		const readAll = (reader: Actor, inBox: { mailbox_id?: string }) => async () => {
			await reader.call("mail.get_profile", inBox);
			await reader.call("mail.list_labels", inBox);
			await reader.call("mail.list_threads", { ...inBox, query: "invoice" });
			await reader.call("mail.get_thread", { ...inBox, thread_id: threadId });
			await reader.call("mail.get_message", { ...inBox, message_id: messageId });
			await reader.call("mail.get_attachment", { ...inBox, message_id: messageId, index: 0 });
		};
		const lines = await auditLines(readAll(admin, { mailbox_id: bot.id }));
		expect(lines.map(({ op, actor, mailbox, target }) => ({ op, actor, mailbox, target }))).toEqual([
			{ op: "mail.list_threads", actor: admin.id, mailbox: bot.id, target: bot.id },
			{ op: "mail.get_thread", actor: admin.id, mailbox: bot.id, target: threadId },
			{ op: "mail.get_message", actor: admin.id, mailbox: bot.id, target: messageId },
			{ op: "mail.get_attachment", actor: admin.id, mailbox: bot.id, target: `${messageId}/0` },
		]);
		// The agent reads its own mail without an audit line.
		expect(await auditLines(readAll(bot, {}))).toEqual([]);
	});

	// A change by a reader would change what the agent sees, and a send would come from the agent.
	it("refuses each change and each send, also for the owner, and changes nothing", async () => {
		const threadId = await mailForBot();
		const inBox = { mailbox_id: bot.id };
		const { labels } = await bot.call("mail.list_labels");
		const botLabel = await bot.call("mail.create_label", { name: "Billing" });
		for (const reader of [owner, admin]) {
			// Each attempt starts only when the loop awaits it, so no refusal is left without a handler.
			const attempts = [
				() => reader.call("mail.modify_threads", { ...inBox, thread_ids: [threadId], remove_label_ids: ["UNREAD"] }),
				() =>
					reader.call("mail.modify_threads", {
						...inBox,
						thread_ids: [threadId],
						add_label_ids: ["TRASH"],
						dry_run: true,
					}),
				() => reader.call("mail.create_label", { ...inBox, name: "Reviewed" }),
				() => reader.call("mail.delete_label", { ...inBox, label_id: botLabel.id }),
				() => reader.call("mail.send", { ...inBox, to: ["ada@dock.test"], text: "As the bot" }),
			];
			for (const attempt of attempts) expect(await codeOf(attempt())).toBe("forbidden");
			const tool = await callTool(reader.key, "mail_send", { ...inBox, to: ["ada@dock.test"], text: "As the bot" });
			expect(toolCode(tool)).toBe("forbidden");
		}
		const thread = await bot.call("mail.get_thread", { thread_id: threadId });
		expect(thread.label_ids.sort()).toEqual(["INBOX", "UNREAD"]);
		expect((await bot.call("mail.list_labels")).labels.map((l) => l.id).sort()).toEqual(
			[...labels.map((l) => l.id), botLabel.id].sort(),
		);
		expect((await bot.call("mail.list_threads", { query: "in:sent" })).threads).toEqual([]);
		expect((await ada.call("mail.list_threads")).threads).toEqual([]);
	});

	it("stays closed to the sponsor, to members and to other agents", async () => {
		await mailForBot();
		const otherBot = await createActor(owner, {
			kind: "agent",
			display_name: "Other Bot",
			address: "other-bot@dock.test",
			sponsor_id: ada.id,
		});
		expect(await codeOf(ada.call("mail.list_threads", { mailbox_id: bot.id }))).toBe("forbidden");
		expect(await codeOf(ada.call("mail.get_profile", { mailbox_id: bot.id }))).toBe("forbidden");
		expect(await codeOf(otherBot.call("mail.list_threads", { mailbox_id: bot.id }))).toBe("forbidden");
		const tool = await callTool(otherBot.key, "mail_list_threads", { mailbox_id: bot.id });
		expect(toolCode(tool)).toBe("forbidden");
	});

	// The access comes from the role of the person, so each of their credentials with mail.read has it.
	// The mail.read scope text says so. A key without mail.read gets nothing.
	it("follows the role of the person on a narrow key, within the scopes of the key", async () => {
		const threadId = await mailForBot();
		const keyWith = async (scopes: ("mail.read" | "directory.read")[]) =>
			api((await admin.call("account.create_api_key", { label: "Narrow", scopes })).api_key.secret);
		const reader = await keyWith(["mail.read"]);
		expect((await reader("mail.list_mailboxes")).mailboxes.map((m) => m.kind)).toEqual(["personal", "agent"]);
		expect((await reader("mail.get_thread", { mailbox_id: bot.id, thread_id: threadId })).subject).toBe("Invoice 7");
		const noMail = await keyWith(["directory.read"]);
		expect(await codeOf(noMail("mail.list_threads", { mailbox_id: bot.id }))).toBe("forbidden");
	});
});

describe("the mailbox of a person", () => {
	it("stays private for owners and admins", async () => {
		expect(await codeOf(owner.call("mail.list_threads", { mailbox_id: ada.id }))).toBe("forbidden");
		expect(await codeOf(admin.call("mail.get_profile", { mailbox_id: owner.id }))).toBe("forbidden");
		expect(await codeOf(owner.call("mail.list_threads", { mailbox_id: "prn_00000000000000000000000000" }))).toBe(
			"not_found",
		);
	});
});

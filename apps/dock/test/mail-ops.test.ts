import { ApiError } from "@soldock/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, inject, rawMessage, seedOrg } from "./helpers.ts";

let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ ada, bot } = await seedOrg());
});

type Incoming = Partial<Parameters<typeof rawMessage>[0]> & { subject: string };

async function deliver(input: Incoming, receivedAt: Date | undefined = input.date) {
	await inject(
		rawMessage({ from: "bob@sender.example", to: "ada@dock.test", ...input }),
		"ada@dock.test",
		receivedAt ? { receivedAt } : {},
	);
}

async function receive(input: Incoming, receivedAt: Date | undefined = input.date) {
	await deliver(input, receivedAt);
	const { threads } = await ada.call("mail.list_threads", { query: "in:anywhere" });
	const thread = threads.find((t) => t.subject === input.subject);
	if (!thread) throw new Error(`thread ${input.subject} not found`);
	return thread;
}

async function code(promise: Promise<unknown>): Promise<string> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ApiError);
	return (error as ApiError).code;
}

const subjects = async (query: string) =>
	(await ada.call("mail.list_threads", { query })).threads.map((t) => t.subject).sort();

describe("mail.list_threads", () => {
	it("lists the inbox newest first and pages with next_cursor", async () => {
		for (let i = 0; i < 5; i++) {
			await receive({ subject: `Message ${i}`, date: new Date(Date.UTC(2026, 9, 1 + i)) });
		}
		const first = await ada.call("mail.list_threads", { limit: 2 });
		const second = await ada.call("mail.list_threads", { limit: 2, cursor: first.next_cursor as string });
		const third = await ada.call("mail.list_threads", { limit: 2, cursor: second.next_cursor as string });
		const seen = [...first.threads, ...second.threads, ...third.threads].map((t) => t.subject);
		expect(seen).toEqual(["Message 4", "Message 3", "Message 2", "Message 1", "Message 0"]);
		expect(third.next_cursor).toBeNull();
		expect(await code(ada.call("mail.list_threads", { cursor: "not-a-cursor" }))).toBe("invalid");
	});

	// A golden table over one seeded mailbox. Each row is a Gmail operator and the threads that it must find.
	it("answers Gmail-style queries", async () => {
		const old = new Date(Date.now() - 400 * 86_400_000);
		await receive({ subject: "Invoice 1042", from: "Billing <billing@vendor.example>", text: "Total due: 100 EUR" });
		await receive({
			subject: "Quarterly report",
			from: "carol@partner.example",
			text: "The numbers look good.",
			attachment: { filename: "q3-report.pdf", mimeType: "application/pdf", content: "x".repeat(3000) },
		});
		await receive({ subject: "Old newsletter", from: "news@list.example", date: old, text: "unsubscribe" });
		const lunch = await receive({ subject: "Lunch plans", from: "dan@friends.example", text: "Pizza or ramen?" });
		// Mail to ada+news@ reaches ada@, so to:me finds it too.
		await receive({ subject: "Tagged copy", to: "ada+news@dock.test" });
		const label = await ada.call("mail.create_label", { name: "Food & Fun" });
		await ada.call("mail.modify_threads", {
			thread_ids: [lunch.id],
			add_label_ids: [label.id, "STARRED"],
			remove_label_ids: ["UNREAD"],
		});

		const table: [string, string[]][] = [
			["from:billing@vendor.example", ["Invoice 1042"]],
			["from:Billing", ["Invoice 1042"]],
			["from:vendor.example OR from:partner.example", ["Invoice 1042", "Quarterly report"]],
			["subject:report", ["Quarterly report"]],
			["ramen", ["Lunch plans"]],
			['"numbers look"', ["Quarterly report"]],
			["has:attachment", ["Quarterly report"]],
			["filename:pdf", ["Quarterly report"]],
			["larger:2K", ["Quarterly report"]],
			["is:starred", ["Lunch plans"]],
			["is:unread", ["Invoice 1042", "Old newsletter", "Quarterly report", "Tagged copy"]],
			["is:read", ["Lunch plans"]],
			['label:"food & fun"', ["Lunch plans"]],
			["label:food-&-fun", ["Lunch plans"]],
			["older_than:1y", ["Old newsletter"]],
			["newer_than:30d -from:dan", ["Invoice 1042", "Quarterly report", "Tagged copy"]],
			["to:me", ["Invoice 1042", "Lunch plans", "Old newsletter", "Quarterly report", "Tagged copy"]],
			["in:sent", []],
			// A NUL is not a term: the query is empty, so it lists all mail (it was a 500 before).
			["\u0000", ["Invoice 1042", "Lunch plans", "Old newsletter", "Quarterly report", "Tagged copy"]],
		];
		for (const [query, expected] of table) expect(await subjects(query), query).toEqual(expected);
	});
});

describe("mail.get_thread", () => {
	it("returns external mail as untrusted, with sanitized HTML and blocked remote images, and does not mark it read", async () => {
		const thread = await receive({
			subject: "Newsletter",
			html: '<p onclick="steal()">Hi</p><script>alert(1)</script><img src="https://tracker.example/p.gif">',
		});
		const full = await ada.call("mail.get_thread", { thread_id: thread.id });
		const [message] = full.messages;
		expect(full.untrusted).toBe(true);
		expect(message).toMatchObject({ origin: "external", untrusted: true, from: { address: "bob@sender.example" } });
		expect(message?.body.html).toContain("<p>Hi</p>");
		expect(message?.body.html).not.toMatch(/script|onclick|tracker/);
		expect(message?.body.remote_images_blocked).toBe(1);
		expect(message?.label_ids).toContain("UNREAD");
	});

	// Each principal has its own mailbox object, so an id from another mailbox finds nothing.
	it("never returns a thread from another principal's mailbox", async () => {
		const thread = await receive({ subject: "Private" });
		expect(await code(bot.call("mail.get_thread", { thread_id: thread.id }))).toBe("not_found");
		expect((await bot.call("mail.list_threads", { query: "in:anywhere" })).threads).toEqual([]);
	});
});

describe("mail.modify_threads", () => {
	it("archives, stars, reads, trashes and restores, and the label counts follow", async () => {
		const thread = await receive({ subject: "Keep me" });
		const counts = async () => {
			const { labels } = await ada.call("mail.list_labels");
			const of = (id: string) => labels.find((l) => l.id === id);
			return {
				inbox: of("INBOX")?.threads_unread,
				trash: of("TRASH")?.threads_total,
				starred: of("STARRED")?.threads_total,
			};
		};
		expect(await counts()).toEqual({ inbox: 1, trash: 0, starred: 0 });
		const modify = (add: string[], remove: string[]) =>
			ada.call("mail.modify_threads", { thread_ids: [thread.id], add_label_ids: add, remove_label_ids: remove });
		await modify(["STARRED"], ["UNREAD"]);
		expect(await counts()).toEqual({ inbox: 0, trash: 0, starred: 1 });
		await modify(["TRASH"], []);
		expect(await subjects("in:inbox")).toEqual([]);
		expect(await subjects("in:trash")).toEqual(["Keep me"]);
		expect(await counts()).toEqual({ inbox: 0, trash: 1, starred: 0 });
		await modify([], ["TRASH", "INBOX"]);
		expect(await subjects("in:inbox")).toEqual([]);
		expect(await subjects("")).toEqual(["Keep me"]);
	});

	it("changes nothing on a dry run, and nothing at all when one id is unknown", async () => {
		const a = await receive({ subject: "A" });
		const before = (await ada.call("mail.get_profile")).version;
		const dry = await ada.call("mail.modify_threads", { thread_ids: [a.id], add_label_ids: ["TRASH"], dry_run: true });
		expect(dry).toEqual({ threads_changed: 1, messages_changed: 1, dry_run: true });
		expect((await ada.call("mail.get_profile")).version).toBe(before);
		const missing = "thr_01JD0000000000000000000000";
		expect(await code(ada.call("mail.modify_threads", { thread_ids: [a.id, missing], add_label_ids: ["TRASH"] }))).toBe(
			"not_found",
		);
		expect(
			await code(
				ada.call("mail.modify_threads", { thread_ids: [a.id], add_label_ids: ["lbl_01JD0000000000000000000000"] }),
			),
		).toBe("not_found");
		expect(await subjects("in:trash")).toEqual([]);
	});
});

describe("hostile and large threads", () => {
	// One message that the HTML parser refuses must not hide the rest of its thread.
	it("keeps a thread readable when one message's HTML cannot be sanitized", async () => {
		await receive({ subject: "Plan", messageId: "<plan-1@sender.example>", text: "First message" });
		await deliver({
			subject: "Re: Plan",
			inReplyTo: "<plan-1@sender.example>",
			text: "",
			html: "<select><style>x</style></select><p>Hostile but readable</p>",
		});
		const [thread] = (await ada.call("mail.list_threads")).threads;
		const full = await ada.call("mail.get_thread", { thread_id: thread?.id as string });
		expect(full.messages).toHaveLength(2);
		expect(full.messages[0]?.body.text).toContain("First message");
		expect(full.messages[1]?.body.html).toBeNull();
		expect(full.messages[1]?.body.text).toContain("Hostile but readable");
	});

	// A thread result travels over RPC, which allows 32 MiB. The newest bodies come first.
	it("leaves out the oldest bodies of a very large thread, and mail.get_message returns them", {
		timeout: 60_000,
	}, async () => {
		const big = `<p>${"x".repeat(1_000_000)}</p>`;
		let previous: string | undefined;
		for (let i = 0; i < 7; i++) {
			const id = `<big-${i}@sender.example>`;
			await deliver({
				subject: i === 0 ? "Huge" : "Re: Huge",
				messageId: id,
				...(previous ? { inReplyTo: previous } : {}),
				text: "",
				html: big,
			});
			previous = id;
		}
		const [thread] = (await ada.call("mail.list_threads")).threads;
		expect(thread?.message_count).toBe(7);
		const full = await ada.call("mail.get_thread", { thread_id: thread?.id as string });
		const omitted = full.messages.filter((m) => m.body.omitted);
		expect(omitted.length).toBeGreaterThan(0);
		expect(full.messages.at(-1)?.body.omitted).toBe(false);
		const one = await ada.call("mail.get_message", { message_id: omitted[0]?.id as string });
		expect(one.body.omitted).toBe(false);
		expect(one.body.html?.length).toBeGreaterThan(1_000_000);
		expect(await code(bot.call("mail.get_message", { message_id: omitted[0]?.id as string }))).toBe("not_found");
	});
});

describe("labels", () => {
	it("creates a label once by name in any case, and deleting it removes it from every message", async () => {
		const thread = await receive({ subject: "Tagged" });
		const label = await ada.call("mail.create_label", { name: "Clients/Acme" });
		expect(await code(ada.call("mail.create_label", { name: "clients/acme" }))).toBe("conflict");
		expect(await code(ada.call("mail.create_label", { name: "inbox" }))).toBe("conflict");
		// Case folding is not only for ASCII.
		const cafe = await ada.call("mail.create_label", { name: "Café" });
		expect(await code(ada.call("mail.create_label", { name: "CAFÉ" }))).toBe("conflict");
		await ada.call("mail.modify_threads", { thread_ids: [thread.id], add_label_ids: [cafe.id] });
		expect(await subjects("label:CAFÉ")).toEqual(["Tagged"]);
		await ada.call("mail.modify_threads", { thread_ids: [thread.id], add_label_ids: [label.id] });
		expect(await subjects("label:clients/acme")).toEqual(["Tagged"]);
		await ada.call("mail.delete_label", { label_id: label.id });
		const full = await ada.call("mail.get_thread", { thread_id: thread.id });
		expect(full.label_ids).not.toContain(label.id);
		expect(await code(ada.call("mail.delete_label", { label_id: label.id }))).toBe("not_found");
	});
});

describe("mail.get_attachment", () => {
	it("returns the attachment bytes, marked untrusted for external mail", async () => {
		const thread = await receive({
			subject: "File",
			attachment: { filename: "notes.txt", mimeType: "text/plain", content: "line one\nline two" },
		});
		const full = await ada.call("mail.get_thread", { thread_id: thread.id });
		const message = full.messages[0];
		expect(message?.attachments).toEqual([
			{ index: 0, filename: "notes.txt", mime_type: "text/plain", size: 17, inline: false },
		]);
		const attachment = await ada.call("mail.get_attachment", { message_id: message?.id as string, index: 0 });
		expect(attachment).toMatchObject({ filename: "notes.txt", mime_type: "text/plain", size: 17, untrusted: true });
		expect(atob(attachment.content_base64)).toBe("line one\nline two");
		expect(await code(ada.call("mail.get_attachment", { message_id: message?.id as string, index: 1 }))).toBe(
			"not_found",
		);
		expect(await code(bot.call("mail.get_attachment", { message_id: message?.id as string, index: 0 }))).toBe(
			"not_found",
		);
	});
});

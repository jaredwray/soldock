import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ApiError } from "@asterra/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, callTool, inject, rawMessage, seedOrg } from "./helpers.ts";

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

describe("Snooze", () => {
	const HOUR = 3_600_000;
	const mailbox = () => env.MAILBOX.get(env.MAILBOX.idFromName(ada.id));
	const snoozedLabel = async () => (await ada.call("mail.list_labels")).labels.find((label) => label.id === "SNOOZED");
	/** The subjects of the inbox in the order of the list. */
	const inbox = async () => (await ada.call("mail.list_threads")).threads.map((thread) => thread.subject);

	afterEach(() => {
		vi.useRealTimers();
	});

	it("takes a thread out of the inbox until its time, then puts it at the top of the inbox", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const now = Date.now();
		const old = await receive({ subject: "Old" }, new Date(now - 48 * HOUR));
		await receive({ subject: "Newer" }, new Date(now - 24 * HOUR));
		expect(await snoozedLabel()).toEqual({
			id: "SNOOZED",
			name: "SNOOZED",
			type: "system",
			threads_total: 0,
			threads_unread: 0,
		});
		expect(old.snoozed_until).toBeNull();

		const first = new Date(now + 3 * HOUR).toISOString();
		expect(await ada.call("mail.snooze_threads", { thread_ids: [old.id], until: first })).toEqual({
			threads_changed: 1,
			until: first,
		});
		expect(await inbox()).toEqual(["Newer"]);
		expect(await snoozedLabel()).toMatchObject({ threads_total: 1 });
		// A second call changes the time. The MCP tool is the same operation.
		const until = new Date(now + HOUR).toISOString();
		const changed = await callTool(ada.key, "mail_snooze_threads", { thread_ids: [old.id], until });
		expect(changed.structuredContent).toEqual({ threads_changed: 1, until });
		const [waiting] = (await ada.call("mail.list_threads", { query: "in:snoozed" })).threads;
		expect(waiting).toMatchObject({ id: old.id, snoozed_until: until });
		expect((await ada.call("mail.get_thread", { thread_id: old.id })).snoozed_until).toBe(until);
		// The alarm has the earlier time, or the thread comes back 2 hours late.
		expect(await runInDurableObject(mailbox(), (_instance, state) => state.storage.getAlarm())).toBe(now + HOUR);

		// Before the time, the alarm changes nothing.
		vi.setSystemTime(now + HOUR - 1);
		await runDurableObjectAlarm(mailbox());
		expect(await inbox()).toEqual(["Newer"]);

		vi.setSystemTime(now + HOUR);
		await runDurableObjectAlarm(mailbox());
		expect(await inbox()).toEqual(["Old", "Newer"]);
		const [back] = (await ada.call("mail.list_threads")).threads;
		expect(back).toMatchObject({ id: old.id, snoozed_until: null, last_message_at: until });
		expect(back?.label_ids).not.toContain("SNOOZED");
		expect(await subjects("in:snoozed")).toEqual([]);
		expect(await snoozedLabel()).toMatchObject({ threads_total: 0 });
		// The cursor of a page uses the same order, so the next page starts after the thread that came back.
		const pageOne = await ada.call("mail.list_threads", { limit: 1 });
		const pageTwo = await ada.call("mail.list_threads", { limit: 1, cursor: pageOne.next_cursor as string });
		expect([...pageOne.threads, ...pageTwo.threads].map((thread) => thread.subject)).toEqual(["Old", "Newer"]);
		expect(pageTwo.next_cursor).toBeNull();

		// A new snooze removes that place: the thread has the time of its newest message again.
		await ada.call("mail.snooze_threads", { thread_ids: [old.id], until: new Date(now + 5 * HOUR).toISOString() });
		const [again] = (await ada.call("mail.list_threads", { query: "in:snoozed" })).threads;
		expect(again?.last_message_at).toBe(new Date(now - 48 * HOUR).toISOString());
	});

	// snoozeThreads sets the alarm after its transaction. A stop between the two must not lose the snooze.
	it("sets the alarm again when the mailbox starts with a snoozed thread and no alarm", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const now = Date.now();
		const thread = await receive({ subject: "Wait" });
		const until = new Date(now + HOUR).toISOString();
		await ada.call("mail.snooze_threads", { thread_ids: [thread.id], until });
		await runInDurableObject(mailbox(), (_instance, state) => state.storage.deleteAlarm());
		await evictDurableObject(mailbox());

		// The first call starts the object. Its alarm runs now, finds no work, and sets itself to the time.
		expect(await subjects("in:snoozed")).toEqual(["Wait"]);
		await runDurableObjectAlarm(mailbox());
		expect(await runInDurableObject(mailbox(), (_instance, state) => state.storage.getAlarm())).toBe(now + HOUR);
		vi.setSystemTime(now + HOUR);
		await runDurableObjectAlarm(mailbox());
		expect(await subjects("in:inbox")).toEqual(["Wait"]);
	});

	it("ends a snooze for new mail in the thread and for a removed label, and keeps it after a reply", async () => {
		const until = new Date(Date.now() + HOUR).toISOString();
		const question = await receive({ subject: "Question", messageId: "<q1@sender.example>" });
		const other = await receive({ subject: "Other" });
		await ada.call("mail.snooze_threads", { thread_ids: [question.id, other.id], until });
		expect(await subjects("in:inbox")).toEqual([]);

		// A reply of the mailbox does not end the snooze: the time decides.
		const [message] = (await ada.call("mail.get_thread", { thread_id: question.id })).messages;
		await ada.call("mail.send", {
			to: ["bot@dock.test"],
			text: "I answer next week.",
			reply_to_message_id: message?.id as string,
		});
		expect(await subjects("in:snoozed")).toEqual(["Other", "Question"]);

		// New mail in the thread goes to the inbox, so the thread is not snoozed after it.
		await deliver({ subject: "Re: Question", inReplyTo: "<q1@sender.example>" });
		expect(await subjects("in:inbox")).toEqual(["Question"]);
		expect(await subjects("in:snoozed")).toEqual(["Other"]);
		expect((await ada.call("mail.get_thread", { thread_id: question.id })).snoozed_until).toBeNull();

		// A person ends the snooze of the other thread: the label and the time go together.
		await ada.call("mail.modify_threads", {
			thread_ids: [other.id],
			add_label_ids: ["INBOX"],
			remove_label_ids: ["SNOOZED"],
		});
		expect(await subjects("in:inbox")).toEqual(["Other", "Question"]);
		expect((await ada.call("mail.get_thread", { thread_id: other.id })).snoozed_until).toBeNull();

		// A message that the mailbox sends to itself is new mail in its inbox too.
		await ada.call("mail.snooze_threads", { thread_ids: [other.id], until });
		const [received] = (await ada.call("mail.get_thread", { thread_id: other.id })).messages;
		await ada.call("mail.send", {
			to: ["ada@dock.test"],
			text: "A note to me.",
			reply_to_message_id: received?.id as string,
		});
		expect(await subjects("in:snoozed")).toEqual([]);
		expect(await subjects("in:inbox")).toEqual(["Other", "Question"]);
	});

	// A new message can link two threads, and they merge into the older one. The snooze of the newer thread
	// must go with its messages, or they keep SNOOZED with no time and never come back.
	it("ends the snooze of a thread that merges into a different thread with new mail", async () => {
		await receive({ subject: "Plan", messageId: "<plan@sender.example>" });
		const budget = await receive({ subject: "Budget", messageId: "<budget@sender.example>" });
		await ada.call("mail.snooze_threads", {
			thread_ids: [budget.id],
			until: new Date(Date.now() + HOUR).toISOString(),
		});
		expect(await subjects("in:snoozed")).toEqual(["Budget"]);

		await deliver({ subject: "Plan and budget", references: ["<plan@sender.example>", "<budget@sender.example>"] });
		const { threads } = await ada.call("mail.list_threads", { query: "in:anywhere" });
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({ message_count: 3, snoozed_until: null });
		expect(threads[0]?.label_ids).not.toContain("SNOOZED");
		expect(await subjects("in:snoozed")).toEqual([]);
	});

	it("refuses a time that is not later than now, an unknown thread, and SNOOZED through mail.modify_threads", async () => {
		const thread = await receive({ subject: "Stay" });
		const until = new Date(Date.now() + HOUR).toISOString();
		const past = new Date(Date.now() - 1000).toISOString();
		expect(await code(ada.call("mail.snooze_threads", { thread_ids: [thread.id], until: past }))).toBe("invalid");
		const missing = "thr_01JD0000000000000000000000";
		expect(await code(ada.call("mail.snooze_threads", { thread_ids: [thread.id, missing], until }))).toBe("not_found");
		// A snooze needs a time, so the label alone is refused.
		expect(await code(ada.call("mail.modify_threads", { thread_ids: [thread.id], add_label_ids: ["SNOOZED"] }))).toBe(
			"invalid",
		);
		expect(await subjects("in:inbox")).toEqual(["Stay"]);
		expect(await subjects("in:snoozed")).toEqual([]);
	});

	/** Puts the database of the mailbox back to the schema before Snooze (migration 8). */
	function beforeSnooze(sql: SqlStorage) {
		sql.exec("DROP INDEX threads_snoozed");
		sql.exec("ALTER TABLE threads DROP COLUMN snoozed_until");
		sql.exec("ALTER TABLE threads DROP COLUMN woke_at");
		sql.exec("DELETE FROM labels WHERE id = 'SNOOZED'");
		sql.exec(
			"INSERT INTO labels (id, name, name_folded, type, created_at) VALUES ('REPLY_LATER', 'REPLY_LATER', 'reply_later', 'system', 0)",
		);
		sql.exec("UPDATE meta SET value = '7' WHERE key = 'schema_version'");
	}

	// A thread of Reply later has no time. It must not stay out of the views when its label goes away, and the
	// person must see it: it comes back at the top of the inbox, not at the place of its old mail.
	it("puts the threads of Reply later back at the top of the inbox when the mailbox gets Snooze", async () => {
		const thread = await receive({ subject: "Answer me" }, new Date(Date.now() - 48 * HOUR));
		await receive({ subject: "Newer" }, new Date(Date.now() - 24 * HOUR));
		const before = (await ada.call("mail.get_profile")).version;
		await runInDurableObject(mailbox(), (_instance, state) => {
			const sql = state.storage.sql;
			beforeSnooze(sql);
			sql.exec(
				"UPDATE message_labels SET label_id = 'REPLY_LATER' WHERE label_id = 'INBOX' AND message_seq IN (SELECT seq FROM messages WHERE thread_id = ?)",
				thread.id,
			);
		});
		await evictDurableObject(mailbox());

		expect(await inbox()).toEqual(["Answer me", "Newer"]);
		// An open client compares the version, so it gets the lists again.
		expect((await ada.call("mail.get_profile")).version).toBeGreaterThan(before);
		const { labels } = await ada.call("mail.list_labels");
		expect(labels.some((label) => label.id === "REPLY_LATER")).toBe(false);
		expect(labels.find((label) => label.id === "SNOOZED")).toMatchObject({ type: "system", threads_total: 0 });
	});

	// A mailbox from before Reply later and Snooze can have user labels with those names. Label names are
	// unique, so each migration renames the user label. It keeps its id and its threads. The new name must be
	// free too: a person could make the label "Reply_Later (1)", and a clash would stop the mailbox from starting.
	it("renames the user labels named reply_later and snoozed to free names when the mailbox gets the system labels", async () => {
		const thread = await receive({ subject: "Old label" });
		const userLabel = "lbl_01JD0000000000000000000RL0";
		const snoozeLabel = "lbl_01JD0000000000000000000SN0";
		await runInDurableObject(mailbox(), (_instance, state) => {
			// Back to schema 6: before the system label REPLY_LATER (migration 7).
			const sql = state.storage.sql;
			beforeSnooze(sql);
			sql.exec("DELETE FROM labels WHERE id = 'REPLY_LATER'");
			sql.exec(
				"INSERT INTO labels (id, name, name_folded, type, created_at) VALUES (?, 'Reply_Later', 'reply_later', 'user', 1)",
				userLabel,
			);
			sql.exec(
				"INSERT INTO labels (id, name, name_folded, type, created_at) VALUES ('lbl_01JD0000000000000000000RL1', 'REPLY_LATER (1)', 'reply_later (1)', 'user', 1)",
			);
			sql.exec(
				"INSERT INTO labels (id, name, name_folded, type, created_at) VALUES (?, 'Snoozed', 'snoozed', 'user', 1)",
				snoozeLabel,
			);
			sql.exec(
				"INSERT INTO message_labels (message_seq, label_id) SELECT seq, ? FROM messages WHERE thread_id = ?",
				userLabel,
				thread.id,
			);
			sql.exec("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
		});
		await evictDurableObject(mailbox());

		const { labels } = await ada.call("mail.list_labels");
		const renamed = "Reply_Later (2)";
		expect(labels.find((label) => label.id === userLabel)).toMatchObject({ name: renamed, threads_total: 1 });
		expect(labels.find((label) => label.id === snoozeLabel)).toMatchObject({ name: "Snoozed (1)" });
		expect(labels.find((label) => label.id === "SNOOZED")).toMatchObject({ type: "system", threads_total: 0 });
		expect(await subjects(`label:"${renamed}"`)).toEqual(["Old label"]);
		expect(await code(ada.call("mail.create_label", { name: "snoozed" }))).toBe("conflict");
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

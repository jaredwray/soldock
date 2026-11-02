import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { consume, inject, rawMessage, seedOrg } from "./helpers.ts";

const handlers = worker as Required<Pick<ExportedHandler<Env>, "email">>;

async function inbox(call: Awaited<ReturnType<typeof seedOrg>>["ada"]["call"], query = "in:inbox") {
	return (await call("mail.list_threads", { query })).threads;
}

describe("the email() handler", () => {
	it("accepts mail for an address in any case and with a +tag, and delivers it unread to the inbox", async () => {
		const { ada } = await seedOrg();
		const { rejected } = await inject(
			rawMessage({ from: "Bob <bob@sender.example>", to: "Ada+news@DOCK.test", subject: "Hi" }),
			"Ada+news@DOCK.test",
		);
		expect(rejected).toBeNull();
		const threads = await inbox(ada.call);
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({
			subject: "Hi",
			unread: true,
			untrusted: true,
			participants: [{ name: "Bob", address: "bob@sender.example" }],
		});
		expect(threads[0]?.label_ids.sort()).toEqual(["INBOX", "UNREAD"]);
	});

	it("rejects an unknown recipient during the SMTP session, and stores nothing", async () => {
		await seedOrg();
		const before = await env.BLOBS.list({ prefix: "mail/raw/" });
		const { rejected, jobs } = await inject(
			rawMessage({ from: "a@x.example", to: "ghost@dock.test", subject: "?" }),
			"ghost@dock.test",
		);
		expect(rejected).toMatch(/^5\.1\.1 /);
		expect(jobs).toEqual([]);
		expect((await env.BLOBS.list({ prefix: "mail/raw/" })).objects.length).toBe(before.objects.length);
	});

	it("rejects a message over 25 MiB before it reads the body", async () => {
		await seedOrg();
		const setReject = vi.fn();
		const raw = new ReadableStream({
			pull() {
				throw new Error("the body must not be read");
			},
		});
		const message = { from: "a@x.example", to: "ada@dock.test", raw, rawSize: 26 * 1024 * 1024, setReject };
		await handlers.email(message as unknown as ForwardableEmailMessage, env, createExecutionContext());
		expect(setReject.mock.calls[0]?.[0]).toMatch(/^5\.3\.4 /);
	});
});

describe("the inbound queue consumer", () => {
	// Queues deliver at least once, and Email Routing retries a failed handler. Neither may duplicate mail.
	it("delivers a message once when the queue redelivers it or the sender retries", async () => {
		const { ada } = await seedOrg();
		const raw = rawMessage({ from: "bob@sender.example", to: "ada@dock.test", subject: "Once" });
		const { jobs } = await inject(raw, "ada@dock.test");
		// The duplicate is acknowledged, not retried into the dead-letter queue.
		const redelivered = await consume(jobs);
		expect(redelivered.explicitAcks).toHaveLength(1);
		expect(redelivered.retryMessages).toEqual([]);
		await inject(raw, "ada@dock.test");
		expect(await inbox(ada.call)).toHaveLength(1);
		expect((await ada.call("mail.get_profile")).messages_total).toBe(1);
	});

	it("sends a job that it cannot read to the dead-letter queue, and retries a delivery that fails", async () => {
		await seedOrg();
		const bad = await consume([{ v: 99 }]);
		expect(bad.explicitAcks).toHaveLength(1);
		const job = { v: 1, principalId: "prn_x", rawKey: "mail/raw/none", contentHash: "x", receivedAt: Date.now() };
		const missing = await consume([job]);
		expect(missing.retryMessages).toHaveLength(1);
		expect(missing.explicitAcks).toHaveLength(0);
		// The fifth failure goes to the dead-letter queue and stops the retries.
		const last = await consume([job], 5);
		expect(last.retryMessages).toEqual([]);
		expect(last.explicitAcks).toHaveLength(1);
	});

	// A DMARC failure that the receiving server recorded means the From domain did not send the mail.
	it("puts mail that fails DMARC at the receiving server in Spam, and shows the results", async () => {
		const { ada } = await seedOrg();
		await inject(
			rawMessage({
				from: "ceo@bank.example",
				to: "ada@dock.test",
				subject: "Urgent wire",
				headers: [
					["Authentication-Results", "mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail header.from=bank.example"],
				],
			}),
			"ada@dock.test",
		);
		expect(await inbox(ada.call)).toHaveLength(0);
		const [spam] = await inbox(ada.call, "in:spam");
		const thread = await ada.call("mail.get_thread", { thread_id: spam?.id as string });
		expect(thread.messages[0]?.authentication).toEqual({ spf: "fail", dkim: "none", dmarc: "fail" });
		expect(thread.messages[0]?.label_ids).toContain("SPAM");
	});
});

describe("threading", () => {
	it("joins a reply to its thread by In-Reply-To, also when the reply arrives first", async () => {
		const { ada } = await seedOrg();
		const original = rawMessage({
			from: "bob@sender.example",
			to: "ada@dock.test",
			subject: "Plan",
			messageId: "<p1@sender.example>",
		});
		const reply = rawMessage({
			from: "carol@sender.example",
			to: "ada@dock.test",
			subject: "Re: Plan",
			messageId: "<p2@sender.example>",
			inReplyTo: "<p1@sender.example>",
			references: ["<p1@sender.example>"],
		});
		const late = rawMessage({
			from: "bob@sender.example",
			to: "ada@dock.test",
			subject: "Re: Plan",
			messageId: "<p3@sender.example>",
			references: ["<p1@sender.example>", "<p2@sender.example>"],
		});
		await inject(reply, "ada@dock.test");
		await inject(original, "ada@dock.test");
		await inject(late, "ada@dock.test");
		const threads = await inbox(ada.call);
		expect(threads).toHaveLength(1);
		expect(threads[0]?.message_count).toBe(3);
	});

	// A stranger's "Re:" with the same subject must not land inside someone else's conversation.
	it("joins a reply without references by subject only for a participant, and never a new message", async () => {
		const { ada } = await seedOrg();
		const to = "ada@dock.test";
		await inject(rawMessage({ from: "bob@sender.example", to: `${to}, carol@sender.example`, subject: "Lunch?" }), to);
		await inject(rawMessage({ from: "bob@sender.example", to, subject: "RE: lunch?" }), to);
		await inject(rawMessage({ from: "carol@sender.example", to, subject: "Re: Lunch?" }), to);
		await inject(rawMessage({ from: "mallory@evil.example", to, subject: "Re: Lunch?" }), to);
		// An address that is only a part of a participant's address is not that participant.
		await inject(rawMessage({ from: "arol@sender.example", to, subject: "Re: Lunch?" }), to);
		await inject(rawMessage({ from: "dan@sender.example", to, subject: "Lunch?" }), to);
		await inject(rawMessage({ from: "dan@sender.example", to, subject: "Re: Dinner?" }), to);
		const counts = (await inbox(ada.call)).map((t) => t.message_count).sort();
		expect(counts).toEqual([1, 1, 1, 1, 3]);
	});

	// SMTPUTF8 addresses can have non-ASCII letters. Case folding must work for them too.
	it("treats a non-ASCII address in another case as the same participant", async () => {
		const { ada } = await seedOrg();
		const to = "ada@dock.test";
		await inject(rawMessage({ from: "bob@sender.example", to: `${to}, Älice@sender.example`, subject: "Plan" }), to);
		await inject(rawMessage({ from: "älice@sender.example", to, subject: "Re: Plan" }), to);
		expect((await inbox(ada.call)).map((t) => t.message_count)).toEqual([2]);
	});

	// A DMARC failure means the sender is forged. Such a message must not join a real conversation.
	it("never joins spam to a thread by subject", async () => {
		const { ada } = await seedOrg();
		const to = "ada@dock.test";
		await inject(rawMessage({ from: "bob@sender.example", to, subject: "Invoice" }), to);
		await inject(
			rawMessage({
				from: "bob@sender.example",
				to,
				subject: "Re: Invoice",
				headers: [["Authentication-Results", "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail"]],
			}),
			to,
		);
		const threads = (await ada.call("mail.list_threads", { query: "in:anywhere" })).threads;
		expect(threads.map((t) => t.message_count)).toEqual([1, 1]);
	});

	it("merges two threads when a message references both", async () => {
		const { ada } = await seedOrg();
		await inject(
			rawMessage({ from: "a@s.example", to: "ada@dock.test", subject: "One", messageId: "<m1@s.example>" }),
			"ada@dock.test",
		);
		await inject(
			rawMessage({ from: "a@s.example", to: "ada@dock.test", subject: "Two", messageId: "<m2@s.example>" }),
			"ada@dock.test",
		);
		expect(await inbox(ada.call)).toHaveLength(2);
		await inject(
			rawMessage({
				from: "a@s.example",
				to: "ada@dock.test",
				subject: "Both",
				references: ["<m1@s.example>", "<m2@s.example>"],
			}),
			"ada@dock.test",
		);
		const threads = await inbox(ada.call);
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({ subject: "One", message_count: 3 });
	});
});

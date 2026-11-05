import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ApiError } from "@soldock/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Actor,
	api,
	callTool,
	createActor,
	drainOutbox,
	fakeEmailService,
	ORIGIN,
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

async function sentCount(actor: Actor): Promise<number> {
	return (await actor.call("mail.list_threads", { query: "in:sent" })).threads.length;
}

async function deliveryOf(actor: Actor, threadId: string) {
	const thread = await actor.call("mail.get_thread", { thread_id: threadId });
	return thread.messages.at(-1)?.delivery;
}

describe("mail.send to mailboxes of this deployment", () => {
	it("stores a sent copy, delivers through the outbox, and threads the reply in both mailboxes", async () => {
		const sent = await owner.call("mail.send", { to: ["ada@dock.test"], subject: "Kickoff", text: "Monday at 10?" });
		expect(sent.recipients).toEqual([{ address: "ada@dock.test", kind: "local", status: "queued", error: null }]);
		await drainOutbox(owner.id);
		expect(await deliveryOf(owner, sent.thread_id)).toEqual([
			{ address: "ada@dock.test", kind: "local", status: "delivered", error: null },
		]);

		const [received] = (await ada.call("mail.list_threads")).threads;
		expect(received).toMatchObject({ subject: "Kickoff", unread: true, untrusted: false });
		const thread = await ada.call("mail.get_thread", { thread_id: received?.id as string });
		expect(thread.messages[0]).toMatchObject({
			origin: "internal",
			untrusted: false,
			from: { address: "owner@dock.test" },
		});

		const reply = await ada.call("mail.send", {
			to: ["owner@dock.test"],
			text: "Works for me.",
			reply_to_message_id: thread.messages[0]?.id as string,
		});
		expect(reply.thread_id).toBe(received?.id);
		await drainOutbox(ada.id);
		const ownerThread = await owner.call("mail.get_thread", { thread_id: sent.thread_id });
		expect(ownerThread.messages.map((m) => [m.subject, m.origin])).toEqual([
			["Kickoff", "sent"],
			["Re: Kickoff", "internal"],
		]);
	});

	// Internal mail must never leave the deployment, and must not count against the Email Service quota.
	it("never calls Email Service for an internal recipient", async () => {
		const email = await fakeEmailService(owner.id);
		await owner.call("mail.send", { to: ["ada@dock.test"], cc: ["bot@dock.test"], text: "Internal" });
		await drainOutbox(owner.id);
		expect(email.sent).toEqual([]);
		expect((await ada.call("mail.list_threads")).threads).toHaveLength(1);
		expect((await bot.call("mail.list_threads")).threads).toHaveLength(1);
	});

	it("puts mail to yourself in Sent and Inbox once, and refuses an unknown local address", async () => {
		const sent = await ada.call("mail.send", { to: ["ada@dock.test"], subject: "Note to self", text: "Buy milk" });
		expect(sent.recipients).toEqual([{ address: "ada@dock.test", kind: "local", status: "delivered", error: null }]);
		const [thread] = (await ada.call("mail.list_threads")).threads;
		expect(thread).toMatchObject({ id: sent.thread_id, message_count: 1 });
		expect(thread?.label_ids.sort()).toEqual(["INBOX", "SENT"]);
		expect(await code(ada.call("mail.send", { to: ["nobody@dock.test"], text: "?" }))).toBe("not_found");
	});
});

describe("mail.send to the internet", () => {
	it("hands the message to Email Service and records each recipient as sent", async () => {
		const sent = await ada.call("mail.send", { to: ["bob@example.org"], cc: ["carol@example.net"], text: "Hello" });
		await drainOutbox(ada.id);
		expect((await deliveryOf(ada, sent.thread_id))?.map((d) => [d.address, d.kind, d.status])).toEqual([
			["bob@example.org", "external", "sent"],
			["carol@example.net", "external", "sent"],
		]);
	});

	it("sends one copy for each external recipient with that recipient as the envelope, and no Bcc header", async () => {
		const email = await fakeEmailService(ada.id);
		const sent = await ada.call("mail.send", {
			to: ["Bob@Example.org", "owner@dock.test"],
			bcc: ["secret@example.net"],
			subject: "Proposal",
			text: "Attached.",
		});
		await drainOutbox(ada.id);
		// The domain is lowercased. The local part keeps its case, which the receiving server owns.
		expect(email.sent.sort((a, b) => a.to.localeCompare(b.to))).toEqual([
			{ from: "ada@dock.test", to: "Bob@example.org" },
			{ from: "ada@dock.test", to: "secret@example.net" },
		]);
		const thread = await ada.call("mail.get_thread", { thread_id: sent.thread_id });
		expect(thread.messages[0]?.bcc).toEqual([{ name: null, address: "secret@example.net" }]);
		const { objects } = await env.BLOBS.list({ prefix: `mail/raw/${ada.id}/` });
		const raw = await (await env.BLOBS.get(objects[0]?.key as string))?.text();
		expect(raw).not.toMatch(/^bcc:|secret@example\.net/im);
	});

	it("retries a failed external send with backoff, and keeps the recipient queued", async () => {
		const email = await fakeEmailService(ada.id);
		email.fail = new Error("temporary failure");
		const sent = await ada.call("mail.send", { to: ["bob@example.org"], text: "Retry me" });
		await drainOutbox(ada.id);
		expect(await deliveryOf(ada, sent.thread_id)).toEqual([
			{ address: "bob@example.org", kind: "external", status: "queued", error: null },
		]);
		expect(email.sent).toEqual([]);
		// The last allowed attempt fails too, so the recipient becomes failed and the outbox row goes.
		const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(ada.id));
		await runInDurableObject(mailbox, (_instance, state) => {
			state.storage.sql.exec("UPDATE outbox SET attempts = 7, next_attempt_at = ?", Date.now());
		});
		await drainOutbox(ada.id);
		expect(await deliveryOf(ada, sent.thread_id)).toEqual([
			{ address: "bob@example.org", kind: "external", status: "failed", error: "temporary failure" },
		]);
		const left = await runInDurableObject(
			mailbox,
			(_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n,
		);
		expect(left).toBe(0);
	});

	it("cancels pending mail from a deleted account after a fresh reset reuses its address", async () => {
		const email = await fakeEmailService(ada.id);
		email.fail = new Error("temporary failure");
		const sent = await ada.call("mail.send", { to: ["bob@example.org"], text: "Old private mail" });
		await drainOutbox(ada.id);
		const reset = await request("/auth/setup", {
			method: "POST",
			headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({
				display_name: "New owner",
				mail_domain: "dock.test",
				address: "ada@dock.test",
				sign_in_email: "new@home.example",
				start_fresh: "DELETE DIRECTORY",
			}),
		});
		expect(reset.status).toBe(201);
		email.fail = null;
		const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(ada.id));
		await runInDurableObject(mailbox, (_instance, state) => {
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = ?", Date.now());
		});
		await drainOutbox(ada.id);
		expect(email.sent).toEqual([]);
		const thread = await mailbox.getThread(sent.thread_id);
		expect(thread).toMatchObject({
			messages: [{ delivery: [{ status: "failed", error: "The sender account no longer owns this address." }] }],
		});
		const left = await runInDurableObject(
			mailbox,
			(_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n,
		);
		expect(left).toBe(0);
	});

	it.each([false, true])(
		"waits for an active send and blocks new accounts before a reset (lease replaced: %s)",
		async (replaceLease) => {
			let releaseSend = () => {};
			let didStart = false;
			const delivered: string[] = [];
			const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(ada.id));
			await runInDurableObject(mailbox, (instance) => {
				const gate = new Promise<void>((resolve) => {
					releaseSend = resolve;
				});
				const target = instance as unknown as { env: Env };
				target.env = {
					...target.env,
					EMAIL: {
						send: async (message: EmailMessage) => {
							didStart = true;
							await gate;
							delivered.push(message.to);
							return { messageId: "<accepted@email.test>" };
						},
					} as unknown as SendEmail,
				};
			});
			const sent = await ada.call("mail.send", { to: ["first@example.org", "second@example.org"], text: "In flight" });
			await vi.waitFor(() => expect(didStart).toBe(true));
			let response: Response | null = null;
			const init = {
				method: "POST",
				headers: { authorization: `Bearer ${SETUP_TOKEN}`, "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify({
					display_name: "New owner",
					mail_domain: "dock.test",
					address: "ada@dock.test",
					sign_in_email: "new@home.example",
					start_fresh: "DELETE DIRECTORY",
				}),
			};
			const reset = request("/auth/setup", init).then((result) => {
				response = result;
				return result;
			});
			let replacement: Promise<Response> | null = null;
			try {
				await vi.waitFor(async () => {
					if (response) throw new Error("Reset returned before the active send completed");
					const paused = await runInDurableObject(mailbox, (_instance, state) =>
						state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'delivery_pause'").toArray(),
					);
					expect(paused).toHaveLength(1);
				});
				expect(response).toBeNull();
				expect(
					await code(
						owner.call("directory.create_principal", {
							kind: "human",
							display_name: "Late account",
							address: "late@dock.test",
							sign_in_email: "late@home.example",
						}),
					),
				).toBe("conflict");
				expect(await env.DIRECTORY.prepare("SELECT id FROM principals WHERE id = ?").bind(ada.id).first("id")).toBe(
					ada.id,
				);
				if (replaceLease) {
					const previousToken = await env.DIRECTORY.prepare("SELECT token FROM setup_lock").first<string>("token");
					const previousGeneration = await env.DIRECTORY.prepare("SELECT generation FROM setup_lock").first<number>(
						"generation",
					);
					await env.DIRECTORY.prepare("UPDATE setup_lock SET expires_at = 0").run();
					replacement = request("/auth/setup", init);
					await vi.waitFor(async () => {
						const paused = await runInDurableObject(
							mailbox,
							(_instance, state) =>
								state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'delivery_pause'").one()
									.value,
						);
						expect(paused).not.toBe(previousToken);
					});
					await mailbox.pauseDeliveries(previousToken as string, previousGeneration as number);
					await mailbox.resumeDeliveries(previousToken as string);
					const currentPause = await runInDurableObject(
						mailbox,
						(_instance, state) =>
							state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'delivery_pause'").one()
								.value,
					);
					expect(currentPause).not.toBe(previousToken);
				} else {
					expect((await request("/auth/setup", init)).status).toBe(409);
				}
			} finally {
				await runInDurableObject(mailbox, () => releaseSend());
				await reset;
				await replacement;
			}
			expect((await reset).status).toBe(replaceLease ? 409 : 201);
			if (replacement) expect((await replacement).status).toBe(201);
			expect(delivered).toEqual(["first@example.org"]);
			const thread = await mailbox.getThread(sent.thread_id);
			expect(thread?.messages[0]?.delivery?.map((recipient) => recipient.status)).toEqual(["sent", "failed"]);
			await evictDurableObject(mailbox);
			await drainOutbox(ada.id);
			expect(delivered).toEqual(["first@example.org"]);
		},
	);

	// A request that is too large must be refused while it streams, not after it fills memory.
	it("refuses a request body over the limit before it reads all of it", async () => {
		let pulled = 0;
		const chunk = new Uint8Array(1024 * 1024).fill(0x20);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				if (pulled > 40) controller.close();
				else controller.enqueue(chunk);
			},
		});
		const res = await request("/api/v1/mail/messages", {
			method: "POST",
			headers: { authorization: `Bearer ${ada.key}`, "content-type": "application/json" },
			body,
			duplex: "half",
		} as RequestInit);
		expect(res.status).toBe(413);
		expect(pulled).toBeLessThan(40);
	});

	// The alarm takes 25 outbox rows at a time, and it must set itself again until the outbox is empty.
	it("delivers more recipients than one alarm batch takes", async () => {
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		const email = await fakeEmailService(ada.id);
		const to = Array.from({ length: 30 }, (_, i) => `r${i}@example.org`);
		const sent = await ada.call("mail.send", { to, text: "To many" });
		await drainOutbox(ada.id);
		expect(email.sent).toHaveLength(30);
		expect((await deliveryOf(ada, sent.thread_id))?.every((d) => d.status === "sent")).toBe(true);
	});

	// send() sets the alarm after its transaction. An object that stops in between must still deliver.
	it("sets the alarm again on start when the outbox has rows and no alarm", async () => {
		const sent = await ada.call("mail.send", { to: ["owner@dock.test"], text: "Lost alarm" });
		await drainOutbox(ada.id);
		// The runtime fires the alarm at once, so the test makes the state of a lost alarm itself:
		// a queued recipient, an outbox row and no alarm.
		const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(ada.id));
		await runInDurableObject(mailbox, async (_instance, state) => {
			await state.storage.deleteAlarm();
			state.storage.sql.exec("UPDATE delivery SET status = 'queued'");
			state.storage.sql.exec(
				"INSERT INTO outbox (message_seq, kind, target, address, next_attempt_at) SELECT message_seq, 'deliver', ?, address, ? FROM delivery",
				owner.id,
				Date.now(),
			);
		});
		await evictDurableObject(mailbox);
		await drainOutbox(ada.id);
		expect(await deliveryOf(ada, sent.thread_id)).toEqual([
			{ address: "owner@dock.test", kind: "local", status: "delivered", error: null },
		]);
	});

	// Email Service accepts 5 MiB for each message.
	it("refuses a message over 5 MiB when a recipient is external, and accepts it for local recipients", async () => {
		const big = btoa("x".repeat(4 * 1024 * 1024));
		const attachments = [{ filename: "big.bin", mime_type: "application/octet-stream", content_base64: big }];
		expect(await code(ada.call("mail.send", { to: ["bob@example.org"], text: "big", attachments }))).toBe(
			"payload_too_large",
		);
		expect(await sentCount(ada)).toBe(0);
		await ada.call("mail.send", { to: ["owner@dock.test"], text: "big", attachments });
		expect(await sentCount(ada)).toBe(1);
	});

	it("refuses a line break in the subject, so no header can be injected", async () => {
		expect(
			await code(ada.call("mail.send", { to: ["bob@example.org"], subject: "Hi\r\nBcc: x@evil.example", text: "x" })),
		).toBe("invalid");
	});
});

describe("agent outbound policy", () => {
	it("lets an internal-only agent send only inside the deployment, before anything is stored", async () => {
		expect(await code(bot.call("mail.send", { to: ["customer@example.org"], text: "Invoice" }))).toBe("policy_denied");
		expect(await code(bot.call("mail.send", { to: ["ada@dock.test"], cc: ["customer@example.org"], text: "x" }))).toBe(
			"policy_denied",
		);
		expect(await sentCount(bot)).toBe(0);
		await bot.call("mail.send", { to: ["ada@dock.test"], text: "Internal note" });
		expect(await sentCount(bot)).toBe(1);
	});

	it("applies an allowlist by domain and address, and a policy change at once", async () => {
		await ada.call("directory.update_agent_policy", {
			principal_id: bot.id,
			mode: "allowlist",
			allowlist: ["Example.org", "partner@vendor.example"],
		});
		await bot.call("mail.send", { to: ["anyone@example.org", "partner@vendor.example"], text: "Allowed" });
		expect(await code(bot.call("mail.send", { to: ["other@vendor.example"], text: "No" }))).toBe("policy_denied");
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "any" });
		await bot.call("mail.send", { to: ["other@vendor.example"], text: "Now allowed" });
		await ada.call("directory.update_agent_policy", { principal_id: bot.id, mode: "internal-only" });
		expect(await code(bot.call("mail.send", { to: ["anyone@example.org"], text: "No again" }))).toBe("policy_denied");
	});

	it("refuses the send through MCP with the same code, and marks agent mail with X-Soldock-Agent", async () => {
		const result = await callTool(bot.key, "mail_send", { to: ["customer@example.org"], text: "Invoice" });
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ code: "policy_denied" });
		await bot.call("mail.send", { to: ["ada@dock.test"], text: "Hello" });
		const { objects } = await env.BLOBS.list({ prefix: `mail/raw/${bot.id}/` });
		const raw = await (await env.BLOBS.get(objects[0]?.key as string))?.text();
		expect(raw).toMatch(/^X-Soldock-Agent: true\r$/m);
	});

	it("needs the mail.send scope", async () => {
		const { api_key } = await ada.call("account.create_api_key", {
			principal_id: bot.id,
			label: "read only",
			scopes: ["mail.read"],
		});
		expect(await code(api(api_key.secret)("mail.send", { to: ["ada@dock.test"], text: "x" }))).toBe("forbidden");
	});
});

describe("idempotency", () => {
	// A key names one message. Reusing it for another message is a client bug that must not pass silently.
	it("refuses the same key with a different message", async () => {
		await ada.call("mail.send", { to: ["owner@dock.test"], text: "First", idempotency_key: "k-x" });
		expect(await code(ada.call("mail.send", { to: ["owner@dock.test"], text: "Second", idempotency_key: "k-x" }))).toBe(
			"conflict",
		);
		expect(await sentCount(ada)).toBe(1);
	});

	// Two attempts compose different bytes, so each stores its own raw object. The loser's must go.
	it("keeps one message and one raw object when two sends with one key race", async () => {
		const send = () => ada.call("mail.send", { to: ["owner@dock.test"], text: "Race", idempotency_key: "race" });
		const [a, b] = await Promise.all([send(), send()]);
		expect(a.message_id).toBe(b.message_id);
		expect(await sentCount(ada)).toBe(1);
		const { objects } = await env.BLOBS.list({ prefix: `mail/raw/${ada.id}/` });
		expect(objects).toHaveLength(1);
	});

	it("returns the first result for a repeated key, from the body or the Idempotency-Key header", async () => {
		const first = await ada.call("mail.send", { to: ["owner@dock.test"], text: "Once", idempotency_key: "k-1" });
		const second = await ada.call("mail.send", { to: ["owner@dock.test"], text: "Once", idempotency_key: "k-1" });
		expect(second.message_id).toBe(first.message_id);
		const viaHeader = () =>
			request("/api/v1/mail/messages", {
				method: "POST",
				headers: {
					authorization: `Bearer ${ada.key}`,
					"content-type": "application/json",
					"idempotency-key": "k-2",
					origin: ORIGIN,
				},
				body: JSON.stringify({ to: ["owner@dock.test"], text: "Header" }),
			}).then((res) => res.json() as Promise<{ message_id: string }>);
		expect((await viaHeader()).message_id).toBe((await viaHeader()).message_id);
		expect(await sentCount(ada)).toBe(2);
		// After 24 hours a key is free again, and the send goes through.
		await runInDurableObject(env.MAILBOX.get(env.MAILBOX.idFromName(ada.id)), (_instance, state) => {
			state.storage.sql.exec("UPDATE idempotency SET created_at = ? WHERE key = 'k-1'", Date.now() - 25 * 3_600_000);
		});
		const later = await ada.call("mail.send", { to: ["owner@dock.test"], text: "Once more", idempotency_key: "k-1" });
		expect(later.message_id).not.toBe(first.message_id);
		expect(await sentCount(ada)).toBe(3);
		const other = await createActor(owner, {
			kind: "human",
			display_name: "Bob",
			address: "bob@dock.test",
			sign_in_email: "bob@home.example",
		});
		const keyedByMailbox = await other.call("mail.send", {
			to: ["ada@dock.test"],
			text: "Mine",
			idempotency_key: "k-1",
		});
		expect(keyedByMailbox.message_id).not.toBe(first.message_id);
	});
});

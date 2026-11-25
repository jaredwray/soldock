import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { type Actor, api, callTool, codeOf, inject, rawMessage, seedOrg } from "./helpers.ts";

// The composer completes an address from the addresses that the mailbox sent mail to. Each send adds
// its To, Cc and Bcc addresses. Mail that arrives adds nothing.

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

/** Lets the clock move, so the next send has a later time. Workers time moves only across I/O. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

async function addresses(actor: Actor, query?: string, extra: { mailbox_id?: string; limit?: number } = {}) {
	const { recipients } = await actor.call("mail.suggest_recipients", {
		...extra,
		...(query === undefined ? {} : { query }),
	});
	return recipients.map((recipient) => recipient.address);
}

describe("mail.suggest_recipients", () => {
	it("counts each sent message once for each address, and ignores mail that arrives and a repeated send", async () => {
		const first = await ada.call("mail.send", {
			to: ["Bob@Example.org"],
			cc: ["carol@example.net", "Bob@Example.org"],
			bcc: ["dave@example.com"],
			text: "One",
		});
		await tick();
		const retry = { to: ["bob@example.org"], text: "Two", idempotency_key: "two" };
		const second = await ada.call("mail.send", retry);
		expect(await ada.call("mail.send", retry)).toEqual(second);
		await inject(
			rawMessage({ from: "Eve <eve@stranger.example>", to: "ada@dock.test", subject: "Hi" }),
			"ada@dock.test",
		);

		const receivedAt = async (id: string) =>
			(await ada.call("mail.get_thread", { thread_id: id })).messages[0]?.received_at;
		const { recipients } = await ada.call("mail.suggest_recipients");
		expect(recipients).toEqual([
			// The domain is lowercase. The local part keeps the case of the last send.
			{ address: "bob@example.org", times_sent: 2, last_sent_at: await receivedAt(second.thread_id) },
			{ address: "carol@example.net", times_sent: 1, last_sent_at: await receivedAt(first.thread_id) },
			{ address: "dave@example.com", times_sent: 1, last_sent_at: await receivedAt(first.thread_id) },
		]);
		// Parity: the MCP tool returns the same data as the REST route.
		expect((await callTool(ada.key, "mail_suggest_recipients")).structuredContent).toEqual({ recipients });
	});

	it("puts the start of the address first, then the start of a part, then the rest, and the newest send first in each", async () => {
		await ada.call("mail.send", {
			to: ["andy@x.test", "joe.anders@x.test", "dan@x.test", "bob@x.test"],
			text: "Older",
		});
		await tick();
		await ada.call("mail.send", { to: ["anna@x.test", "sam@ansible.example"], text: "Newer" });

		const ranked = ["anna@x.test", "andy@x.test", "sam@ansible.example", "joe.anders@x.test", "dan@x.test"];
		expect(await addresses(ada, "an")).toEqual(ranked);
		expect(await addresses(ada, " AN ")).toEqual(ranked);
		expect(await addresses(ada, "an", { limit: 2 })).toEqual(ranked.slice(0, 2));
		// A query that starts with a separator starts a part.
		expect(await addresses(ada, "@ans")).toEqual(["sam@ansible.example"]);
		expect(await addresses(ada, "zz")).toEqual([]);
		// No query: the newest sends first.
		expect(await addresses(ada)).toEqual([
			"anna@x.test",
			"sam@ansible.example",
			"andy@x.test",
			"bob@x.test",
			"dan@x.test",
			"joe.anders@x.test",
		]);
	});

	// A mailbox with sent mail from before the table gets the same addresses as the sends would give.
	it("fills the table from the sent mail when the mailbox migrates", async () => {
		await ada.call("mail.send", { to: ["bob@example.org"], cc: ["carol@example.net"], text: "One" });
		await tick();
		await ada.call("mail.send", {
			// One address twice, in two forms: the first entry gives the form.
			to: ["Bob@example.org"],
			cc: ["bob@example.org", "owner@dock.test"],
			bcc: ["dave@example.com", "owner@dock.test"],
			text: "Two",
		});
		await inject(rawMessage({ from: "eve@stranger.example", to: "ada@dock.test", subject: "Hi" }), "ada@dock.test");
		const live = await ada.call("mail.suggest_recipients");
		expect(live.recipients.map((r) => [r.address, r.times_sent])).toEqual([
			["Bob@example.org", 2],
			["dave@example.com", 1],
			["owner@dock.test", 1],
			["carol@example.net", 1],
		]);

		const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(ada.id));
		await runInDurableObject(mailbox, (_instance, state) => {
			// Back to schema 3: before the recipients table (migration 4), the auto labels (migration 5) and the
			// Screener (migration 6).
			const sql = state.storage.sql;
			sql.exec("DROP TABLE screener_senders");
			sql.exec("DROP INDEX messages_from");
			sql.exec("ALTER TABLE messages DROP COLUMN screen");
			sql.exec("DROP TABLE recipients");
			sql.exec("DROP TABLE auto_labels");
			sql.exec("DROP TABLE label_corrections");
			sql.exec("DROP TABLE autolabel_outbox");
			sql.exec("ALTER TABLE message_labels DROP COLUMN auto");
			sql.exec("ALTER TABLE messages DROP COLUMN signals_json");
			sql.exec("ALTER TABLE messages DROP COLUMN auto_labeled_at");
			sql.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
		});
		await evictDurableObject(mailbox);
		expect(await ada.call("mail.suggest_recipients")).toEqual(live);
	});

	it("uses the mailbox of the call, and refuses a caller without access or without mail.read", async () => {
		const { team_mailbox: support } = await owner.call("directory.create_team_mailbox", {
			display_name: "Support",
			address: "support@dock.test",
			member_ids: [ada.id, bot.id],
		});
		await ada.call("mail.send", { mailbox_id: support.id, to: ["customer@example.org"], text: "Fixed." });
		await bot.call("mail.send", { to: ["ada@dock.test"], text: "Report attached." });

		// The members share the addresses of the team mailbox. The own mailbox of each member stays apart.
		expect(await addresses(bot, "cus", { mailbox_id: support.id })).toEqual(["customer@example.org"]);
		expect(await addresses(ada, "cus")).toEqual([]);
		const tool = await callTool(bot.key, "mail_suggest_recipients", { query: "ada" });
		expect(tool.structuredContent).toEqual({
			recipients: [{ address: "ada@dock.test", times_sent: 1, last_sent_at: expect.any(String) }],
		});

		expect(await codeOf(owner.call("mail.suggest_recipients", { mailbox_id: support.id }))).toBe("forbidden");
		expect(await codeOf(owner.call("mail.suggest_recipients", { mailbox_id: ada.id }))).toBe("forbidden");
		const { api_key } = await ada.call("account.create_api_key", { label: "Narrow", scopes: ["directory.read"] });
		expect(await codeOf(api(api_key.secret)("mail.suggest_recipients"))).toBe("forbidden");
	});
});

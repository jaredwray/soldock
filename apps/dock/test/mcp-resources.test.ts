import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { UNTRUSTED_NOTICE } from "@soldock/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUED_EVENTS, MAX_STREAM_MS, RECHECK_MS } from "../src/mcp/listen.ts";
import { callTool, inject, mcp, modern, modernRequest, rawMessage, readSse, seedOrg } from "./helpers.ts";

const inbox = (mailboxId: string) => `soldock://mail/${mailboxId}/inbox`;

/** The owner, Ada and the agent Bot, with a team mailbox that Bot is a member of and one that Bot is not. */
async function seedTeams() {
	const org = await seedOrg();
	const team = async (address: string, members: string[]) =>
		(
			await org.owner.call("directory.create_team_mailbox", {
				display_name: address.split("@")[0] as string,
				address,
				member_ids: members,
			})
		).team_mailbox;
	const support = await team("support@dock.test", [org.ada.id, org.bot.id]);
	const finance = await team("finance@dock.test", [org.ada.id]);
	return { ...org, support, finance };
}

/** Opens a subscriptions/listen stream for the URIs. */
async function listen(key: string, uris: string[], extra: Record<string, unknown> = {}, id: string | number = "sub-1") {
	const response = await modernRequest(
		key,
		"subscriptions/listen",
		{ notifications: { resourceSubscriptions: uris, ...extra } },
		{ id },
	);
	expect(response.headers.get("content-type")).toBe("text/event-stream");
	return readSse(response);
}

/** The number of watch sockets that a mailbox holds open. */
function watchSockets(mailboxId: string): Promise<number> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	return runInDurableObject(stub, (_instance, state) => state.getWebSockets("watch").length);
}

const updated = (uri: string, id: string | number = "sub-1") => ({
	jsonrpc: "2.0",
	method: "notifications/resources/updated",
	params: { uri, _meta: { "io.modelcontextprotocol/subscriptionId": id } },
});

afterEach(() => {
	vi.useRealTimers();
});

describe("MCP resources", () => {
	it("lists and reads the inbox of each mailbox that the caller can use, with the data of REST", async () => {
		const { owner, bot, support, finance } = await seedTeams();
		await inject(
			rawMessage({ from: "x@internet.example", to: "bot@dock.test", subject: "Invoice", text: "Pay now." }),
			"bot@dock.test",
		);

		const listed = (await modern(bot.key, "resources/list")).body?.result as Record<string, unknown>;
		expect(listed).toMatchObject({ resultType: "complete", cacheScope: "private" });
		expect(listed.resources).toEqual([
			expect.objectContaining({
				uri: inbox(bot.id),
				mimeType: "application/json",
				title: "Inbox of Billing Bot <bot@dock.test>",
			}),
			expect.objectContaining({ uri: inbox(support.id), title: "Inbox of support <support@dock.test>" }),
		]);
		const templates = (await modern(bot.key, "resources/templates/list")).body?.result as Record<string, unknown>;
		expect(templates.resourceTemplates).toEqual([
			expect.objectContaining({ uriTemplate: "soldock://mail/{mailbox_id}/inbox", name: "mail.inbox" }),
		]);

		// Parity: the read runs mail.list_threads, so it returns what REST returns, after the untrusted notice.
		const read = (await modern(bot.key, "resources/read", { uri: inbox(bot.id) })).body?.result as {
			contents: { uri: string; mimeType: string; text: string }[];
			ttlMs: number;
		};
		expect(read.ttlMs).toBe(0);
		expect(read.contents.map((content) => [content.uri, content.mimeType])).toEqual([
			[inbox(bot.id), "text/plain"],
			[inbox(bot.id), "application/json"],
		]);
		expect(read.contents[0]?.text).toBe(UNTRUSTED_NOTICE);
		expect(JSON.parse(read.contents[1]?.text ?? "null")).toEqual(
			await bot.call("mail.list_threads", { query: "in:inbox" }),
		);

		// The read checks the mailbox as the operation does. Legacy clients get the not-found code of their protocol.
		const refused = await modern(bot.key, "resources/read", { uri: inbox(finance.id) });
		expect(refused.body?.error).toMatchObject({ code: -32602, data: { uri: inbox(finance.id), code: "forbidden" } });
		expect((await modern(bot.key, "resources/read", { uri: "soldock://mail/nope/inbox" })).body?.error).toMatchObject({
			code: -32602,
			message: "Resource not found",
		});
		expect((await mcp(bot.key, "resources/read", { uri: inbox(finance.id) })).body?.error).toMatchObject({
			code: -32002,
		});

		// A credential without mail.read sees no inbox at all.
		const { api_key } = await owner.call("account.create_api_key", {
			principal_id: bot.id,
			label: "Drive only",
			scopes: ["drive.read"],
		});
		expect((await modern(api_key.secret, "resources/list")).body?.result).toMatchObject({ resources: [] });
		expect((await modern(api_key.secret, "resources/templates/list")).body?.result).toMatchObject({
			resourceTemplates: [],
		});
		expect((await modern(api_key.secret, "resources/read", { uri: inbox(bot.id) })).body?.error).toMatchObject({
			code: -32602,
		});
	});

	// A legacy client has no session, so no stream can carry its notifications.
	it("tells a legacy client that it can read resources but not subscribe", async () => {
		const { bot } = await seedOrg();
		const init = await mcp(bot.key, "initialize", { protocolVersion: "2025-11-25", capabilities: {} });
		expect(init.body?.result).toMatchObject({ capabilities: { resources: { subscribe: false } } });
		expect((await mcp(bot.key, "resources/list")).body?.result).toMatchObject({
			resources: [expect.objectContaining({ uri: inbox(bot.id) })],
		});
	});
});

describe("MCP subscriptions/listen", () => {
	it("notifies a subscriber of new mail in its own inbox and its team inboxes, and of nothing else", async () => {
		const { ada, bot, support, finance } = await seedTeams();
		// An alias with other percent-encoding names no resource, so one request cannot watch a mailbox many times.
		const alias = inbox(support.id).replace("tmb_", "%74mb_");
		const stream = await listen(
			bot.key,
			[inbox(bot.id), inbox(support.id), inbox(finance.id), "soldock://x", inbox(bot.id), alias],
			{ toolsListChanged: true },
		);
		// The acknowledgment comes first. It keeps only what the caller can watch, and gives no reason for the rest.
		expect(await stream.next()).toEqual({
			jsonrpc: "2.0",
			method: "notifications/subscriptions/acknowledged",
			params: {
				_meta: { "io.modelcontextprotocol/subscriptionId": "sub-1" },
				notifications: { resourceSubscriptions: [inbox(bot.id), inbox(support.id)] },
			},
		});
		// A person who is a member watches the same team inbox with a human key.
		const human = await listen(ada.key, [inbox(support.id)], {}, "ada-1");
		expect(await human.next()).toMatchObject({
			params: { notifications: { resourceSubscriptions: [inbox(support.id)] } },
		});

		// Spam, mail to somebody else and mail to a team that Bot is not in send nothing.
		await inject(
			rawMessage({
				from: "x@bank.example",
				to: "bot@dock.test",
				subject: "Spam",
				headers: [["Authentication-Results", "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail"]],
			}),
			"bot@dock.test",
		);
		await inject(rawMessage({ from: "x@internet.example", to: "ada@dock.test", subject: "For Ada" }), "ada@dock.test");
		await inject(
			rawMessage({ from: "x@internet.example", to: "finance@dock.test", subject: "Tax" }),
			"finance@dock.test",
		);
		await inject(rawMessage({ from: "x@internet.example", to: "bot@dock.test", subject: "Hello" }), "bot@dock.test");
		expect(await stream.next()).toEqual(updated(inbox(bot.id)));
		await inject(
			rawMessage({ from: "x@internet.example", to: "support@dock.test", subject: "Help" }),
			"support@dock.test",
		);
		expect(await stream.next()).toEqual(updated(inbox(support.id)));
		expect(await human.next()).toEqual(updated(inbox(support.id), "ada-1"));
		await human.cancel();

		// Mail that a mailbox sends to itself is new mail in its inbox too.
		const sent = await callTool(bot.key, "mail_send", { to: ["bot@dock.test"], subject: "Note to self", text: "Hi." });
		expect(sent.isError).toBeUndefined();
		expect(await stream.next()).toEqual(updated(inbox(bot.id)));
		// A send to another person does not change the inbox of the sender.
		await callTool(bot.key, "mail_send", { to: ["ada@dock.test"], subject: "Hi Ada", text: "Hi." });
		await inject(
			rawMessage({ from: "x@internet.example", to: "support@dock.test", subject: "More" }),
			"support@dock.test",
		);
		expect(await stream.next()).toEqual(updated(inbox(support.id)));
		expect((await ada.call("mail.list_threads")).threads.map((thread) => thread.subject)).toContain("Hi Ada");

		// The client closes the stream: the mailboxes close their watch sockets.
		expect(await watchSockets(bot.id)).toBe(1);
		await stream.cancel();
		await vi.waitFor(async () => {
			expect(await watchSockets(bot.id)).toBe(0);
			expect(await watchSockets(support.id)).toBe(0);
		});
	});

	// A client that holds the connection and reads nothing must not fill the memory of the Worker.
	it("ends when the client does not read its events", async () => {
		const { bot } = await seedOrg();
		const stream = await listen(bot.key, [inbox(bot.id)]);
		expect(await stream.next()).toMatchObject({ method: "notifications/subscriptions/acknowledged" });
		const delivered = MAX_QUEUED_EVENTS + 16;
		for (let i = 0; i < delivered; i++) {
			await inject(rawMessage({ from: "x@internet.example", to: "bot@dock.test", subject: `M${i}` }), "bot@dock.test");
		}
		let received = 0;
		while ((await stream.next()) !== "closed") received++;
		expect(received).toBeGreaterThan(0);
		expect(received).toBeLessThan(delivered);
		await vi.waitFor(async () => expect(await watchSockets(bot.id)).toBe(0));
	});

	it("ends in the graceful way at once when it has nothing to watch", async () => {
		const { bot, finance } = await seedTeams();
		const stream = await listen(bot.key, [inbox(finance.id)], {}, 9);
		expect(await stream.next()).toMatchObject({
			method: "notifications/subscriptions/acknowledged",
			params: { notifications: { resourceSubscriptions: [] } },
		});
		expect(await stream.next()).toMatchObject({
			id: 9,
			result: { resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": 9 } },
		});
		expect(await stream.next()).toBe("closed");
	});

	// A long-lived stream must not outlive the access that opened it.
	it("ends when the caller loses a mailbox or its credential, and after its longest life", async () => {
		const { owner, bot, support } = await seedTeams();
		const { api_key: second } = await owner.call("account.create_api_key", {
			principal_id: bot.id,
			label: "Second",
			scopes: ["mail.read"],
		});
		// Only the clock is fake: the stream checks its age and its access against Date.now().
		vi.useFakeTimers({ toFake: ["Date"] });
		const team = await listen(bot.key, [inbox(support.id)]);
		const revoked = await listen(second.secret, [inbox(bot.id)]);
		const steady = await listen(bot.key, [inbox(bot.id)]);
		for (const stream of [team, revoked, steady]) {
			expect(await stream.next()).toMatchObject({ method: "notifications/subscriptions/acknowledged" });
		}

		await owner.call("directory.remove_team_mailbox_member", { mailbox_id: support.id, principal_id: bot.id });
		await owner.call("account.revoke_api_key", { key_id: second.id });
		// The next change after RECHECK_MS makes each stream check its access first.
		vi.setSystemTime(Date.now() + RECHECK_MS);
		await inject(
			rawMessage({ from: "x@internet.example", to: "support@dock.test", subject: "Help" }),
			"support@dock.test",
		);
		await inject(rawMessage({ from: "x@internet.example", to: "bot@dock.test", subject: "Hello" }), "bot@dock.test");
		expect(await team.next()).toBe("closed");
		expect(await revoked.next()).toBe("closed");
		expect(await steady.next()).toEqual(updated(inbox(bot.id)));
		await vi.waitFor(async () => expect(await watchSockets(support.id)).toBe(0));

		// A stream older than MAX_STREAM_MS ends at its next change, without a notification.
		vi.setSystemTime(Date.now() + MAX_STREAM_MS);
		await inject(rawMessage({ from: "x@internet.example", to: "bot@dock.test", subject: "Late" }), "bot@dock.test");
		expect(await steady.next()).toBe("closed");
		await vi.waitFor(async () => expect(await watchSockets(bot.id)).toBe(0));
	});
});

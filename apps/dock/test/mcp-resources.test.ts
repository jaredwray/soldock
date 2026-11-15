import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CHAT_LIMITS, UNTRUSTED_NOTICE } from "@soldock/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUED_EVENTS, MAX_STREAM_MS, RECHECK_MS } from "../src/mcp/listen.ts";
import {
	bearer,
	callTool,
	drainOutbox,
	inject,
	mcp,
	modern,
	modernRequest,
	rawMessage,
	readSse,
	seedOrg,
	upgradeRoomSocket,
} from "./helpers.ts";

const inbox = (mailboxId: string) => `soldock://mail/${mailboxId}/inbox`;
const roomMessages = (roomId: string) => `soldock://chat/${roomId}/messages`;

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
			expect.objectContaining({ uriTemplate: "soldock://chat/{room_id}/messages", name: "chat.room" }),
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

	it("lists the rooms of the caller, and reads the messages of one with the data of REST", async () => {
		const { ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
		const { room: dm } = await ada.call("chat.open_dm", { principal_id: bot.id });
		const { room: closed } = await ada.call("chat.create_room", { kind: "private", name: "Hiring" });
		await ada.call("chat.post_message", { room_id: room.id, text: "We ship on Friday." });

		const listed = (await modern(bot.key, "resources/list")).body?.result as { resources: Record<string, unknown>[] };
		expect(listed.resources.filter((resource) => String(resource.uri).startsWith("soldock://chat/"))).toEqual([
			expect.objectContaining({ uri: roomMessages(room.id), title: "Messages of #Launch" }),
			expect.objectContaining({ uri: roomMessages(dm.id), title: "Direct message with Ada Lovelace" }),
		]);
		// Parity: the read runs chat.list_messages, so it returns what REST returns. Chat has no content from outside.
		const read = (await modern(bot.key, "resources/read", { uri: roomMessages(room.id) })).body?.result as {
			contents: { mimeType: string; text: string }[];
		};
		expect(read.contents.map((content) => content.mimeType)).toEqual(["application/json"]);
		expect(JSON.parse(read.contents[0]?.text ?? "null")).toEqual(
			await bot.call("chat.list_messages", { room_id: room.id }),
		);
		// A private room of other members is not found, as for the operation.
		const refused = await modern(bot.key, "resources/read", { uri: roomMessages(closed.id) });
		expect(refused.body?.error).toMatchObject({ code: -32602, data: { code: "not_found" } });
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
		// The outbox of the sender delivers the mail a moment after the send.
		await drainOutbox(bot.id);
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

	// An owner reads the mail of an agent with an audit line. A watch would tell when the agent gets mail, without one.
	it("lets an owner read the inbox of an agent, but not subscribe to it", async () => {
		const { owner, bot } = await seedTeams();
		const listed = (await modern(owner.key, "resources/list")).body?.result as { resources: { uri: string }[] };
		expect(listed.resources.map((resource) => resource.uri)).toContain(inbox(bot.id));
		expect((await modern(owner.key, "resources/read", { uri: inbox(bot.id) })).body?.result).toMatchObject({
			resultType: "complete",
		});
		const stream = await listen(owner.key, [inbox(owner.id), inbox(bot.id)]);
		expect(await stream.next()).toMatchObject({
			params: { notifications: { resourceSubscriptions: [inbox(owner.id)] } },
		});
		await stream.cancel();
	});

	it("notifies a member about each change of a message in a room, and ends when the room removes the member", async () => {
		const { owner, ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
		const { room: closed } = await ada.call("chat.create_room", { kind: "private", name: "Hiring" });
		const stream = await listen(bot.key, [roomMessages(room.id), roomMessages(closed.id)]);
		// A room that the caller is not a member of is left out, with no reason.
		expect(await stream.next()).toMatchObject({
			method: "notifications/subscriptions/acknowledged",
			params: { notifications: { resourceSubscriptions: [roomMessages(room.id)] } },
		});
		// A principal that is not a member cannot subscribe, also an owner of the organization.
		const outsider = await listen(owner.key, [roomMessages(room.id)], {}, "owner-1");
		expect(await outsider.next()).toMatchObject({ params: { notifications: { resourceSubscriptions: [] } } });
		await outsider.cancel();

		const { message } = await ada.call("chat.post_message", { room_id: room.id, text: "We ship on Friday." });
		expect(await stream.next()).toEqual(updated(roomMessages(room.id)));
		// A new name is no change of the messages: the next notification is the edit.
		await ada.call("chat.update_room", { room_id: room.id, name: "Launch week" });
		await ada.call("chat.edit_message", { room_id: room.id, message_id: message.id, text: "We ship on Monday." });
		expect(await stream.next()).toEqual(updated(roomMessages(room.id)));
		await ada.call("chat.delete_message", { room_id: room.id, message_id: message.id });
		expect(await stream.next()).toEqual(updated(roomMessages(room.id)));

		// The room closes the socket of a removed member, so the stream ends at once, before its next check.
		await ada.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		expect(await stream.next()).toBe("closed");
	});

	// The index of the rooms in D1 can be behind a room. A room that refuses the caller must not stop the other feeds.
	it("leaves out a room that refuses the caller while the index still has the caller as a member", async () => {
		const { ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
		const { room: kept } = await ada.call("chat.create_room", { kind: "private", name: "Ops", member_ids: [bot.id] });
		await ada.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		// The row of the removed member is in the index again, as after a write to the index that failed.
		await env.DIRECTORY.prepare(
			"INSERT INTO chat_members (principal_id, room_id, role, last_read_seq) VALUES (?, ?, 'member', 0)",
		)
			.bind(bot.id, room.id)
			.run();

		const stream = await listen(bot.key, [roomMessages(room.id), roomMessages(kept.id), inbox(bot.id)]);
		expect(await stream.next()).toMatchObject({
			method: "notifications/subscriptions/acknowledged",
			params: { notifications: { resourceSubscriptions: [roomMessages(kept.id), inbox(bot.id)] } },
		});
		await ada.call("chat.post_message", { room_id: kept.id, text: "The other feeds work." });
		expect(await stream.next()).toEqual(updated(roomMessages(kept.id)));
		await stream.cancel();
	});

	// A feed that the room closes ends its stream, with all of its other feeds. So a new stream must not close a feed.
	it("leaves a room out of a new stream when the caller has too many sockets to it, and keeps the older streams", async () => {
		const { ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
		const streams: Awaited<ReturnType<typeof listen>>[] = [];
		for (let index = 0; index < CHAT_LIMITS.socketsPerMember; index++) {
			const stream = await listen(bot.key, [roomMessages(room.id)], {}, `sub-${index}`);
			expect(await stream.next()).toMatchObject({
				params: { notifications: { resourceSubscriptions: [roomMessages(room.id)] } },
			});
			streams.push(stream);
		}
		const extra = await listen(bot.key, [roomMessages(room.id), inbox(bot.id)], {}, "extra");
		expect(await extra.next()).toMatchObject({
			params: { notifications: { resourceSubscriptions: [inbox(bot.id)] } },
		});
		// A socket of the same agent that is not a feed has no socket to close: the room refuses it.
		expect((await upgradeRoomSocket(room.id, bearer(bot.key))).status).toBe(409);

		await ada.call("chat.post_message", { room_id: room.id, text: "Each older stream works." });
		for (const [index, stream] of streams.entries()) {
			expect(await stream.next()).toEqual(updated(roomMessages(room.id), `sub-${index}`));
			await stream.cancel();
		}
		await extra.cancel();
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

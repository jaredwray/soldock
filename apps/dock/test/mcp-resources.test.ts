import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	CHAT_LIMITS,
	EVENTS_LIMITS,
	EVENTS_SOCKET_CLOSE,
	EVENTS_SOCKET_PATH,
	UNTRUSTED_NOTICE,
} from "@asterra/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUED_EVENTS, MAX_STREAM_MS, RECHECK_MS } from "../src/mcp/listen.ts";
import {
	bearer,
	callTool,
	connectRoomSocket,
	drainOutbox,
	inject,
	mcp,
	modern,
	modernRequest,
	rawMessage,
	readSocket,
	readSse,
	request,
	seedOrg,
	sendMemberStates,
	setLegacyScopes,
	upgradeRoomSocket,
} from "./helpers.ts";

const inbox = (mailboxId: string) => `asterra://mail/${mailboxId}/inbox`;
const roomMessages = (roomId: string) => `asterra://chat/${roomId}/messages`;
const ROOMS = "asterra://chat/rooms";
const ADDRESSED = "asterra://chat/addressed";

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

/** A notification of a change. `change` is the facts of the change, for a resource whose feed gives them. */
const updated = (uri: string, id: string | number = "sub-1", change?: unknown) => ({
	jsonrpc: "2.0",
	method: "notifications/resources/updated",
	params: {
		uri,
		_meta: {
			"io.modelcontextprotocol/subscriptionId": id,
			...(change === undefined ? {} : { "asterra/change": change }),
		},
	},
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
		// Bot can send from the finance mailbox, but cannot read it. So its inbox is not a resource of Bot.
		await owner.call("directory.add_team_mailbox_member", {
			mailbox_id: finance.id,
			principal_id: bot.id,
			scopes: ["mail.send"],
		});

		const listed = (await modern(bot.key, "resources/list")).body?.result as Record<string, unknown>;
		expect(listed).toMatchObject({ resultType: "complete", cacheScope: "private" });
		expect(listed.resources).toEqual([
			expect.objectContaining({
				uri: inbox(bot.id),
				mimeType: "application/json",
				title: "Inbox of Billing Bot <bot@dock.test>",
			}),
			expect.objectContaining({ uri: inbox(support.id), title: "Inbox of support <support@dock.test>" }),
			// Each principal with chat.read has the resource of its rooms, also with no room.
			expect.objectContaining({ uri: ROOMS, title: "Your rooms" }),
			expect.objectContaining({ uri: ADDRESSED, title: "Messages for you" }),
		]);
		const templates = (await modern(bot.key, "resources/templates/list")).body?.result as Record<string, unknown>;
		expect(templates.resourceTemplates).toEqual([
			expect.objectContaining({ uriTemplate: "asterra://mail/{mailbox_id}/inbox", name: "mail.inbox" }),
			expect.objectContaining({ uriTemplate: "asterra://chat/{room_id}/messages", name: "chat.room" }),
			expect.objectContaining({ uriTemplate: "asterra://chat/rooms", name: "chat.rooms" }),
			expect.objectContaining({ uriTemplate: "asterra://chat/addressed", name: "chat.addressed" }),
			expect.objectContaining({ uriTemplate: "asterra://drive/{space_id}/items/{item_id}", name: "drive.item" }),
			expect.objectContaining({ uriTemplate: "asterra://drive/{drive_id}", name: "drive.space" }),
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
		const savedUri = `soldock://mail/${bot.id}/inbox`;
		const saved = await modern(bot.key, "resources/read", { uri: savedUri });
		expect(saved.body?.result).toMatchObject({
			contents: read.contents.map((content) => ({ ...content, uri: savedUri })),
		});
		expect(read.contents[0]?.text).toBe(UNTRUSTED_NOTICE);
		expect(JSON.parse(read.contents[1]?.text ?? "null")).toEqual(
			await bot.call("mail.list_threads", { query: "in:inbox" }),
		);

		// The read checks the mailbox as the operation does. Legacy clients get the not-found code of their protocol.
		const refused = await modern(bot.key, "resources/read", { uri: inbox(finance.id) });
		expect(refused.body?.error).toMatchObject({ code: -32602, data: { uri: inbox(finance.id), code: "forbidden" } });
		expect((await modern(bot.key, "resources/read", { uri: "asterra://mail/nope/inbox" })).body?.error).toMatchObject({
			code: -32602,
			message: "Resource not found",
		});
		expect((await mcp(bot.key, "resources/read", { uri: inbox(finance.id) })).body?.error).toMatchObject({
			code: -32002,
		});

		// An agent from before migration 0033 without mail.read on its account cannot read its own inbox. A
		// membership of a team mailbox can still give it an inbox, so the template stays.
		await setLegacyScopes(bot.id, ["drive.read"]);
		await owner.call("directory.remove_team_mailbox_member", { mailbox_id: support.id, principal_id: bot.id });
		const api_key = { secret: bot.key };
		// The list of the rooms of the caller stays: each room decides by its membership.
		const resources = (await modern(api_key.secret, "resources/list")).body?.result as { resources: { uri: string }[] };
		expect(resources.resources.map((resource) => resource.uri)).toEqual([ROOMS]);
		const legacy = (await modern(api_key.secret, "resources/templates/list")).body?.result as {
			resourceTemplates: { name: string }[];
		};
		expect(legacy.resourceTemplates.map((template) => template.name)).toEqual(
			expect.arrayContaining(["mail.inbox", "drive.item", "drive.space"]),
		);
		expect((await modern(api_key.secret, "resources/read", { uri: inbox(bot.id) })).body?.error).toMatchObject({
			code: -32602,
		});
		const own = await listen(api_key.secret, [inbox(bot.id)]);
		expect(await own.next()).toMatchObject({ params: { notifications: { resourceSubscriptions: [] } } });
		await own.cancel();
	});

	// The list of the Drive items names the own drive, where the account scopes decide. An agent from before
	// migration 0033 without drive.read has no such list. Each other kind still shows.
	it("lists the other resources of an agent whose account cannot read its own drive", async () => {
		const { bot } = await seedOrg();
		await setLegacyScopes(bot.id, ["account.read", "mail.read", "chat.read"]);
		const listed = await modern(bot.key, "resources/list");
		expect(listed.body?.error).toBeUndefined();
		const result = listed.body?.result as { resources: { uri: string }[] };
		expect(result.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([inbox(bot.id), ROOMS]));
	});

	it("lists the rooms of the caller, and reads the messages of one with the data of REST", async () => {
		const { ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
		const { room: dm } = await ada.call("chat.open_dm", { principal_id: bot.id });
		const { room: closed } = await ada.call("chat.create_room", { kind: "private", name: "Hiring" });
		await ada.call("chat.post_message", { room_id: room.id, text: "We ship on Friday." });
		// Ada made the changes, so the list of the bot gets them after the delay.
		await sendMemberStates(bot.id);

		const listed = (await modern(bot.key, "resources/list")).body?.result as { resources: Record<string, unknown>[] };
		expect(listed.resources.filter((resource) => String(resource.uri).startsWith("asterra://chat/"))).toEqual([
			expect.objectContaining({ uri: roomMessages(room.id), title: "Messages of #Launch" }),
			expect.objectContaining({ uri: roomMessages(dm.id), title: "Direct message with Ada Lovelace" }),
			expect.objectContaining({ uri: ROOMS, name: "chat.rooms", title: "Your rooms" }),
			expect.objectContaining({ uri: ADDRESSED, name: "chat.addressed", title: "Messages for you" }),
		]);
		// Parity: the resource of all rooms runs chat.list_rooms, so it returns what REST returns.
		const rooms = (await modern(bot.key, "resources/read", { uri: ROOMS })).body?.result as {
			contents: { text: string }[];
		};
		expect(JSON.parse(rooms.contents[0]?.text ?? "null")).toEqual(await bot.call("chat.list_rooms", { limit: 100 }));
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
			resources: [
				expect.objectContaining({ uri: inbox(bot.id) }),
				expect.objectContaining({ uri: ROOMS }),
				expect.objectContaining({ uri: ADDRESSED }),
			],
		});
	});
});

describe("MCP subscriptions/listen", () => {
	it("notifies a subscriber of new mail in its own inbox and its team inboxes, and of nothing else", async () => {
		const { owner, ada, bot, support, finance } = await seedTeams();
		// A member without mail.read cannot watch the inbox: a notification tells when mail arrives.
		await owner.call("directory.add_team_mailbox_member", {
			mailbox_id: finance.id,
			principal_id: bot.id,
			scopes: ["mail.send"],
		});
		// An alias with other percent-encoding names no resource, so one request cannot watch a mailbox many times.
		const alias = inbox(support.id).replace("tmb_", "%74mb_");
		const savedInbox = `soldock://mail/${bot.id}/inbox`;
		const stream = await listen(
			bot.key,
			[savedInbox, inbox(support.id), inbox(finance.id), "asterra://x", inbox(bot.id), inbox(support.id), alias],
			{ toolsListChanged: true },
		);
		// The acknowledgment comes first. It keeps only what the caller can watch, and gives no reason for the rest.
		expect(await stream.next()).toEqual({
			jsonrpc: "2.0",
			method: "notifications/subscriptions/acknowledged",
			params: {
				_meta: { "io.modelcontextprotocol/subscriptionId": "sub-1" },
				notifications: { resourceSubscriptions: [savedInbox, inbox(support.id)] },
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
		expect(await stream.next()).toEqual(updated(savedInbox));
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
		expect(await stream.next()).toEqual(updated(savedInbox));
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

		// Mail that the Screener holds sends nothing. When a person screens the sender in, the mail is new in
		// the inbox, and that sends one notification: the next one is for the inbox of Bot.
		await ada.call("mail.update_mailbox_settings", { mailbox_id: support.id, screener: "on" });
		await inject(
			rawMessage({ from: "stranger@new.example", to: "support@dock.test", subject: "Held" }),
			"support@dock.test",
		);
		await ada.call("mail.screen_sender", {
			mailbox_id: support.id,
			address: "stranger@new.example",
			decision: "in",
		});
		await inject(rawMessage({ from: "x@internet.example", to: "bot@dock.test", subject: "Again" }), "bot@dock.test");
		expect(await stream.next()).toEqual(updated(inbox(support.id)));
		expect(await stream.next()).toEqual(updated(savedInbox));

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

	// A notification tells when mail arrives, so a delegate needs mail.read in the grant, as a member does.
	it("lets a delegate with mail.read subscribe to the inbox of the mailbox of the person", async () => {
		const { owner, ada, bot } = await seedTeams();
		await ada.call("mail.set_delegate", { principal_id: bot.id, scopes: ["mail.read"] });
		await owner.call("mail.set_delegate", { principal_id: bot.id, scopes: ["mail.send"] });
		const stream = await listen(bot.key, [inbox(ada.id), inbox(owner.id)]);
		expect(await stream.next()).toMatchObject({
			params: { notifications: { resourceSubscriptions: [inbox(ada.id)] } },
		});
		await inject(rawMessage({ from: "cy@customer.example", to: "ada@dock.test", subject: "For Ada" }), "ada@dock.test");
		expect(await stream.next()).toEqual(updated(inbox(ada.id)));
		await stream.cancel();
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

		// Each notification has the facts of the change, so a client that has the version reads nothing.
		const facts = (message: { id: string; version: number }) => ({
			room_id: room.id,
			message_id: message.id,
			parent_id: null,
			author_id: ada.id,
			version: message.version,
		});
		const { message } = await ada.call("chat.post_message", { room_id: room.id, text: "We ship on Friday." });
		expect(await stream.next()).toEqual(updated(roomMessages(room.id), "sub-1", facts(message)));
		// A new name is no change of the messages: the next notification is the edit.
		await ada.call("chat.update_room", { room_id: room.id, name: "Launch week" });
		const { message: edited } = await ada.call("chat.edit_message", {
			room_id: room.id,
			message_id: message.id,
			text: "We ship on Monday.",
		});
		expect(edited.version).toBeGreaterThan(message.version);
		expect(await stream.next()).toEqual(updated(roomMessages(room.id), "sub-1", facts(edited)));
		await ada.call("chat.delete_message", { room_id: room.id, message_id: message.id });
		expect(await stream.next()).toEqual(
			updated(roomMessages(room.id), "sub-1", { ...facts(edited), version: edited.version + 1 }),
		);

		// The room closes the socket of a removed member, so the stream ends at once, before its next check.
		await ada.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		expect(await stream.next()).toBe("closed");
	});

	// An agent that answers after each notification must get no notification for its answer. Else each
	// answer starts a new turn of its model.
	it("sends a member no notification for its own changes of a room, and still sends them to its sockets", async () => {
		const { ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
		const { message: first } = await ada.call("chat.post_message", { room_id: room.id, text: "We ship on Friday." });
		const stream = await listen(bot.key, [roomMessages(room.id)]);
		expect(await stream.next()).toMatchObject({ method: "notifications/subscriptions/acknowledged" });
		// A socket of the same agent that is not a feed gets each event, as a second tab of a person does.
		const socket = await connectRoomSocket(room.id, bearer(bot.key));

		const { message: own } = await bot.call("chat.post_message", { room_id: room.id, text: "I am ready." });
		// A reply changes the first message of its thread too.
		await bot.call("chat.post_message", { room_id: room.id, text: "Noted.", parent_id: first.id });
		await bot.call("chat.add_reaction", { room_id: room.id, message_id: first.id, emoji: "👍" });
		await bot.call("chat.edit_message", { room_id: room.id, message_id: own.id, text: "I am ready now." });
		await bot.call("chat.delete_message", { room_id: room.id, message_id: own.id });
		const seen: unknown[] = [];
		for (let index = 0; index < 6; index++) seen.push(((await socket.next()) as { type: string }).type);
		expect(seen).toEqual(["message", "message", "reply", "message", "message", "message"]);

		// The change of a different member is the first notification of the stream, and the only one.
		const { message: thanks } = await ada.call("chat.post_message", { room_id: room.id, text: "Thank you." });
		expect(await stream.next()).toEqual(
			updated(roomMessages(room.id), "sub-1", expect.objectContaining({ message_id: thanks.id, author_id: ada.id })),
		);
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
		expect(await stream.next()).toMatchObject(updated(roomMessages(kept.id)));
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
			expect(await stream.next()).toMatchObject(updated(roomMessages(room.id), `sub-${index}`));
			await stream.cancel();
		}
		await extra.cancel();
	});

	it("notifies about each change of each room of the caller with one subscription, also a room that it joins later", async () => {
		const { ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
		const stream = await listen(bot.key, [ROOMS]);
		expect(await stream.next()).toMatchObject({
			method: "notifications/subscriptions/acknowledged",
			params: { notifications: { resourceSubscriptions: [ROOMS] } },
		});

		await ada.call("chat.post_message", { room_id: room.id, text: "We ship on Friday." });
		expect(await stream.next()).toEqual(updated(ROOMS));
		// A read marker changes the unread count of the list.
		await bot.call("chat.mark_read", { room_id: room.id });
		expect(await stream.next()).toEqual(updated(ROOMS));
		// A room that gets the agent as a member after the start of the stream: no new subscription.
		const { room: later } = await ada.call("chat.create_room", { kind: "public", name: "Town hall" });
		await ada.call("chat.add_members", { room_id: later.id, principal_ids: [bot.id] });
		expect(await stream.next()).toEqual(updated(ROOMS));
		// A room that the agent leaves.
		await bot.call("chat.remove_member", { room_id: later.id, principal_id: bot.id });
		expect(await stream.next()).toEqual(updated(ROOMS));
		await stream.cancel();
	});

	// An agent in a busy room must not start a turn of its model for each message of the room.
	it("notifies only about a change that is for the caller, in each of its rooms, with one subscription", async () => {
		const { owner, ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
		// The stream has its own key. The end of that key ends the stream, which shows each notification that waits.
		const { api_key } = await owner.call("account.create_api_key", { principal_id: bot.id, label: "Stream" });
		const stream = await listen(api_key.secret, [ADDRESSED]);
		expect(await stream.next()).toMatchObject({
			method: "notifications/subscriptions/acknowledged",
			params: { notifications: { resourceSubscriptions: [ADDRESSED] } },
		});
		/** Waits until the object of the agent has the state of the room after a message. */
		const arrived = (roomId: string, seq: number) =>
			vi.waitFor(
				async () =>
					expect((await bot.call("chat.list_rooms")).rooms).toContainEqual(
						expect.objectContaining({ id: roomId, last_seq: seq }),
					),
				{ timeout: 5000, interval: 50 },
			);

		// A message that names nobody, and a message of the agent, send nothing. A mention is the first notification.
		const plain = await ada.call("chat.post_message", { room_id: room.id, text: "We ship on Friday." });
		await arrived(room.id, plain.message.seq);
		const own = await bot.call("chat.post_message", { room_id: room.id, text: "I am ready." });
		await arrived(room.id, own.message.seq);
		// The notification has the facts of the change, with the reason, and no text of the message.
		const named = await ada.call("chat.post_message", { room_id: room.id, text: "@bot can you check the invoices?" });
		expect(await stream.next()).toEqual(
			updated(ADDRESSED, "sub-1", {
				room_id: room.id,
				event: "chat.message.created",
				reason: "mention",
				message_id: named.message.id,
				parent_id: null,
				author_id: ada.id,
				version: named.message.version,
				at: named.message.created_at,
			}),
		);
		// Parity: the read runs chat.list_addressed, so it returns what REST returns.
		const read = (await modern(bot.key, "resources/read", { uri: ADDRESSED })).body?.result as {
			contents: { mimeType: string; text: string }[];
		};
		expect(read.contents.map((content) => content.mimeType)).toEqual(["application/json"]);
		const listed = await bot.call("chat.list_addressed", {});
		expect(JSON.parse(read.contents[0]?.text ?? "null")).toEqual(listed);
		expect(listed.changes).toEqual([
			expect.objectContaining({ reason: "mention", message_id: named.message.id, version: named.message.version }),
		]);

		// A later message of the room that names nobody sends nothing, also though the room has a change for the agent.
		const later = await ada.call("chat.post_message", { room_id: room.id, text: "Thank you all." });
		await arrived(room.id, later.message.seq);
		// A direct message in a room from after the start of the stream: no new subscription.
		const { room: dm } = await owner.call("chat.open_dm", { principal_id: bot.id });
		const hello = await owner.call("chat.post_message", { room_id: dm.id, text: "Hello" });
		await arrived(dm.id, hello.message.seq);
		expect(await stream.next()).toEqual(
			updated(
				ADDRESSED,
				"sub-1",
				expect.objectContaining({ room_id: dm.id, reason: "dm", message_id: hello.message.id }),
			),
		);

		// The two notifications were the only ones: the end of the key ends the stream with no other one before.
		await owner.call("account.revoke_api_key", { key_id: api_key.id });
		expect(await stream.next()).toBe("closed");
	});

	// A feed that the object closes ends its stream, with all of its other feeds. So a socket must not close a feed.
	it("keeps the feed of a stream when the caller opens more events sockets than the limit, and refuses a new feed", async () => {
		const { ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
		// The room sends the state of the agent to its object 500 ms after the create, and each events socket
		// of the agent then gets chat.room. The room sends it now, so that event cannot come before the close
		// of the oldest socket below.
		const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
		await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0"),
		);
		await runDurableObjectAlarm(stub);
		const stream = await listen(bot.key, [ROOMS]);
		expect(await stream.next()).toMatchObject({ params: { notifications: { resourceSubscriptions: [ROOMS] } } });
		const open = async () => {
			const socket = readSocket(
				await request(EVENTS_SOCKET_PATH, { headers: { upgrade: "websocket", ...bearer(bot.key) } }),
			);
			expect(await socket.next()).toMatchObject({ type: "hello" });
			return socket;
		};
		const sockets = [];
		for (let index = 1; index < EVENTS_LIMITS.socketsPerPrincipal; index++) sockets.push(await open());
		// At the limit, a new socket closes the oldest socket that is not a feed.
		await open();
		expect(await sockets[0]?.next()).toEqual({ closed: EVENTS_SOCKET_CLOSE.replaced });
		// A new feed has no socket to close: the object refuses it, and the new stream leaves the resource out.
		const extra = await listen(bot.key, [ROOMS], {}, "extra");
		expect(await extra.next()).toMatchObject({ params: { notifications: { resourceSubscriptions: [] } } });
		await extra.cancel();

		await ada.call("chat.post_message", { room_id: room.id, text: "The first stream works." });
		expect(await stream.next()).toEqual(updated(ROOMS));
		await stream.cancel();
	});

	// A long-lived stream must not outlive the access that opened it.
	it("ends when the caller loses a mailbox or its credential, and after its longest life", async () => {
		const { owner, bot, support } = await seedTeams();
		const { api_key: second } = await owner.call("account.create_api_key", { principal_id: bot.id, label: "Second" });
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

	// A membership decides the access of an agent, and it can end at any time. A stream on a team mailbox checks
	// its access before each notification, so no notification follows the end, also within RECHECK_MS.
	it.each([
		["the membership ends", { remove: true }],
		["the membership loses mail.read", { remove: false }],
	] as const)("sends no notification of a team mailbox after %s", async (_name, { remove }) => {
		const { owner, bot, support } = await seedTeams();
		const stream = await listen(bot.key, [inbox(support.id)]);
		expect(await stream.next()).toMatchObject({ method: "notifications/subscriptions/acknowledged" });
		const mail = (subject: string) =>
			inject(rawMessage({ from: "x@internet.example", to: "support@dock.test", subject }), "support@dock.test");
		await mail("First");
		expect(await stream.next()).toEqual(updated(inbox(support.id)));
		if (remove) {
			await owner.call("directory.remove_team_mailbox_member", { mailbox_id: support.id, principal_id: bot.id });
		} else {
			await owner.call("directory.add_team_mailbox_member", {
				mailbox_id: support.id,
				principal_id: bot.id,
				scopes: ["mail.send"],
			});
		}
		await mail("Second");
		expect(await stream.next()).toBe("closed");
		await vi.waitFor(async () => expect(await watchSockets(support.id)).toBe(0));
	});
});

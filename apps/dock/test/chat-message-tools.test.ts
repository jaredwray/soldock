import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { textBody } from "../src/chat/body.ts";
import { api, codeOf, seedOrg } from "./helpers.ts";

describe("message tools", () => {
	it("shares pins, keeps bookmarks and reminders private, and reads only current messages", async () => {
		const { owner, ada, bot } = await seedOrg();
		const { room } = await owner.call("chat.create_room", { kind: "private", name: "Review", member_ids: [ada.id] });
		const room_id = room.id;
		const { message } = await owner.call("chat.post_message", { room_id, text: "Review the release" });
		const ref = { room_id, message_id: message.id };
		await ada.call("chat.pin_message", { ...ref, pinned: true });
		await ada.call("chat.save_message", { ...ref, saved: true });
		await ada.call("chat.set_reminder", { ...ref, remind_at: new Date(Date.now() + 60_000).toISOString() });
		expect((await owner.call("chat.list_pins", { room_id })).messages.map((m) => m.id)).toEqual([message.id]);
		expect(await codeOf(bot.call("chat.pin_message", { ...ref, pinned: false }))).toBe("not_found");
		expect((await owner.call("chat.list_saved_messages")).messages).toEqual([]);
		expect((await ada.call("chat.list_saved_messages")).messages[0]?.id).toBe(message.id);
		expect((await ada.call("chat.list_reminders", { view: "all" })).reminders).toHaveLength(1);
		expect((await ada.call("chat.list_reminders")).reminders).toHaveLength(0);
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
		await runInDurableObject(principal, (_instance, state) => {
			state.storage.sql.exec("UPDATE chat_marks SET at = 0 WHERE kind = 'reminder'");
		});
		expect((await ada.call("chat.list_reminders")).reminders[0]?.message.id).toBe(message.id);
		await owner.call("chat.remove_member", { room_id, principal_id: ada.id });
		expect((await ada.call("chat.list_saved_messages")).messages).toEqual([]);
		expect((await ada.call("chat.list_reminders", { view: "all" })).reminders).toEqual([]);
		await owner.call("chat.delete_message", ref);
		expect((await owner.call("chat.list_pins", { room_id })).messages).toEqual([]);
	});

	it("rejects draft reads and writes when another tab replaced the editor's account", async () => {
		const { owner, ada } = await seedOrg();
		const { room } = await owner.call("chat.create_room", { kind: "private", name: "Drafts", member_ids: [ada.id] });
		const target = { room_id: room.id, expected_principal_id: ada.id };
		const local = { ...target, revision: 0, body: textBody("Private to Ada") };
		expect(await codeOf(owner.call("chat.set_draft", local))).toBe("conflict");
		const saved = await ada.call("chat.set_draft", local);
		expect(await ada.call("chat.get_draft", target)).toEqual(saved);
		expect(await codeOf(owner.call("chat.get_draft", target))).toBe("conflict");
		expect(await owner.call("chat.get_draft", { room_id: room.id })).toEqual({ body: null, revision: 0 });
	});

	it("keeps distinct room and thread drafts and detects stale device writes after a clear", async () => {
		const { ada, bot } = await seedOrg();
		const { room } = await ada.call("chat.create_room", { kind: "private", name: "Draft", member_ids: [bot.id] });
		const room_id = room.id;
		const { message } = await bot.call("chat.post_message", { room_id, text: "Reply here" });
		const thread = { room_id, parent_id: message.id };
		const saved = await ada.call("chat.set_draft", { ...thread, revision: 0, body: textBody("reply") });
		expect(await ada.call("chat.get_draft", thread)).toEqual(saved);
		expect(await bot.call("chat.get_draft", thread)).toEqual({ body: null, revision: 0 });
		expect(await ada.call("chat.get_draft", { room_id })).toEqual({ body: null, revision: 0 });
		const clear = await ada.call("chat.set_draft", { ...thread, revision: saved.revision, body: null });
		expect(
			await codeOf(ada.call("chat.set_draft", { ...thread, revision: saved.revision, body: textBody("stale") })),
		).toBe("conflict");
		expect(await ada.call("chat.get_draft", thread)).toEqual(clear);
	});

	it("postpones a scheduled message while its author is archived and delivers it once after restoration", async () => {
		const { owner, bot } = await seedOrg();
		const { room } = await owner.call("chat.create_room", { kind: "private", name: "Later", member_ids: [bot.id] });
		const room_id = room.id;
		const { message_id } = await bot.call("chat.schedule_message", {
			room_id,
			body: textBody("Send after restoration"),
			send_at: new Date(Date.now() + 60_000).toISOString(),
			idempotency_key: "restore",
		});
		await owner.call("directory.archive_principal", { principal_id: bot.id });
		const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room_id));
		const makeDue = () =>
			runInDurableObject(stub, (_instance, state) => {
				state.storage.sql.exec(
					"UPDATE scheduled_messages SET send_at = ?, next_attempt_at = 0",
					Date.now() - 86_400_000,
				);
			});
		await makeDue();
		const before = Date.now();
		await runDurableObjectAlarm(stub);
		const pending = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ message_id: string; next_attempt_at: number }>(
					"SELECT message_id, next_attempt_at FROM scheduled_messages",
				)
				.one(),
		);
		expect(pending.message_id).toBe(message_id);
		expect(pending.next_attempt_at).toBeGreaterThanOrEqual(before + 3_600_000);
		expect(pending.next_attempt_at).toBeLessThanOrEqual(Date.now() + 3_600_000);
		expect((await owner.call("chat.list_messages", { room_id })).messages).toEqual([]);
		await owner.call("directory.restore_principal", { principal_id: bot.id });
		await makeDue();
		await runDurableObjectAlarm(stub);
		await runDurableObjectAlarm(stub);
		expect((await owner.call("chat.list_messages", { room_id })).messages.map((m) => m.id)).toEqual([message_id]);
		expect((await bot.call("chat.list_scheduled_messages", { room_id })).messages).toEqual([]);
	});

	it("sends each scheduled message once and cancels sends for revoked credentials", async () => {
		const { owner, ada } = await seedOrg();
		const { room } = await owner.call("chat.create_room", { kind: "private", name: "Later", member_ids: [ada.id] });
		const room_id = room.id;
		const input = {
			room_id,
			body: textBody("Schedule me"),
			send_at: new Date(Date.now() + 86400_000).toISOString(),
			idempotency_key: "one",
		};
		await owner.call("chat.set_room_policy", { room_id, posting: "owners" });
		expect(await codeOf(ada.call("chat.schedule_message", input))).toBe("forbidden");
		await owner.call("chat.set_room_policy", { room_id, posting: "members" });
		const first = await owner.call("chat.schedule_message", input);
		expect(await owner.call("chat.schedule_message", input)).toEqual(first);
		expect(await codeOf(owner.call("chat.schedule_message", { ...input, body: textBody("changed") }))).toBe("conflict");
		const canceled = await owner.call("chat.schedule_message", { ...input, idempotency_key: "two" });
		expect(await ada.call("chat.cancel_scheduled_message", { room_id, ...canceled })).toEqual({ canceled: false });
		expect(await owner.call("chat.cancel_scheduled_message", { room_id, ...canceled })).toEqual({ canceled: true });
		const { api_key } = await ada.call("account.create_api_key", { label: "scheduler", scopes: ["chat.write"] });
		await api(api_key.secret)("chat.schedule_message", input);
		await ada.call("account.revoke_api_key", { key_id: api_key.id });
		expect((await owner.call("chat.list_messages", { room_id })).messages).toEqual([]);
		const { message: unread } = await ada.call("chat.post_message", { room_id, text: "Read me later" });
		await owner.call("chat.schedule_message", { ...input, parent_id: unread.id, idempotency_key: "reply" });
		await ada.call("chat.post_message", { room_id, parent_id: unread.id, text: "An intervening reply" });
		const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room_id));
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec("UPDATE scheduled_messages SET next_attempt_at = 0, send_at = 0");
		});
		await runDurableObjectAlarm(stub);
		expect((await owner.call("chat.list_messages", { room_id })).messages.map((m) => m.id)).toEqual([
			unread.id,
			first.message_id,
		]);
		expect((await owner.call("chat.get_room", { room_id })).room.unread_count).toBe(1);
		expect((await owner.call("chat.list_replies", { room_id, message_id: unread.id })).follow.unread_count).toBe(1);
		expect((await owner.call("chat.list_scheduled_messages", { room_id })).messages).toEqual([]);
		expect((await ada.call("chat.list_scheduled_messages", { room_id })).messages).toEqual([]);
	});

	it("checks both rooms on forward, preserves attribution and suppresses copied mentions", async () => {
		const { ada, owner, bot } = await seedOrg();
		const { room: source } = await ada.call("chat.create_room", {
			kind: "private",
			name: "Source",
			member_ids: [owner.id],
		});
		const { room: destination } = await owner.call("chat.create_room", {
			kind: "private",
			name: "Destination",
			member_ids: [bot.id],
		});
		const { message } = await ada.call("chat.post_message", { room_id: source.id, text: "Hello @channel" });
		const forward = {
			room_id: source.id,
			message_id: message.id,
			destination_room_id: destination.id,
			idempotency_key: "copy",
		};
		expect(await codeOf(ada.call("chat.forward_message", forward))).toBe("not_found");
		expect(await codeOf(bot.call("chat.forward_message", forward))).toBe("not_found");
		const result = await owner.call("chat.forward_message", forward);
		expect(result.message).toMatchObject({
			text: message.text,
			group_mentions: [],
			forwarded_from: { room_id: source.id, seq: message.seq, author: message.author },
		});
		await ada.call("chat.delete_message", { room_id: source.id, message_id: message.id });
		expect((await owner.call("chat.forward_message", forward)).message.id).toBe(result.message.id);
		expect((await bot.call("chat.list_messages", { room_id: destination.id })).messages.map((m) => m.id)).toEqual([
			result.message.id,
		]);
	});
});

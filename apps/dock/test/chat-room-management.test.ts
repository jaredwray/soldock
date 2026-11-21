import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { codeOf, restartLegacyRoom, seedOrg } from "./helpers.ts";

it("opens one group direct message for the same participants in any order", async () => {
	const { owner, ada, bot } = await seedOrg();
	const [first, second] = await Promise.all([
		owner.call("chat.open_group_dm", { principal_ids: [bot.id, ada.id] }),
		bot.call("chat.open_group_dm", { principal_ids: [ada.id, owner.id] }),
	]);
	expect(first.room.id).toBe(second.room.id);
	expect([first.created, second.created].sort()).toEqual([false, true]);
	expect(first.room).toMatchObject({ kind: "dm", peer: null, member_count: 3 });
	expect(first.room.name).toContain("Billing Bot");
	const pair = await ada.call("chat.open_dm", { principal_id: owner.id });
	expect(pair.room.id).not.toBe(first.room.id);
	const retention = { room_id: first.room.id, retention_days: 30 };
	expect(await codeOf(bot.call("chat.set_room_policy", retention))).toBe("forbidden");
	expect((await owner.call("chat.set_room_policy", retention)).retention_days).toBe(30);
	expect(await codeOf(owner.call("chat.set_room_policy", { ...retention, archived: true }))).toBe("invalid");
	const otherPair = await ada.call("chat.open_dm", { principal_id: bot.id });
	expect(await codeOf(owner.call("chat.set_room_policy", { ...retention, room_id: otherPair.room.id }))).toBe(
		"not_found",
	);
	expect(await codeOf(ada.call("chat.open_group_dm", { principal_ids: [owner.id, owner.id] }))).toBe("invalid");
});

it("upgrades a notifications-era room while preserving its messages and member typing state", async () => {
	const { owner } = await seedOrg();
	const { room } = await owner.call("chat.create_room", { kind: "public", name: "Release" });
	const room_id = room.id;
	const { message } = await owner.call("chat.post_message", { room_id, text: "Existing message" });
	const typedAt = 12345;
	await restartLegacyRoom(room_id, 16, (sql) => {
		sql.exec("UPDATE members SET last_typed_at = ? WHERE principal_id = ?", typedAt, owner.id);
	});
	expect(await owner.call("chat.get_room_policy", { room_id })).toEqual({
		archived: false,
		posting: "members",
		retention_days: null,
	});
	expect((await owner.call("chat.list_messages", { room_id })).messages[0]?.id).toBe(message.id);
	const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room_id));
	const member = await runInDurableObject(stub, (_instance, state) =>
		state.storage.sql.exec("SELECT last_typed_at FROM members WHERE principal_id = ?", owner.id).one(),
	);
	expect(member.last_typed_at).toBe(typedAt);
});

it("enforces the posting rule in the room, hides an archive, and revokes access on deletion", async () => {
	const { owner, ada, bot } = await seedOrg();
	const { room } = await owner.call("chat.create_room", { kind: "public", name: "Release", member_ids: [ada.id] });
	const room_id = room.id;
	const { message } = await owner.call("chat.post_message", { room_id, text: "Review" });
	expect(await codeOf(ada.call("chat.set_room_policy", { room_id, posting: "owners" }))).toBe("forbidden");
	await owner.call("chat.set_room_policy", { room_id, posting: "owners" });
	expect(await codeOf(ada.call("chat.post_message", { room_id, parent_id: message.id, text: "Reply" }))).toBe(
		"forbidden",
	);
	await owner.call("chat.set_room_policy", { room_id, archived: true });
	expect((await bot.call("chat.list_rooms", { view: "public" })).rooms).toHaveLength(0);
	expect(await codeOf(bot.call("chat.join_room", { room_id }))).toBe("not_found");
	expect(await codeOf(owner.call("chat.post_message", { room_id, text: "Later" }))).toBe("conflict");
	expect((await ada.call("chat.get_room", { room_id })).policy).toMatchObject({ archived: true, posting: "owners" });
	await owner.call("chat.set_room_policy", { room_id, archived: false });
	expect((await bot.call("chat.join_room", { room_id })).room.role).toBe("member");
	await owner.call("chat.delete_room", { room_id });
	expect(await codeOf(owner.call("chat.get_room", { room_id }))).toBe("not_found");
	expect(await codeOf(ada.call("chat.list_messages", { room_id }))).toBe("not_found");
	expect((await bot.call("chat.list_rooms", { view: "public" })).rooms).toHaveLength(0);
	const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room_id));
	await vi.waitFor(
		async () => {
			await runDurableObjectAlarm(stub);
			const storage = await runInDurableObject(stub, (_room, state) =>
				state.storage.sql.exec("SELECT id FROM messages LIMIT 1").toArray(),
			);
			expect(storage).toHaveLength(0);
		},
		{ timeout: 10000, interval: 100 },
	);
	// A preview fetch can finish after the last batch removes the messages.
	const key = `chat/${room_id}/${message.id}/link-late`;
	await env.BLOBS.put(key, "image");
	await stub.setLinkPreviews(message.id, [
		{
			url: "https://example.org",
			facts: {
				title: null,
				description: null,
				site_name: null,
				image: { key, type: "image/png", size: 5, width: 1, height: 1 },
			},
		},
	]);
	expect(await env.BLOBS.head(key)).toBeNull();
});

it("exports replies with stable pages and checks the owner and membership on every call", async () => {
	const { owner, ada, bot } = await seedOrg();
	const { room } = await ada.call("chat.create_room", { kind: "private", name: "Budget" });
	const room_id = room.id;
	expect(await codeOf(owner.call("chat.export_room", { room_id }))).toBe("not_found");
	expect(await codeOf(ada.call("chat.export_room", { room_id }))).toBe("forbidden");
	expect(await codeOf(bot.call("chat.export_room", { room_id }))).toBe("forbidden");
	await ada.call("chat.add_members", { room_id, principal_ids: [owner.id] });
	const { message } = await ada.call("chat.post_message", { room_id, text: "Plan" });
	await ada.call("chat.post_message", { room_id, parent_id: message.id, text: "Reply" });
	const first = await owner.call("chat.export_room", { room_id, limit: 1 });
	expect(first.messages.map((message) => message.text)).toEqual(["Plan"]);
	await ada.call("chat.post_message", { room_id, text: "Written during export" });
	const second = await owner.call("chat.export_room", {
		room_id,
		after: first.next_after as number,
		through: first.through,
	});
	expect(second.messages.map((message) => message.text)).toEqual(["Reply"]);
	expect(second.next_after).toBeNull();
	await ada.call("chat.remove_member", { room_id, principal_id: owner.id });
	expect(await codeOf(owner.call("chat.export_room", { room_id, after: first.next_after as number }))).toBe(
		"not_found",
	);
});

it("applies retention to earlier versions and search while retaining newer messages", async () => {
	const { owner } = await seedOrg();
	const { room } = await owner.call("chat.create_room", { kind: "private", name: "History" });
	const room_id = room.id;
	const { message } = await owner.call("chat.post_message", { room_id, text: "Before" });
	await owner.call("chat.edit_message", { room_id, message_id: message.id, text: "After" });
	await owner.call("chat.post_message", { room_id, text: "Keep" });
	const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room_id));
	await runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE messages SET created_at = 0 WHERE id = ?", message.id);
	});
	await owner.call("chat.set_room_policy", { room_id, retention_days: 1 });
	await vi.waitFor(async () => {
		await runDurableObjectAlarm(stub);
		expect((await owner.call("chat.export_room", { room_id })).messages.map((row) => row.text)).toEqual(["Keep"]);
	});
	expect((await owner.call("chat.search_messages", { room_id, query: "After" })).results).toHaveLength(0);
	expect((await owner.call("chat.list_message_edits", { room_id, message_id: message.id })).edits).toHaveLength(0);
});

it("repairs a private room after deletion of its owner without granting its contents to the administrator", async () => {
	const { owner, ada, bot } = await seedOrg();
	const { room } = await bot.call("chat.create_room", { kind: "private", name: "Invoices" });
	const room_id = room.id;
	expect(await codeOf(ada.call("chat.admin_list_rooms", {}))).toBe("forbidden");
	expect((await owner.call("chat.admin_list_rooms", {})).rooms[0]?.id).toBe(room_id);
	expect(await codeOf(owner.call("chat.admin_remove_deleted", { room_id, principal_id: bot.id }))).toBe("invalid");
	expect(await codeOf(owner.call("chat.admin_assign_owner", { room_id, principal_id: ada.id }))).toBe("conflict");
	const dm = await ada.call("chat.open_dm", { principal_id: bot.id });
	await owner.call("directory.delete_principal", { principal_id: bot.id });
	expect((await owner.call("chat.admin_room_members", { room_id })).members[0]).toMatchObject({
		principal_id: bot.id,
		deleted: true,
	});
	const first = await owner.call("chat.admin_cleanup_principal", { principal_id: bot.id, limit: 1 });
	expect(first).toMatchObject({ removed: 1, next_cursor: dm.room.id });
	expect(
		await owner.call("chat.admin_cleanup_principal", { principal_id: bot.id, cursor: first.next_cursor as string }),
	).toEqual({ removed: 1, next_cursor: null });
	expect(await owner.call("chat.admin_remove_deleted", { room_id, principal_id: bot.id })).toEqual({ removed: false });
	await owner.call("chat.admin_assign_owner", { room_id, principal_id: ada.id });
	expect((await ada.call("chat.get_room", { room_id })).room.role).toBe("owner");
	expect(await codeOf(owner.call("chat.list_messages", { room_id }))).toBe("not_found");
});

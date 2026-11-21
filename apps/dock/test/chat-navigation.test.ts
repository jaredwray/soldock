import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { codeOf, seedOrg } from "./helpers.ts";

it("keeps separate activity entries and removes stale entries when access or a reaction ends", async () => {
	const { owner, ada, bot } = await seedOrg();
	const { room } = await owner.call("chat.create_room", {
		kind: "private",
		name: "Planning",
		member_ids: [ada.id, bot.id],
	});
	const target = { room_id: room.id };
	const { message: parent } = await bot.call("chat.post_message", { ...target, text: "Release plan" });
	await ada.call("chat.post_message", { ...target, text: "@bot please review" });
	const { message: reply } = await ada.call("chat.post_message", { ...target, text: "Ready", parent_id: parent.id });
	const reaction = { ...target, message_id: parent.id, emoji: "👍" };
	await owner.call("chat.add_reaction", reaction);
	await owner.call("chat.add_reaction", reaction);
	const feed = () => bot.call("chat.list_activity", {});
	await vi.waitFor(
		async () => expect((await feed()).activity.map((entry) => entry.kind)).toEqual(["reaction", "reply", "mention"]),
		{ timeout: 5000 },
	);
	const page = await bot.call("chat.list_activity", { limit: 1 });
	expect(page.activity[0]).toMatchObject({ emoji: "👍", seq: parent.seq });
	const older = await bot.call("chat.list_activity", { cursor: page.next_cursor as string });
	expect(older.activity[0]).toMatchObject({ kind: "reply", parent_seq: parent.seq, seq: reply.seq });
	expect(await codeOf(bot.call("chat.list_activity", { cursor: "wrong" }))).toBe("invalid");
	await owner.call("chat.remove_reaction", reaction);
	expect((await feed()).activity.map((entry) => entry.kind)).toEqual(["reply", "mention"]);
	const { message: edited } = await ada.call("chat.post_message", { ...target, text: "A note" });
	await ada.call("chat.edit_message", { ...target, message_id: edited.id, text: "@bot a note" });
	await vi.waitFor(async () => expect((await feed()).activity[0]).toMatchObject({ seq: edited.seq, kind: "mention" }), {
		timeout: 5000,
	});
	await ada.call("chat.edit_message", { ...target, message_id: edited.id, text: "A note" });
	expect((await feed()).activity.some((entry) => entry.seq === edited.seq)).toBe(false);
	await owner.call("chat.remove_member", { ...target, principal_id: bot.id });
	expect((await feed()).activity).toEqual([]);
});

it("keeps each caller's sections private and drops a private room at removal", async () => {
	const { owner, ada, bot } = await seedOrg();
	const { room } = await owner.call("chat.create_room", { kind: "private", name: "Design", member_ids: [bot.id] });
	const target = { room_id: room.id, section: "Work" };
	await bot.call("chat.set_room_section", target);
	expect((await bot.call("chat.list_sections", {})).sections).toMatchObject([
		{ name: "Work", rooms: [{ id: room.id }] },
	]);
	expect((await owner.call("chat.list_sections", {})).sections).toEqual([]);
	expect(await codeOf(ada.call("chat.set_room_section", target))).toBe("not_found");
	await bot.call("chat.set_room_section", { ...target, section: null });
	expect((await bot.call("chat.list_sections", {})).sections).toEqual([]);
	await bot.call("chat.set_room_section", target);
	await owner.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
	expect((await bot.call("chat.list_sections", {})).sections).toEqual([]);
});

it("clears saved messages, reminders and sections when a rejoin arrives before the leave", async () => {
	const { owner, ada } = await seedOrg();
	const { room } = await owner.call("chat.create_room", { kind: "private", name: "Design", member_ids: [ada.id] });
	const { message } = await owner.call("chat.post_message", { room_id: room.id, text: "Milestone" });
	const source = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
	const before = await source.stateFor(ada.id);
	await owner.call("chat.remove_member", { room_id: room.id, principal_id: ada.id });
	await owner.call("chat.add_members", { room_id: room.id, principal_ids: [ada.id] });
	const after = await source.stateFor(ada.id);
	if (!before?.membership_id || !after?.membership_id) throw new Error("Expected two joined states");

	const principal = env.PRINCIPAL.get(env.PRINCIPAL.newUniqueId());
	expect(await principal.setRoomSection(before, "Work")).toBe("ok");
	await principal.setChatMark("saved", room.id, message.id, Date.now());
	await principal.setChatMark("reminder", room.id, message.id, Date.now());
	await principal.applyChatRoomStates([after]);
	expect(await principal.setRoomSection(before, "Work")).toBe("not_found");
	expect(await principal.chatSectionRefs(null, 10)).toEqual([]);
	for (const kind of ["saved", "reminder"] as const) {
		expect(await principal.chatMarkPage(kind, Number.MAX_SAFE_INTEGER, 10, false)).toEqual([]);
	}
});

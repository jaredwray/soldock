import { expect, it } from "vitest";
import { api, codeOf, seedOrg } from "./helpers.ts";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQyvf5DwADkQHlohpSOwAAAABJRU5ErkJggg==";

it("keeps custom emoji in the organization and lets members remove old reactions after an emoji goes away", async () => {
	const { owner, ada, bot } = await seedOrg();
	const image = { name: "ship", content_base64: pixel };
	for (const caller of [ada, bot]) expect(await codeOf(caller.call("chat.create_emoji", image))).toBe("forbidden");
	expect(await codeOf(owner.call("chat.create_emoji", { ...image, content_base64: btoa("<svg/>") }))).toBe("invalid");
	await owner.call("chat.create_emoji", image);
	expect(await codeOf(owner.call("chat.create_emoji", image))).toBe("conflict");
	expect(await bot.call("chat.list_emoji")).toEqual({ names: ["ship"] });
	expect(await bot.call("chat.get_emoji", { name: "ship" })).toEqual({ content_base64: pixel });
	const { room } = await owner.call("chat.create_room", { kind: "private", name: "Launch", member_ids: [bot.id] });
	const { message } = await bot.call("chat.post_message", { room_id: room.id, text: "Ready :ship:" });
	const reaction = { room_id: room.id, message_id: message.id, emoji: ":ship:" };
	expect((await bot.call("chat.add_reaction", reaction)).message.reactions[0]?.emoji).toBe(":ship:");
	await owner.call("chat.delete_emoji", { name: "ship" });
	expect(await codeOf(bot.call("chat.add_reaction", reaction))).toBe("invalid");
	expect((await bot.call("chat.remove_reaction", reaction)).message.reactions).toEqual([]);
});

it("checks membership and catalog access before revealing whether a custom reaction exists", async () => {
	const { owner, ada } = await seedOrg();
	await owner.call("chat.create_emoji", { name: "ship", content_base64: pixel });
	const { room } = await owner.call("chat.create_room", { kind: "private", name: "Launch" });
	const { message } = await owner.call("chat.post_message", { room_id: room.id, text: "Ready" });
	const target = { room_id: room.id, message_id: message.id };
	const { api_key } = await ada.call("account.create_api_key", { label: "Reactions", scopes: ["chat.write"] });
	const writeOnly = api(api_key.secret);
	for (const emoji of [":ship:", ":unknown:"]) {
		expect(await codeOf(writeOnly("chat.add_reaction", { ...target, emoji }))).toBe("not_found");
		expect(await codeOf(ada.call("chat.add_reaction", { ...target, emoji }))).toBe("not_found");
	}

	await owner.call("chat.add_members", { room_id: room.id, principal_ids: [ada.id] });
	for (const emoji of [":ship:", ":unknown:"]) {
		expect(await codeOf(writeOnly("chat.add_reaction", { ...target, emoji }))).toBe("forbidden");
	}
	expect((await writeOnly("chat.add_reaction", { ...target, emoji: "👍" })).message.reactions[0]?.emoji).toBe("👍");
	await ada.call("chat.add_reaction", { ...target, emoji: ":ship:" });
	await owner.call("chat.delete_emoji", { name: "ship" });
	expect((await writeOnly("chat.remove_reaction", { ...target, emoji: ":ship:" })).message.reactions).toHaveLength(1);
});

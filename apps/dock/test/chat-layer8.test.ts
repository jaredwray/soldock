import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Actor, api, bearer, callTool, codeOf, createActor, PASSWORD, request, seedOrg } from "./helpers.ts";

let owner: Actor;
let ada: Actor;
let bot: Actor;

beforeEach(async () => {
	({ owner, ada, bot } = await seedOrg());
});

afterEach(() => {
	vi.useRealTimers();
});

const soon = (check: () => Promise<void>) => vi.waitFor(check, { timeout: 5000, interval: 50 });

const createRoom = async (actor: Actor, kind: "public" | "private", name: string, member_ids: string[] = []) =>
	(await actor.call("chat.create_room", { kind, name, member_ids })).room;

const post = async (actor: Actor, room_id: string, text: string) =>
	(await actor.call("chat.post_message", { room_id, text })).message;

/** Minimal valid 1x1 transparent PNG (67 bytes), base64-encoded. */
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAEAAAABAAUAAQ0KLbQAAAAASUVORK5CYII=";

async function signSlackWebhook(secret: string, timestamp: number, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
	const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `v0=${hex}`;
}

describe("activity feed and sidebar sections", () => {
	it("records mentions, thread replies, and reactions in Activity and marks them read", async () => {
		const room = await createRoom(ada, "private", "Launch", [bot.id]);
		const parent = await post(ada, room.id, "Plan for @bot");
		await soon(async () => {
			const feed = await bot.call("chat.list_activity");
			expect(feed.unread_count).toBe(1);
			expect(feed.items[0]).toMatchObject({ kind: "mention", room_id: room.id, message_id: parent.id, read_at: null });
		});

		await bot.call("chat.post_message", { room_id: room.id, parent_id: parent.id, text: "Looks good" });
		await bot.call("chat.add_reaction", { room_id: room.id, message_id: parent.id, emoji: "👍" });
		await soon(async () => {
			const feed = await ada.call("chat.list_activity");
			expect(feed.unread_count).toBe(2);
			expect(feed.items.map((i) => i.kind).sort()).toEqual(["reaction", "reply"]);
		});

		const before = await ada.call("chat.list_activity");
		const firstActivity = before.items[0];
		expect(firstActivity).toBeDefined();
		const one = await ada.call("chat.mark_activity_read", { activity_id: firstActivity?.id });
		expect(one.unread_count).toBe(1);
		const all = await ada.call("chat.mark_activity_read", {});
		expect(all.unread_count).toBe(0);
		expect((await ada.call("chat.list_activity", { filter: "unread" })).items).toEqual([]);

		// Deleting a private message removes its preview from recipients' Activity feeds.
		await ada.call("chat.delete_message", { room_id: room.id, message_id: parent.id });
		const botAfterDelete = await bot.call("chat.list_activity");
		expect(botAfterDelete.items.some((i) => i.message_id === parent.id)).toBe(false);
		expect(botAfterDelete.unread_count).toBe(0);

		// Leaving a private room cancels queued activity delivery and removes previews.
		const secret = await post(ada, room.id, "Secret for @bot before removal");
		await bot.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		await runDurableObjectAlarm(env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id)));
		const botAfterLeave = await bot.call("chat.list_activity");
		expect(botAfterLeave.items.some((i) => i.message_id === secret.id)).toBe(false);
	});

	it("creates, updates, assigns rooms to, and deletes custom sidebar sections", async () => {
		const room = await createRoom(ada, "public", "Design");
		const created = (await ada.call("chat.create_section", { name: "Priority" })).section;
		expect(created).toMatchObject({ name: "Priority", position: 0, room_ids: [] });

		await ada.call("chat.set_room_section", { room_id: room.id, section_id: created.id });
		const updated = (await ada.call("chat.update_section", { section_id: created.id, name: "Top", position: 0 }))
			.section;
		expect(updated).toMatchObject({ name: "Top", room_ids: [room.id] });

		const listed = await ada.call("chat.list_sections");
		expect(listed.sections).toHaveLength(1);
		expect(listed.sections[0]?.room_ids).toEqual([room.id]);

		// Non-member cannot assign a private room they are not in.
		const secret = await createRoom(owner, "private", "Exec");
		expect(await codeOf(ada.call("chat.set_room_section", { room_id: secret.id, section_id: created.id }))).toBe(
			"not_found",
		);

		await ada.call("chat.delete_section", { section_id: created.id });
		expect((await ada.call("chat.list_sections")).sections).toEqual([]);
	});
});

describe("pins, saved messages, drafts, scheduled messages, and reminders", () => {
	it("pins and unpins messages, surfacing pin state on messages and pin_count on get_room", async () => {
		const room = await createRoom(ada, "private", "Ops", [bot.id]);
		const msg = await post(ada, room.id, "Runbook link");

		const pinned = await bot.call("chat.pin_message", { room_id: room.id, message_id: msg.id });
		expect(pinned.pin.message.id).toBe(msg.id);
		// Re-pinning is idempotent.
		await bot.call("chat.pin_message", { room_id: room.id, message_id: msg.id });

		const pins = await ada.call("chat.list_pins", { room_id: room.id });
		expect(pins.pins).toHaveLength(1);
		expect((await ada.call("chat.get_room", { room_id: room.id })).pin_count).toBe(1);
		expect((await ada.call("chat.list_messages", { room_id: room.id })).messages[0]?.pinned).toBe(true);

		expect(await codeOf(owner.call("chat.list_pins", { room_id: room.id }))).toBe("not_found");

		await ada.call("chat.unpin_message", { room_id: room.id, message_id: msg.id });
		expect((await ada.call("chat.list_pins", { room_id: room.id })).pins).toEqual([]);
		expect((await ada.call("chat.get_room", { room_id: room.id })).pin_count).toBe(0);
	});

	it("saves messages and hides ones that are deleted or in rooms the caller left", async () => {
		const room = await createRoom(ada, "public", "General", [bot.id]);
		const m1 = await post(ada, room.id, "Keep this");
		const m2 = await post(ada, room.id, "Delete this");

		await bot.call("chat.save_message", { room_id: room.id, message_id: m1.id });
		await bot.call("chat.save_message", { room_id: room.id, message_id: m2.id });
		expect((await bot.call("chat.list_saved_messages")).items).toHaveLength(2);

		await ada.call("chat.delete_message", { room_id: room.id, message_id: m2.id });
		const afterDelete = await bot.call("chat.list_saved_messages");
		expect(afterDelete.items.map((i) => i.message.id)).toEqual([m1.id]);

		await bot.call("chat.unsave_message", { room_id: room.id, message_id: m1.id });
		expect((await bot.call("chat.list_saved_messages")).items).toEqual([]);
	});

	it("syncs room and thread drafts across devices", async () => {
		const room = await createRoom(ada, "public", "Writing");
		const root = await post(ada, room.id, "Topic");

		await ada.call("chat.save_draft", { room_id: room.id, text: "First draft" });
		await ada.call("chat.save_draft", { room_id: room.id, parent_id: root.id, text: "Reply draft" });
		await ada.call("chat.save_draft", { room_id: room.id, text: "Updated draft" });

		const drafts = (await ada.call("chat.list_drafts")).drafts;
		expect(drafts).toHaveLength(2);
		expect(drafts.find((d) => d.parent_id === null)?.text).toBe("Updated draft");
		expect(drafts.find((d) => d.parent_id === root.id)?.text).toBe("Reply draft");

		await ada.call("chat.delete_draft", { room_id: room.id });
		expect((await ada.call("chat.list_drafts")).drafts).toHaveLength(1);
	});

	it("schedules, edits, cancels, and delivers due scheduled messages via PrincipalDO alarm", async () => {
		const room = await createRoom(ada, "public", "Announcements");
		const soonIso = new Date(Date.now() + 60_000).toISOString();
		const laterIso = new Date(Date.now() + 120_000).toISOString();

		const s1 = (await ada.call("chat.schedule_message", { room_id: room.id, text: "Morning update", send_at: soonIso }))
			.scheduled;
		const s2 = (await ada.call("chat.schedule_message", { room_id: room.id, text: "Cancel me", send_at: laterIso }))
			.scheduled;

		const edited = (await ada.call("chat.update_scheduled_message", { scheduled_id: s1.id, text: "Edited update" }))
			.scheduled;
		expect(edited.text).toBe("Edited update");
		await ada.call("chat.cancel_scheduled_message", { scheduled_id: s2.id });
		expect((await ada.call("chat.list_scheduled_messages")).scheduled).toHaveLength(1);

		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
		await runInDurableObject(principal, async (_instance, state) => {
			state.storage.sql.exec("UPDATE chat_scheduled_messages SET send_at = ? WHERE id = ?", Date.now() - 1000, s1.id);
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		await runDurableObjectAlarm(principal);

		const messages = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(messages.map((m) => m.text)).toEqual(["Edited update"]);
		const sentId = messages[0]?.id ?? "";
		expect(sentId.startsWith("cmsg_")).toBe(true);
		expect((await ada.call("chat.list_scheduled_messages", { status: "sent" })).scheduled[0]?.status).toBe("sent");

		// Delivered scheduled messages must have valid cmsg_ IDs and support reactions, edits, pins, and deletes.
		await ada.call("chat.add_reaction", { room_id: room.id, message_id: sentId, emoji: "🎉" });
		await ada.call("chat.pin_message", { room_id: room.id, message_id: sentId });
		await ada.call("chat.edit_message", { room_id: room.id, message_id: sentId, text: "Edited after send" });

		// Revoking the credential that scheduled a message stops delivery when due.
		const { api_key: tempKey } = await ada.call("account.create_api_key", {
			label: "sched-temp",
			scopes: ["chat.read", "chat.write"],
		});
		const tempClient = api(tempKey.secret);
		const revokedSched = (
			await tempClient("chat.schedule_message", {
				room_id: room.id,
				text: "Should not deliver",
				send_at: new Date(Date.now() + 120_000).toISOString(),
			})
		).scheduled;
		await ada.call("account.revoke_api_key", { key_id: tempKey.id });
		await runInDurableObject(principal, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE chat_scheduled_messages SET send_at = ? WHERE id = ?",
				Date.now() - 1000,
				revokedSched.id,
			);
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		await runDurableObjectAlarm(principal);
		const failedRows = (await ada.call("chat.list_scheduled_messages", { status: "failed" })).scheduled;
		expect(failedRows.some((r) => r.id === revokedSched.id)).toBe(true);
		expect((await ada.call("chat.list_messages", { room_id: room.id })).messages.map((m) => m.text)).toEqual([
			"Edited after send",
		]);

		// Updating send_at clears any stale retry deadline so the message is not delivered early.
		const retried = (
			await ada.call("chat.schedule_message", {
				room_id: room.id,
				text: "Deferred after retry",
				send_at: new Date(Date.now() + 120_000).toISOString(),
			})
		).scheduled;
		await runInDurableObject(principal, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE chat_scheduled_messages SET attempts = 1, next_attempt_at = ?, error = 'Rate limited' WHERE id = ?",
				Date.now() - 1000,
				retried.id,
			);
		});
		await ada.call("chat.update_scheduled_message", {
			scheduled_id: retried.id,
			send_at: new Date(Date.now() + 600_000).toISOString(),
		});
		await runDurableObjectAlarm(principal);
		expect((await ada.call("chat.list_messages", { room_id: room.id })).messages.map((m) => m.text)).toEqual([
			"Edited after send",
		]);
		await ada.call("chat.cancel_scheduled_message", { scheduled_id: retried.id });

		expect(
			await codeOf(
				ada.call("chat.schedule_message", {
					room_id: room.id,
					text: "Too late",
					send_at: new Date(Date.now() - 5000).toISOString(),
				}),
			),
		).toBe("invalid");
	});

	// The scopes and the limits are on the agent, and the sponsor can change them after the agent schedules.
	it("posts no scheduled message of an agent after the agent gets limits or loses chat.write", async () => {
		const room = await createRoom(ada, "private", "Billing", [bot.id]);
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(bot.id));
		const schedule = async (text: string) =>
			(
				await bot.call("chat.schedule_message", {
					room_id: room.id,
					text,
					send_at: new Date(Date.now() + 120_000).toISOString(),
				})
			).scheduled;
		/** Makes the message due, and runs the alarm that sends due messages. */
		const fire = async (id: string) => {
			await runInDurableObject(principal, async (_instance, state) => {
				state.storage.sql.exec("UPDATE chat_scheduled_messages SET send_at = ? WHERE id = ?", Date.now() - 1000, id);
				await state.storage.setAlarm(Date.now() + 60_000);
			});
			await runDurableObjectAlarm(principal);
		};
		const texts = async () =>
			(await ada.call("chat.list_messages", { room_id: room.id })).messages.map((message) => message.text);
		const statusOf = async (id: string) =>
			runInDurableObject(
				principal,
				(_instance, state) =>
					state.storage.sql
						.exec<{ status: string }>("SELECT status FROM chat_scheduled_messages WHERE id = ?", id)
						.one().status,
			);

		// With chat.write and no limits, the message posts.
		const sent = await schedule("Invoice 1 is paid.");
		await fire(sent.id);
		expect(await statusOf(sent.id)).toBe("sent");

		// The agent gets limits, also with the room in its list: a limited agent cannot schedule a message.
		const limited = await schedule("Invoice 2 is paid.");
		await ada.call("directory.set_agent_access", {
			principal_id: bot.id,
			resources: { mailbox_ids: [], drive_ids: [], room_ids: [room.id] },
		});
		await fire(limited.id);
		expect(await statusOf(limited.id)).toBe("failed");

		// The agent loses chat.write.
		await ada.call("directory.set_agent_access", { principal_id: bot.id, resources: null });
		const unscoped = await schedule("Invoice 3 is paid.");
		await ada.call("directory.set_agent_access", { principal_id: bot.id, scopes: ["account.read", "chat.read"] });
		await fire(unscoped.id);
		expect(await statusOf(unscoped.id)).toBe("failed");
		expect(await texts()).toEqual(["Invoice 1 is paid."]);
	});

	it("creates reminders, fires due reminders into Activity, and completes or deletes them", async () => {
		const room = await createRoom(ada, "public", "Tasks");
		const msg = await post(ada, room.id, "Check deploy logs");
		const rem = (
			await ada.call("chat.create_reminder", {
				room_id: room.id,
				message_id: msg.id,
				remind_at: new Date(Date.now() + 60_000).toISOString(),
				note: "Verify metrics",
			})
		).reminder;
		expect(rem).toMatchObject({ completed_at: null, triggered_at: null, note: "Verify metrics" });

		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
		await runInDurableObject(principal, async (_instance, state) => {
			state.storage.sql.exec("UPDATE chat_reminders SET remind_at = ? WHERE id = ?", Date.now() - 1000, rem.id);
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		await runDurableObjectAlarm(principal);

		const activity = await ada.call("chat.list_activity");
		expect(activity.items.some((i) => i.kind === "reminder" && i.message_id === msg.id)).toBe(true);

		const completed = (await ada.call("chat.complete_reminder", { reminder_id: rem.id })).reminder;
		expect(completed.completed_at).not.toBeNull();
		expect((await ada.call("chat.list_reminders")).reminders).toEqual([]);
		expect((await ada.call("chat.list_reminders", { include_completed: "true" })).reminders).toHaveLength(1);

		await ada.call("chat.delete_reminder", { reminder_id: rem.id });
		expect((await ada.call("chat.list_reminders", { include_completed: "true" })).reminders).toEqual([]);
	});
});

describe("custom emoji, forwarding, and group DMs", () => {
	it("uploads raster custom emoji, serves it on /dl/chat/emoji/:name, allows reactions, and enforces admin auth", async () => {
		// Regular members and agents cannot create custom emoji.
		expect(await codeOf(ada.call("chat.create_custom_emoji", { name: "shipit", content_base64: TINY_PNG_B64 }))).toBe(
			"forbidden",
		);
		expect(await codeOf(bot.call("chat.create_custom_emoji", { name: "shipit", content_base64: TINY_PNG_B64 }))).toBe(
			"forbidden",
		);

		// SVG / non-raster content is rejected.
		expect(
			await codeOf(
				owner.call("chat.create_custom_emoji", {
					name: "evil",
					content_base64: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>'),
				}),
			),
		).toBe("invalid");

		// Owner uploads valid PNG emoji.
		const created = (await owner.call("chat.create_custom_emoji", { name: "shipit", content_base64: TINY_PNG_B64 }))
			.emoji;
		expect(created).toMatchObject({ name: "shipit", url_path: "/dl/chat/emoji/shipit", mime_type: "image/png" });

		// Download serves the PNG safely for credentials with chat.read, and refuses credentials without chat.read.
		const dl = await request(created.url_path, { headers: bearer(ada.key) });
		expect(dl.status).toBe(200);
		expect(dl.headers.get("content-type")).toBe("image/png");
		expect(dl.headers.get("x-content-type-options")).toBe("nosniff");

		const { api_key: mailOnly } = await ada.call("account.create_api_key", {
			label: "mail-only-emoji",
			scopes: ["mail.read"],
		});
		const deniedDl = await request(created.url_path, { headers: bearer(mailOnly.secret) });
		expect(deniedDl.status).toBe(403);

		// Custom emoji works as a reaction, while unknown :missing: fails.
		const room = await createRoom(ada, "public", "EmojiTest");
		const msg = await post(ada, room.id, "Shipped :shipit:");
		await ada.call("chat.add_reaction", { room_id: room.id, message_id: msg.id, emoji: ":shipit:" });
		expect(
			await codeOf(ada.call("chat.add_reaction", { room_id: room.id, message_id: msg.id, emoji: ":missing:" })),
		).toBe("invalid");

		// Non-member reacting on a private room receives not_found before custom emoji lookup.
		const priv = await createRoom(ada, "private", "SecretEmoji");
		const privMsg = await post(ada, priv.id, "Hidden");
		expect(
			await codeOf(bot.call("chat.add_reaction", { room_id: priv.id, message_id: privMsg.id, emoji: ":missing:" })),
		).toBe("not_found");

		// Delete removes emoji and download 404s.
		await owner.call("chat.delete_custom_emoji", { name: "shipit" });
		expect((await ada.call("chat.list_custom_emoji")).emoji).toEqual([]);
		expect((await request(created.url_path, { headers: bearer(ada.key) })).status).toBe(404);
	});

	it("opens deterministic group DMs and refuses member removal", async () => {
		const g1 = (await ada.call("chat.open_group_dm", { principal_ids: [owner.id, bot.id] })).room;
		const g2 = (await owner.call("chat.open_group_dm", { principal_ids: [bot.id, ada.id] })).room;
		expect(g1.id).toBe(g2.id);
		expect(g1.kind).toBe("group_dm");
		expect(g1.peers.map((p) => p.principal_id).sort()).toEqual([bot.id, owner.id].sort());

		await post(ada, g1.id, "Group hello");
		expect(await codeOf(bot.call("chat.remove_member", { room_id: g1.id, principal_id: bot.id }))).toBe("invalid");
	});
});

describe("lifecycle, posting rules, retention, admin tools, and export", () => {
	it("enforces archive/unarchive, posting policies, retention dry_run + prune, and delete dry_run + delete", async () => {
		const room = await createRoom(ada, "public", "Updates", [bot.id]);
		const oldMsg = await post(ada, room.id, "First message");

		// Posting rules: owners_only blocks non-owner bot.
		await ada.call("chat.set_posting_rules", { room_id: room.id, policy: "owners_only" });
		expect(await codeOf(bot.call("chat.post_message", { room_id: room.id, text: "Blocked" }))).toBe("forbidden");
		expect((await bot.call("chat.get_room", { room_id: room.id })).room.can_post).toBe(false);

		// Allowlist permits bot.
		await ada.call("chat.set_posting_rules", {
			room_id: room.id,
			policy: "allowlist",
			allowed_principal_ids: [bot.id],
		});
		expect((await bot.call("chat.get_room", { room_id: room.id })).post_allowed_ids).toEqual([bot.id]);
		await post(bot, room.id, "Allowed now");

		// Non-member probing a private room with an unknown principal gets not_found before directory lookup.
		const privRules = await createRoom(ada, "private", "HiddenRules");
		expect(
			await codeOf(
				bot.call("chat.set_posting_rules", {
					room_id: privRules.id,
					policy: "allowlist",
					allowed_principal_ids: ["prn_01ZZZZZZZZZZZZZZZZZZZZZZZZ"],
				}),
			),
		).toBe("not_found");

		// Archive blocks everyone and hides from public list.
		await ada.call("chat.archive_room", { room_id: room.id });
		expect(await codeOf(ada.call("chat.post_message", { room_id: room.id, text: "Archived" }))).toBe("conflict");
		expect((await owner.call("chat.list_rooms", { view: "public" })).rooms).toEqual([]);
		await ada.call("chat.unarchive_room", { room_id: room.id });
		expect((await owner.call("chat.list_rooms", { view: "public" })).rooms).toHaveLength(1);

		// Retention dry_run preview then real prune.
		const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE messages SET created_at = ? WHERE id = ?",
				Date.now() - 10 * 86_400_000,
				oldMsg.id,
			);
		});
		const preview = await ada.call("chat.set_room_retention", {
			room_id: room.id,
			retention_days: 7,
			dry_run: true,
		});
		expect(preview.purged_count).toBe(1);
		expect((await ada.call("chat.list_messages", { room_id: room.id })).messages).toHaveLength(2);

		const applied = await ada.call("chat.set_room_retention", { room_id: room.id, retention_days: 7 });
		expect(applied.purged_count).toBe(1);
		const afterRetention = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(afterRetention.find((m) => m.id === oldMsg.id)?.deleted).toBe(true);
		expect(afterRetention.filter((m) => !m.deleted).map((m) => m.text)).toEqual(["Allowed now"]);

		// Delete dry_run preview then real delete.
		const delPreview = await ada.call("chat.delete_room", { room_id: room.id, dry_run: true });
		expect(delPreview).toMatchObject({ deleted: false, message_count: 1, member_count: 2 });
		const delActual = await ada.call("chat.delete_room", { room_id: room.id });
		expect(delActual.deleted).toBe(true);
		expect(await codeOf(ada.call("chat.get_room", { room_id: room.id }))).toBe("not_found");
	});

	it("cleans up deleted principals from rooms, assigns owners to ownerless rooms, and enforces export permissions", async () => {
		const admin = await createActor(owner, {
			kind: "human",
			display_name: "Admin",
			address: "admin@dock.test",
			password: PASSWORD,
			org_role: "admin",
		});
		const member = await createActor(owner, {
			kind: "human",
			display_name: "Carol",
			address: "carol@dock.test",
			password: PASSWORD,
		});

		const pubRoom = await createRoom(member, "public", "PublicRoom", [ada.id]);
		await post(member, pubRoom.id, "Public note");
		const privRoom = await createRoom(ada, "private", "PrivateRoom");
		await post(ada, privRoom.id, "Private secret");

		// Export: org owner can export public room (even non-member), gets not_found on private room they are not in.
		const exported = await owner.call("chat.export_room", { room_id: pubRoom.id });
		expect(exported.messages.map((m) => m.text)).toEqual(["Public note"]);
		expect(await codeOf(owner.call("chat.export_room", { room_id: privRoom.id }))).toBe("not_found");
		// Org admin, member, and agent cannot export.
		expect(await codeOf(admin.call("chat.export_room", { room_id: pubRoom.id }))).toBe("forbidden");
		expect(await codeOf(ada.call("chat.export_room", { room_id: pubRoom.id }))).toBe("forbidden");
		expect(await codeOf(bot.call("chat.export_room", { room_id: pubRoom.id }))).toBe("forbidden");

		// Admin list rooms sees everything; member and agent get forbidden.
		const listed = await admin.call("chat.admin_list_rooms");
		expect(listed.rooms.map((r) => r.id)).toEqual(expect.arrayContaining([pubRoom.id, privRoom.id]));
		expect(await codeOf(ada.call("chat.admin_list_rooms"))).toBe("forbidden");
		expect(await codeOf(bot.call("chat.admin_list_rooms"))).toBe("forbidden");

		// Deleting carol automatically cleans up her room membership (promoting ada or leaving ownerless).
		const soloRoom = await createRoom(member, "public", "SoloRoom");
		await owner.call("directory.delete_principal", { principal_id: member.id });

		const ownerless = await admin.call("chat.admin_list_rooms", { ownerless: "true" });
		expect(ownerless.rooms.some((r) => r.id === soloRoom.id)).toBe(true);

		// Admin assigns ada as owner of the ownerless room.
		await admin.call("chat.admin_assign_owner", { room_id: soloRoom.id, principal_id: ada.id });
		expect((await ada.call("chat.get_room", { room_id: soloRoom.id })).room.role).toBe("owner");

		// Manual admin cleanup endpoint works on deleted principals and rejects active ones.
		const cleanup = await admin.call("chat.admin_remove_deleted_principal", { principal_id: member.id });
		expect(cleanup.failed_room_ids).toEqual([]);
		expect(await codeOf(admin.call("chat.admin_remove_deleted_principal", { principal_id: ada.id }))).toBe("invalid");
	});
});

describe("incoming webhooks, forwarding untrusted content, slash commands, and cards", () => {
	it("verifies HMAC-SHA256 incoming webhooks, marks messages untrusted across MCP and forwarding, and rejects bad requests", async () => {
		const room = await createRoom(ada, "private", "Alerts", [bot.id]);
		const dest = await createRoom(ada, "private", "Triage", [bot.id]);

		// Agent cannot create an incoming webhook.
		expect(await codeOf(bot.call("chat.create_incoming_webhook", { room_id: room.id, name: "CI" }))).toBe("forbidden");

		const created = await ada.call("chat.create_incoming_webhook", { room_id: room.id, name: "Pager" });
		expect(created.signing_secret).toMatch(/^whsec_/);
		expect(created.webhook.url_path).toBe(`/hooks/chat/${created.webhook.id}`);
		// Listing omits the signing secret.
		const hooks = (await ada.call("chat.list_incoming_webhooks", { room_id: room.id })).webhooks;
		expect(hooks).toHaveLength(1);
		expect("signing_secret" in (hooks[0] ?? {})).toBe(false);

		const payload = JSON.stringify({
			text: "CPU spike on prod-1",
			cards: [
				{
					id: "alert-1",
					title: "Alert",
					fields: [{ label: "Host", value: "prod-1" }],
					actions: [{ action_id: "ack", label: "Acknowledge", style: "primary", value: "prod-1" }],
				},
			],
		});
		const nowSec = Math.floor(Date.now() / 1000);

		// Wrong signature is rejected with 401.
		const badSig = await request(created.webhook.url_path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-request-timestamp": String(nowSec),
				"x-slack-signature": "v0=0000000000000000000000000000000000000000000000000000000000000000",
			},
			body: payload,
		});
		expect(badSig.status).toBe(401);

		// Stale timestamp (>300s) is rejected with 401.
		const staleTs = nowSec - 600;
		const staleRes = await request(created.webhook.url_path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-request-timestamp": String(staleTs),
				"x-slack-signature": await signSlackWebhook(created.signing_secret, staleTs, payload),
			},
			body: payload,
		});
		expect(staleRes.status).toBe(401);

		// Valid signature posts untrusted message with cards.
		const goodRes = await request(created.webhook.url_path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-request-timestamp": String(nowSec),
				"x-slack-signature": await signSlackWebhook(created.signing_secret, nowSec, payload),
			},
			body: payload,
		});
		expect(goodRes.status).toBe(200);
		const posted = (await goodRes.json()) as { ok: boolean; message_id: string; untrusted: boolean };
		expect(posted).toMatchObject({ ok: true, untrusted: true });
		const roomMessages = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(roomMessages[0]).toMatchObject({ id: posted.message_id, untrusted: true });
		expect(roomMessages[0]?.cards).toHaveLength(1);

		// MCP output marks external webhook message with the untrusted notice.
		const mcpList = await callTool(bot.key, "chat_list_messages", { room_id: room.id });
		expect(mcpList.content[0]?.text).toContain("untrusted: true");

		// Triggering and listing card actions on a webhook message preserves untrusted: true (including MCP notice).
		const webhookAction = (
			await ada.call("chat.trigger_card_action", {
				room_id: room.id,
				message_id: posted.message_id,
				card_id: "alert-1",
				action_id: "ack",
			})
		).action;
		expect(webhookAction.untrusted).toBe(true);
		const listedWebhookActions = (
			await ada.call("chat.list_card_actions", { room_id: room.id, message_id: posted.message_id })
		).actions;
		expect(listedWebhookActions[0]?.untrusted).toBe(true);
		const mcpActions = await callTool(bot.key, "chat_list_card_actions", {
			room_id: room.id,
			message_id: posted.message_id,
		});
		expect(mcpActions.content[0]?.text).toContain("untrusted: true");

		// Forwarding an untrusted message preserves untrusted: true, and idempotency covers formatting changes.
		const forwarded = (
			await ada.call("chat.forward_message", {
				room_id: room.id,
				message_id: posted.message_id,
				target_room_id: dest.id,
				text: "Look into this",
				idempotency_key: "fwd-fmt-1",
			})
		).message;
		expect(forwarded.untrusted).toBe(true);
		expect(
			await codeOf(
				ada.call("chat.forward_message", {
					room_id: room.id,
					message_id: posted.message_id,
					target_room_id: dest.id,
					markdown: "**Look into this**",
					idempotency_key: "fwd-fmt-1",
				}),
			),
		).toBe("conflict");
		expect(forwarded.forwarded).toMatchObject({
			source_room_id: room.id,
			source_message_id: posted.message_id,
			text: "CPU spike on prod-1",
		});

		// Deleting the webhook stops further posts (401 without leaking existence).
		await ada.call("chat.delete_incoming_webhook", { webhook_id: created.webhook.id });
		const afterDel = await request(created.webhook.url_path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-request-timestamp": String(nowSec),
				"x-slack-signature": await signSlackWebhook(created.signing_secret, nowSec, payload),
			},
			body: payload,
		});
		expect(afterDel.status).toBe(401);
	});

	it("runs slash commands under caller privileges and enforces the strict allowlist", async () => {
		const room = await createRoom(ada, "public", "Commands");
		const otherRoom = await createRoom(owner, "private", "Secret");

		// Mutating and sensitive target ops are rejected on registration.
		for (const forbiddenOp of [
			"chat.delete_room",
			"chat.admin_list_rooms",
			"chat.add_members",
			"drive.share_item",
			"directory.update_agent_policy",
		]) {
			expect(
				await codeOf(
					owner.call("chat.create_slash_command", {
						command: "badcmd",
						description: "Bad",
						operation: forbiddenOp,
						input_template: { room_id: "{{room_id}}" },
					}),
				),
			).toBe("forbidden");
		}

		// A chat.post_message slash command cannot redirect posts to a different room.
		await owner.call("chat.create_slash_command", {
			command: "redirect",
			description: "Cross-room attempt",
			operation: "chat.post_message",
			input_template: { room_id: otherRoom.id, text: "Sneaky {{text}}" },
		});
		expect(
			await codeOf(owner.call("chat.invoke_slash_command", { room_id: room.id, command: "redirect", text: "x" })),
		).toBe("forbidden");

		// Allowed read-only op executes under caller's own scopes, and checks room membership first.
		await owner.call("chat.create_slash_command", {
			command: "pins",
			description: "List pins",
			operation: "chat.list_pins",
			input_template: { room_id: "{{room_id}}" },
		});
		// Non-member (bot) is refused on invocation.
		expect(await codeOf(bot.call("chat.invoke_slash_command", { room_id: room.id, command: "pins" }))).toBe(
			"forbidden",
		);
		// Member succeeds.
		const pinsRes = await ada.call("chat.invoke_slash_command", { room_id: room.id, command: "pins" });
		expect(pinsRes.operation).toBe("chat.list_pins");

		// Register a normal member-usable post_message command with template substitution.
		const cmd = (
			await owner.call("chat.create_slash_command", {
				command: "shout",
				description: "Post a message",
				operation: "chat.post_message",
				input_template: { room_id: "{{room_id}}", text: "SHOUT: {{text}}" },
			})
		).command;
		// Non-admins do not see admin-configured input_template constants when listing slash commands.
		const memberList = (await ada.call("chat.list_slash_commands")).commands.find((c) => c.command === "shout");
		expect(memberList?.input_template).toEqual({});
		const adminList = (await owner.call("chat.list_slash_commands")).commands.find((c) => c.command === "shout");
		expect(adminList?.input_template).toEqual({ room_id: "{{room_id}}", text: "SHOUT: {{text}}" });

		await ada.call("chat.invoke_slash_command", { room_id: room.id, command: "shout", text: "deploying" });
		const msgs = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(msgs.map((m) => m.text)).toEqual(["SHOUT: deploying"]);

		await owner.call("chat.delete_slash_command", { command_id: cmd.id });
	});

	it("triggers card button actions idempotently, paginates newest-first, and enforces delegated token scopes", async () => {
		const room = await createRoom(ada, "private", "Approvals", [bot.id]);
		const cardMsg = (
			await bot.call("chat.post_message", {
				room_id: room.id,
				text: "Approve release?",
				cards: [
					{
						id: "rel-1",
						title: "Release v1.2",
						actions: [
							{ action_id: "approve", label: "Approve", style: "primary", value: "v1.2" },
							{ action_id: "reject", label: "Reject", style: "danger", value: "no" },
						],
					},
				],
			})
		).message;
		expect(cardMsg.cards).toHaveLength(1);

		const triggered = await ada.call("chat.trigger_card_action", {
			room_id: room.id,
			message_id: cardMsg.id,
			card_id: "rel-1",
			action_id: "approve",
			idempotency_key: "click-1",
		});
		expect(triggered.action).toMatchObject({ card_id: "rel-1", action_id: "approve", value: "v1.2" });

		// Replaying with the same idempotency_key returns the same recorded action.
		const replayed = await ada.call("chat.trigger_card_action", {
			room_id: room.id,
			message_id: cardMsg.id,
			card_id: "rel-1",
			action_id: "approve",
			idempotency_key: "click-1",
		});
		expect(replayed.action.id).toBe(triggered.action.id);

		// Different action with the same idempotency_key is refused with conflict.
		expect(
			await codeOf(
				ada.call("chat.trigger_card_action", {
					room_id: room.id,
					message_id: cardMsg.id,
					card_id: "rel-1",
					action_id: "reject",
					idempotency_key: "click-1",
				}),
			),
		).toBe("conflict");

		// Second distinct click appears first (newest-first) and paginates with cursor.
		const second = await bot.call("chat.trigger_card_action", {
			room_id: room.id,
			message_id: cardMsg.id,
			card_id: "rel-1",
			action_id: "reject",
		});
		const page1 = await bot.call("chat.list_card_actions", { room_id: room.id, message_id: cardMsg.id, limit: 1 });
		expect(page1.actions.map((a) => a.id)).toEqual([second.action.id]);
		expect(page1.next_cursor).not.toBeNull();
		const page2 = await bot.call("chat.list_card_actions", {
			room_id: room.id,
			message_id: cardMsg.id,
			limit: 1,
			cursor: page1.next_cursor ?? undefined,
		});
		expect(page2.actions.map((a) => a.id)).toEqual([triggered.action.id]);
		expect(page2.next_cursor).toBeNull();

		await soon(async () => {
			const feed = await bot.call("chat.list_activity");
			expect(feed.items.some((i) => i.kind === "card_action" && i.message_id === cardMsg.id)).toBe(true);
		});

		// Narrow delegated API key (chat.read only) can read pins/activity but cannot trigger actions or pin.
		const { api_key: readOnly } = await ada.call("account.create_api_key", {
			label: "read-only-chat",
			scopes: ["chat.read"],
		});
		const readClient = api(readOnly.secret);
		expect((await readClient("chat.list_pins", { room_id: room.id })).pins).toEqual([]);
		expect(
			await codeOf(
				readClient("chat.trigger_card_action", {
					room_id: room.id,
					message_id: cardMsg.id,
					card_id: "rel-1",
					action_id: "approve",
				}),
			),
		).toBe("forbidden");
	});

	it("sanitizes Slack attachments, validates native cards, deduplicates webhook replays, and propagates untrusted marks", async () => {
		const room = await createRoom(ada, "private", "Alerts", [bot.id]);
		const target = await createRoom(ada, "public", "Triage", [bot.id]);
		const created = await ada.call("chat.create_incoming_webhook", { room_id: room.id, name: "Pager" });
		const nowSec = Math.floor(Date.now() / 1000);

		// Malformed native cards return 400 and do not corrupt room history.
		const badCards = JSON.stringify({ text: "Bad", cards: [{ id: "bad id!", title: "" }] });
		const badRes = await request(created.webhook.url_path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-request-timestamp": String(nowSec),
				"x-slack-signature": await signSlackWebhook(created.signing_secret, nowSec, badCards),
			},
			body: badCards,
		});
		expect(badRes.status).toBe(400);

		// Slack attachments with spaced action_id, empty field values, and control characters sanitize cleanly.
		const slackPayload = JSON.stringify({
			text: "High latency",
			attachments: [
				{
					title: "API\x00 Alert",
					fields: [
						{ title: "Region", value: "us-east" },
						{ title: "Empty", value: "" },
					],
					actions: [{ name: "Ack Alert!", text: "Acknowledge", value: "ack-1" }],
				},
			],
		});
		const sig = await signSlackWebhook(created.signing_secret, nowSec, slackPayload);
		const first = await request(created.webhook.url_path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-request-timestamp": String(nowSec),
				"x-slack-signature": sig,
			},
			body: slackPayload,
		});
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { message_id: string };

		// Replaying the exact signed webhook payload returns the same message_id without creating a duplicate.
		const replay = await request(created.webhook.url_path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-request-timestamp": String(nowSec),
				"x-slack-signature": sig,
			},
			body: slackPayload,
		});
		expect(replay.status).toBe(200);
		const replayBody = (await replay.json()) as { message_id: string };
		expect(replayBody.message_id).toBe(firstBody.message_id);

		// Listing messages succeeds with strict contract schema and preserves untrusted: true.
		const msgs = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(msgs).toHaveLength(1);
		expect(msgs[0]?.untrusted).toBe(true);
		expect(msgs[0]?.cards?.[0]?.title).toBe("API Alert");
		expect(msgs[0]?.cards?.[0]?.fields).toEqual([{ label: "Region", value: "us-east" }]);

		// Forwarding from a private room omits source_room_name, and forwarding a forward keeps text and untrusted.
		const fwd1 = (
			await ada.call("chat.forward_message", {
				room_id: room.id,
				message_id: firstBody.message_id,
				target_room_id: target.id,
			})
		).message;
		expect(fwd1.forwarded?.source_room_name).toBeNull();
		expect(fwd1.untrusted).toBe(true);
		const fwd2 = (
			await ada.call("chat.forward_message", {
				room_id: target.id,
				message_id: fwd1.id,
				target_room_id: target.id,
			})
		).message;
		expect(fwd2.forwarded?.source_room_name).toBe("Triage");
		expect(fwd2.forwarded?.text).toBe("High latency");
		expect(fwd2.untrusted).toBe(true);

		// Reminder on an untrusted message marks reminder and fired activity as untrusted.
		const rem = (
			await bot.call("chat.create_reminder", {
				room_id: room.id,
				message_id: firstBody.message_id,
				remind_at: new Date(Date.now() + 60_000).toISOString(),
				note: "Check alert",
			})
		).reminder;
		expect(rem.untrusted).toBe(true);
		// Bot leaves the private room before the reminder fires -> preview must not leak.
		await bot.call("chat.remove_member", { room_id: room.id, principal_id: bot.id });
		const botPrincipal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(bot.id));
		await runInDurableObject(botPrincipal, async (_instance, state) => {
			state.storage.sql.exec("UPDATE chat_reminders SET remind_at = ? WHERE id = ?", Date.now() - 1000, rem.id);
			await state.storage.setAlarm(Date.now() + 60_000);
		});
		await runDurableObjectAlarm(botPrincipal);
		const botFeed = await bot.call("chat.list_activity");
		const firedItem = botFeed.items.find((i) => i.kind === "reminder" && i.message_id === firstBody.message_id);
		expect(firedItem).toBeUndefined();

		// Deleting the room removes D1 webhook rows, removes ChatSearchDO rows, and returns 401 on hooks.
		const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
		await runDurableObjectAlarm(roomStub);
		await ada.call("chat.delete_room", { room_id: room.id });
		const webhookRow = await env.DIRECTORY.prepare("SELECT COUNT(*) AS n FROM chat_incoming_webhooks WHERE room_id = ?")
			.bind(room.id)
			.first<{ n: number }>();
		expect(webhookRow?.n).toBe(0);
		const searchStub = env.CHAT_SEARCH.get(env.CHAT_SEARCH.idFromName("org:0"));
		const searchCount = await runInDurableObject(
			searchStub,
			(_instance, state) =>
				state.storage.sql
					.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE room_id = ?", room.id)
					.toArray()[0]?.n ?? 0,
		);
		expect(searchCount).toBe(0);
		const afterRoomDel = await request(created.webhook.url_path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-slack-request-timestamp": String(nowSec + 1),
				"x-slack-signature": await signSlackWebhook(
					created.signing_secret,
					nowSec + 1,
					JSON.stringify({ text: "late" }),
				),
			},
			body: JSON.stringify({ text: "late" }),
		});
		expect(afterRoomDel.status).toBe(401);
	});

	it("enforces privacy boundaries for non-member admins, full credential on delete_room, and safe admin_assign_owner", async () => {
		const priv = await createRoom(ada, "private", "Ada Secret", [bot.id]);
		const dm = (await ada.call("chat.open_dm", { principal_id: bot.id })).room;

		// Org owner who is NOT a member of Ada's private room or DM gets not_found on all management ops.
		for (const targetId of [priv.id, dm.id]) {
			expect(await codeOf(owner.call("chat.archive_room", { room_id: targetId }))).toBe("not_found");
			expect(await codeOf(owner.call("chat.unarchive_room", { room_id: targetId }))).toBe("not_found");
			expect(await codeOf(owner.call("chat.delete_room", { room_id: targetId }))).toBe("not_found");
			expect(await codeOf(owner.call("chat.set_posting_rules", { room_id: targetId, policy: "owners_only" }))).toBe(
				"not_found",
			);
			expect(await codeOf(owner.call("chat.set_room_retention", { room_id: targetId, retention_days: 7 }))).toBe(
				"not_found",
			);
		}

		// DM member gets invalid on set_room_retention.
		expect(await codeOf(ada.call("chat.set_room_retention", { room_id: dm.id, retention_days: 7 }))).toBe("invalid");

		// Narrow API key (chat.write only) and agent cannot call chat.delete_room.
		const { api_key: narrowKey } = await ada.call("account.create_api_key", {
			label: "narrow-chat",
			scopes: ["chat.read", "chat.write"],
		});
		const narrowClient = api(narrowKey.secret);
		expect(await codeOf(narrowClient("chat.delete_room", { room_id: priv.id }))).toBe("forbidden");
		expect(await codeOf(bot.call("chat.delete_room", { room_id: priv.id }))).toBe("forbidden");

		// admin_assign_owner refuses when room already has an owner.
		expect(await codeOf(owner.call("chat.admin_assign_owner", { room_id: priv.id, principal_id: owner.id }))).toBe(
			"conflict",
		);

		// Deleting a member automatically removes them from private rooms and transfers ownership to the remaining member.
		const tempHuman = await createActor(owner, {
			kind: "human",
			display_name: "Temp Member",
			address: "temp@dock.test",
			password: PASSWORD,
		});
		const orphanPriv = await createRoom(tempHuman, "private", "Orphan", [bot.id]);
		const soloPriv = await createRoom(tempHuman, "private", "SoloPrivate");
		await owner.call("directory.delete_principal", { principal_id: tempHuman.id });
		const afterDel = await bot.call("chat.get_room", { room_id: orphanPriv.id });
		expect(afterDel.room.role).toBe("owner");
		expect(afterDel.members.map((m) => m.principal_id)).toEqual([bot.id]);

		// admin_assign_owner refuses adding a non-member to an ownerless private room,
		// while an org owner with a full credential can delete the 0-member orphaned room.
		expect(await codeOf(owner.call("chat.admin_assign_owner", { room_id: soloPriv.id, principal_id: owner.id }))).toBe(
			"forbidden",
		);
		const deletedOrphan = await owner.call("chat.delete_room", { room_id: soloPriv.id });
		expect(deletedOrphan.deleted).toBe(true);
	});

	it("keeps versions monotonic during concurrent retention prune and posts, and prunes with delete events on alarm", async () => {
		const room = await createRoom(ada, "private", "ConcurrentRetention", [bot.id]);
		const old1 = await post(ada, room.id, "Old 1");
		const old2 = await post(ada, room.id, "Old 2");
		const old3 = await post(ada, room.id, "Old 3");
		const roomStub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(room.id));
		const tenDaysAgo = Date.now() - 10 * 86_400_000;
		await runInDurableObject(roomStub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE messages SET created_at = ? WHERE id IN (?, ?, ?)",
				tenDaysAgo,
				old1.id,
				old2.id,
				old3.id,
			);
		});

		// Run retention prune concurrently with 8 new posts.
		const [retentionRes, ...posted] = await Promise.all([
			ada.call("chat.set_room_retention", { room_id: room.id, retention_days: 5 }),
			...Array.from({ length: 8 }, (_, i) => post(bot, room.id, `Concurrent ${i}`)),
		]);
		expect(retentionRes.purged_count).toBe(3);
		expect(posted).toHaveLength(8);

		const state = await runInDurableObject(roomStub, (_instance, st) => {
			const roomVersion = st.storage.sql
				.exec<{ version: number }>("SELECT version FROM room WHERE id = 1")
				.one().version;
			const versions = st.storage.sql
				.exec<{ version: number }>("SELECT version FROM messages ORDER BY version")
				.toArray()
				.map((r) => r.version);
			return { roomVersion, versions };
		});
		expect(new Set(state.versions).size).toBe(state.versions.length);
		expect(state.roomVersion).toBeGreaterThanOrEqual(Math.max(...state.versions));

		// A post after concurrent prune is always visible via changed_after.
		const afterConcurrent = await post(ada, room.id, "After concurrent");
		const delta = await bot.call("chat.list_messages", { room_id: room.id, changed_after: state.roomVersion });
		expect(delta.messages.map((m) => m.id)).toContain(afterConcurrent.id);

		// Alarm-driven prune deletes newly expired messages, emits socket message delete event, and queues chat.message.deleted webhook.
		const { endpoint } = await ada.call("webhooks.create_endpoint", { url: "https://hooks.example.com/retention" });
		await ada.call("chat.create_webhook_subscription", {
			endpoint_id: endpoint.id,
			event: "chat.message.deleted",
			filter: "all",
		});
		const sentJobs: unknown[] = [];
		await runInDurableObject(roomStub, (instance) => {
			const target = instance as unknown as { env: Env };
			target.env = {
				...target.env,
				WEBHOOKS: {
					send: async (job: unknown) => {
						sentJobs.push(job);
					},
				} as unknown as Queue,
			};
		});
		const wsRes = await request(`/ws/chat/rooms/${room.id}`, {
			headers: { ...bearer(ada.key), upgrade: "websocket" },
		});
		const ws = wsRes.webSocket;
		expect(ws).toBeDefined();
		ws?.accept();
		const socketEvents: Array<{ type: string; message?: { id: string; deleted: boolean } }> = [];
		ws?.addEventListener("message", (event) => {
			if (typeof event.data === "string" && event.data !== "pong") {
				socketEvents.push(JSON.parse(event.data) as { type: string; message?: { id: string; deleted: boolean } });
			}
		});
		try {
			const expireTarget = posted[0];
			expect(expireTarget).toBeDefined();
			await runInDurableObject(roomStub, async (_instance, st) => {
				st.storage.sql.exec("UPDATE messages SET created_at = ? WHERE id = ?", tenDaysAgo, expireTarget?.id ?? "");
				await st.storage.setAlarm(Date.now() + 60_000);
			});
			await runDurableObjectAlarm(roomStub);

			const prunedState = await runInDurableObject(roomStub, (_instance, st) => {
				const deletedAt = st.storage.sql
					.exec<{ deleted_at: number | null }>("SELECT deleted_at FROM messages WHERE id = ?", expireTarget?.id ?? "")
					.one().deleted_at;
				return { deletedAt };
			});
			expect(prunedState.deletedAt).not.toBeNull();
			await soon(async () => {
				expect(
					socketEvents.some((e) => e.type === "message" && e.message?.id === expireTarget?.id && e.message?.deleted),
				).toBe(true);
			});
			expect(
				sentJobs.some(
					(job) =>
						typeof job === "object" &&
						job !== null &&
						(job as { eventType?: string; messageId?: string }).eventType === "chat.message.deleted" &&
						(job as { messageId?: string }).messageId === expireTarget?.id,
				),
			).toBe(true);
		} finally {
			ws?.close();
		}
	});

	it("rate-limits card actions and fails scheduled messages after 5 transient attempts", async () => {
		const room = await createRoom(ada, "private", "Limits", [bot.id]);
		const cardMsg = (
			await bot.call("chat.post_message", {
				room_id: room.id,
				text: "Rate test",
				cards: [{ id: "c1", title: "Card", actions: [{ action_id: "go", label: "Go" }] }],
			})
		).message;

		// Exhaust the per-caller burst allowance (20) on card actions; the next call must be rate_limited.
		let rateLimited = false;
		for (let i = 0; i < 25; i++) {
			try {
				await ada.call("chat.trigger_card_action", {
					room_id: room.id,
					message_id: cardMsg.id,
					card_id: "c1",
					action_id: "go",
				});
			} catch (caught) {
				if (caught instanceof Error && "code" in caught && caught.code === "rate_limited") {
					rateLimited = true;
					break;
				}
				throw caught;
			}
		}
		expect(rateLimited).toBe(true);

		// A scheduled message that hits rate_limited on its 5th attempt transitions to failed.
		const sched = (
			await ada.call("chat.schedule_message", {
				room_id: room.id,
				text: "Retry cap",
				send_at: new Date(Date.now() + 60_000).toISOString(),
			})
		).scheduled;
		const principal = env.PRINCIPAL.get(env.PRINCIPAL.idFromName(ada.id));
		await runInDurableObject(principal, async (_instance, st) => {
			st.storage.sql.exec(
				"UPDATE chat_scheduled_messages SET send_at = ?, attempts = 4, next_attempt_at = NULL WHERE id = ?",
				Date.now() - 1000,
				sched.id,
			);
			await st.storage.setAlarm(Date.now() + 60_000);
		});
		await runDurableObjectAlarm(principal);
		const failed = (await ada.call("chat.list_scheduled_messages", { status: "failed" })).scheduled;
		expect(failed.some((s) => s.id === sched.id)).toBe(true);
	});
});

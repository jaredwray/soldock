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
			await state.storage.setAlarm(Date.now() - 100);
		});
		await runDurableObjectAlarm(principal);

		const messages = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(messages.map((m) => m.text)).toEqual(["Edited update"]);
		expect((await ada.call("chat.list_scheduled_messages", { status: "sent" })).scheduled[0]?.status).toBe("sent");

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
			await state.storage.setAlarm(Date.now() - 100);
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

		// Download serves the PNG safely.
		const dl = await request(created.url_path, { headers: bearer(ada.key) });
		expect(dl.status).toBe(200);
		expect(dl.headers.get("content-type")).toBe("image/png");
		expect(dl.headers.get("x-content-type-options")).toBe("nosniff");

		// Custom emoji works as a reaction, while unknown :missing: fails.
		const room = await createRoom(ada, "public", "EmojiTest");
		const msg = await post(ada, room.id, "Shipped :shipit:");
		await ada.call("chat.add_reaction", { room_id: room.id, message_id: msg.id, emoji: ":shipit:" });
		expect(
			await codeOf(ada.call("chat.add_reaction", { room_id: room.id, message_id: msg.id, emoji: ":missing:" })),
		).toBe("invalid");

		// Delete removes emoji and download 404s.
		await owner.call("chat.delete_custom_emoji", { name: "shipit" });
		expect((await ada.call("chat.list_custom_emoji")).emoji).toEqual([]);
		expect((await request(created.url_path, { headers: bearer(ada.key) })).status).toBe(404);
	});

	it("opens deterministic group DMs and allows self-leave", async () => {
		const g1 = (await ada.call("chat.open_group_dm", { principal_ids: [owner.id, bot.id] })).room;
		const g2 = (await owner.call("chat.open_group_dm", { principal_ids: [bot.id, ada.id] })).room;
		expect(g1.id).toBe(g2.id);
		expect(g1.kind).toBe("group_dm");
		expect(g1.peers.map((p) => p.principal_id).sort()).toEqual([bot.id, owner.id].sort());

		await post(ada, g1.id, "Group hello");
		await bot.call("chat.remove_member", { room_id: g1.id, principal_id: bot.id });
		expect(await codeOf(bot.call("chat.list_messages", { room_id: g1.id }))).toBe("not_found");
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

		// Forwarding an untrusted message preserves untrusted: true.
		const forwarded = (
			await ada.call("chat.forward_message", {
				room_id: room.id,
				message_id: posted.message_id,
				target_room_id: dest.id,
				text: "Look into this",
			})
		).message;
		expect(forwarded.untrusted).toBe(true);
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

	it("runs slash commands under caller privileges and blocks forbidden target operations", async () => {
		const room = await createRoom(ada, "public", "Commands");

		// Forbidden target ops are rejected on registration.
		expect(
			await codeOf(
				owner.call("chat.create_slash_command", {
					command: "boom",
					description: "Bad",
					operation: "chat.delete_room",
					input_template: { room_id: "{{room_id}}" },
				}),
			),
		).toBe("forbidden");

		// Admin registers a command calling an admin-only operation (to prove no privilege escalation).
		await owner.call("chat.create_slash_command", {
			command: "rooms",
			description: "Admin list rooms",
			operation: "chat.admin_list_rooms",
			input_template: {},
		});
		// Regular member gets forbidden when invoking it!
		expect(await codeOf(ada.call("chat.invoke_slash_command", { room_id: room.id, command: "rooms" }))).toBe(
			"forbidden",
		);
		// Owner succeeds.
		const ownerRes = await owner.call("chat.invoke_slash_command", { room_id: room.id, command: "rooms" });
		expect(ownerRes.operation).toBe("chat.admin_list_rooms");

		// Register a normal member-usable command with template substitution.
		const cmd = (
			await owner.call("chat.create_slash_command", {
				command: "shout",
				description: "Post a message",
				operation: "chat.post_message",
				input_template: { room_id: "{{room_id}}", text: "SHOUT: {{text}}" },
			})
		).command;
		await ada.call("chat.invoke_slash_command", { room_id: room.id, command: "shout", text: "deploying" });
		const msgs = (await ada.call("chat.list_messages", { room_id: room.id })).messages;
		expect(msgs.map((m) => m.text)).toEqual(["SHOUT: deploying"]);

		await owner.call("chat.delete_slash_command", { command_id: cmd.id });
	});

	it("triggers card button actions, notifies the message author, and enforces delegated token scopes", async () => {
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
							{ action_id: "reject", label: "Reject", style: "danger" },
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
		});
		expect(triggered.action).toMatchObject({ card_id: "rel-1", action_id: "approve", value: "v1.2" });

		const recorded = (await bot.call("chat.list_card_actions", { room_id: room.id, message_id: cardMsg.id })).actions;
		expect(recorded).toHaveLength(1);

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
});

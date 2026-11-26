import { auditOk, type CallContext, credentialRef, isAdmin } from "../identity/index.ts";
import { base64ToBytes, type HandlerMap, OperationError } from "../platform/index.ts";
import { publicUrlProblem } from "../webhooks/index.ts";
import { seedJoinedRooms } from "./principal-rooms.ts";
import { activeVapid, readPushSettings, rotatePushKeys, updatePushSettings } from "./push-settings.ts";

function principal(call: CallContext) {
	return call.env.PRINCIPAL.get(call.env.PRINCIPAL.idFromName(call.caller.id));
}

/** Only an owner or an admin reads or changes Web Push for the organization. Never an agent or a service account. */
function requireAdmin(call: CallContext, action: string): void {
	if (!isAdmin(call.caller)) throw new OperationError("forbidden", `Only owners and admins can ${action}.`);
}

/** A different tab can replace the browser's session while this device still shows the previous account. */
function checkDeviceOwner(call: CallContext, expected: string | undefined): void {
	if (expected !== undefined && expected !== call.caller.id) {
		throw new OperationError("conflict", "Your account changed. Reload the page before you change this device.");
	}
}

export const chatNotificationHandlers: Pick<
	HandlerMap<CallContext>,
	| "chat.get_notification_settings"
	| "chat.set_notification_settings"
	| "chat.set_room_notification_level"
	| "chat.subscribe_push"
	| "chat.unsubscribe_push"
	| "chat.get_push_settings"
	| "chat.update_push_settings"
	| "chat.rotate_push_keys"
> = {
	async "chat.get_notification_settings"(call) {
		const owner = principal(call);
		let snapshot = await owner.getChatNotificationSettings();
		if (!snapshot.unread_complete) {
			await seedJoinedRooms(call.env, call.caller.id);
			snapshot = await owner.getChatNotificationSettings();
		}
		return { ...snapshot, vapid_public_key: (await activeVapid(call.env))?.publicKey ?? null };
	},
	async "chat.set_notification_settings"(call, input) {
		const settings = await principal(call).updateChatNotificationSettings(input);
		auditOk(call, "chat.set_notification_settings", call.caller.id);
		return { settings };
	},
	async "chat.set_room_notification_level"(call, { room_id, level }) {
		const room = call.env.CHAT_ROOM.get(call.env.CHAT_ROOM.idFromName(room_id));
		const state = await room.stateFor(call.caller.id);
		if (!state?.view || !(await principal(call).setChatNotificationLevel(state, level))) {
			throw new OperationError("not_found", "You are not a member of this room.");
		}
		auditOk(call, "chat.set_room_notification_level", room_id);
		return { level };
	},
	async "chat.subscribe_push"(call, { expected_principal_id, ...device }) {
		checkDeviceOwner(call, expected_principal_id);
		const problem = publicUrlProblem(device.endpoint, call.origin);
		if (problem) throw new OperationError("invalid", problem);
		try {
			const key = base64ToBytes(device.keys.p256dh.replaceAll("-", "+").replaceAll("_", "/"));
			await crypto.subtle.importKey("raw", key, { name: "ECDH", namedCurve: "P-256" }, false, []);
		} catch {
			throw new OperationError("invalid", "The device must supply a valid P-256 public key.");
		}
		if (!(await principal(call).subscribePush(device, credentialRef(call.caller)))) {
			throw new OperationError("conflict", "Remove a registered device before you add another device.");
		}
		auditOk(call, "chat.subscribe_push", call.caller.id);
		return { subscribed: true };
	},
	async "chat.unsubscribe_push"(call, { expected_principal_id, endpoint }) {
		checkDeviceOwner(call, expected_principal_id);
		const deleted = await principal(call).unsubscribePush(endpoint);
		auditOk(call, "chat.unsubscribe_push", call.caller.id);
		return { deleted };
	},
	async "chat.get_push_settings"(call) {
		requireAdmin(call, "read the Web Push settings");
		return await readPushSettings(call.env);
	},
	async "chat.update_push_settings"(call, input) {
		requireAdmin(call, "change the Web Push settings");
		const { settings, adopted } = await updatePushSettings(call.env, input, Date.now());
		auditOk(call, "chat.update_push_settings", settings.enabled ? "on" : "off");
		// The key pair gets its own audit line. No line holds a key.
		if (adopted) {
			auditOk(call, "chat.update_push_settings", adopted === "secret" ? "keys_copied_from_secret" : "keys_created");
		}
		return settings;
	},
	async "chat.rotate_push_keys"(call) {
		requireAdmin(call, "replace the VAPID keys");
		const settings = await rotatePushKeys(call.env, Date.now());
		auditOk(call, "chat.rotate_push_keys", "keys_rotated");
		return settings;
	},
};

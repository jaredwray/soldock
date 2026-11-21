import { Emoji } from "./chat.ts";
import { prefixedId, RoomId, Timestamp } from "./common.ts";
import { defineOperation } from "./operation.ts";
import { z } from "./zod.ts";

const READ = { readOnly: true, destructive: false, idempotent: true, openWorld: false } as const;
const CHANGE = { readOnly: false, destructive: false, idempotent: true, openWorld: false } as const;
const PrincipalId = prefixedId("prn");

export const ChatNotificationLevel = z.enum(["all", "mentions", "none"]);
export type ChatNotificationLevel = z.infer<typeof ChatNotificationLevel>;

const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM in 24-hour time.");
const TimeZone = z
	.string()
	.min(1)
	.max(100)
	.refine((zone) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: zone });
			return true;
		} catch {
			return false;
		}
	}, "Use a time zone such as America/New_York.");

/** Quiet hours start at the first time and stop at the second time in this zone. */
export const ChatDndSchedule = z.strictObject({ start: ClockTime, end: ClockTime, time_zone: TimeZone });
export type ChatDndSchedule = z.infer<typeof ChatDndSchedule>;

export const ChatNotificationSettings = z.object({
	default_level: ChatNotificationLevel,
	sound: z.boolean(),
	dnd: ChatDndSchedule.nullable(),
	room_levels: z.record(RoomId, ChatNotificationLevel),
});
export type ChatNotificationSettings = z.infer<typeof ChatNotificationSettings>;

const Endpoint = z.url({ protocol: /^https$/ }).max(2048);

const ExpectedPrincipal = PrincipalId.optional().describe(
	"The account that the device shows. A different signed-in account causes a conflict.",
);

/** A browser supplies the P-256 public key and the 16-byte secret in unpadded base64url. */
export const ChatPushSubscription = z.strictObject({
	endpoint: Endpoint,
	keys: z.strictObject({
		p256dh: z.string().regex(/^B[A-P][A-Za-z0-9_-]{84}[AEIMQUYcgkosw048]$/, "Use an uncompressed P-256 public key."),
		auth: z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/, "Use a 16-byte authentication secret."),
	}),
});
export type ChatPushSubscription = z.infer<typeof ChatPushSubscription>;

export const CHAT_PRESENCE_LIMITS = { batch: 50, refreshMs: 10_000, heartbeatMs: 30_000 } as const;

export const ChatStatus = z
	.strictObject({
		text: z
			.string()
			.trim()
			.max(100)
			.refine((text) => !/\p{Cc}/u.test(text), "Use text without control characters."),
		emoji: z.union([z.literal(""), Emoji]),
		expires_at: Timestamp.nullable(),
	})
	.refine(({ text, emoji }) => text !== "" || emoji !== "", "Set a status text or an emoji.");
export type ChatStatus = z.infer<typeof ChatStatus>;

export const ChatPresence = z.object({
	principal_id: PrincipalId,
	availability: z.enum(["active", "away", "offline"]),
	status: ChatStatus.nullable(),
});
export type ChatPresence = z.infer<typeof ChatPresence>;

/** One device reports the room it shows. A hidden device sends active: false. */
export const ChatActivity = z.strictObject({
	type: z.literal("chat.activity"),
	active: z.boolean(),
	room_id: RoomId.nullable(),
});
export type ChatActivity = z.infer<typeof ChatActivity>;

export const chatNotificationOperations = {
	"chat.get_notification_settings": defineOperation({
		name: "chat.get_notification_settings",
		summary: "Read your notification settings and unread count",
		description:
			"Returns your default level, room overrides, sound setting and quiet hours. The public VAPID key is null when Web Push is unavailable.",
		http: { method: "GET", path: "/api/v1/chat/notifications" },
		scopes: ["chat.read"],
		callers: ["human", "agent"],
		annotations: READ,
		input: z.strictObject({}),
		output: z.object({
			settings: ChatNotificationSettings,
			vapid_public_key: z.string().nullable(),
			unread_count: z.number().int().nonnegative(),
			unread_complete: z
				.boolean()
				.describe("False until this account reads the counts from all its older rooms. Call again to continue."),
		}),
		errors: [],
	}),
	"chat.set_notification_settings": defineOperation({
		name: "chat.set_notification_settings",
		summary: "Change your notification settings",
		description:
			"Set one or more fields. Quiet hours repeat daily in the time zone you select. An end before the start means the schedule crosses midnight. Equal times mean all day. Set dnd to null to remove the schedule.",
		http: { method: "POST", path: "/api/v1/chat/notifications" },
		scopes: ["chat.write"],
		callers: ["human", "agent"],
		annotations: CHANGE,
		input: z
			.strictObject({
				default_level: ChatNotificationLevel.optional(),
				sound: z.boolean().optional(),
				dnd: ChatDndSchedule.nullable().optional(),
			})
			.refine((patch) => Object.keys(patch).length > 0, "Set at least one field."),
		output: z.object({ settings: ChatNotificationSettings }),
		errors: [],
	}),
	"chat.set_room_notification_level": defineOperation({
		name: "chat.set_room_notification_level",
		summary: "Set your notification level for a room",
		description:
			"Choose all messages, mentions, or no messages for a room you belong to. Set level to null to use your default level.",
		http: { method: "POST", path: "/api/v1/chat/rooms/{room_id}/notifications" },
		scopes: ["chat.write"],
		callers: ["human", "agent"],
		annotations: CHANGE,
		input: z.strictObject({ room_id: RoomId, level: ChatNotificationLevel.nullable() }),
		output: z.object({ level: ChatNotificationLevel.nullable() }),
		errors: ["not_found"],
	}),
	"chat.subscribe_push": defineOperation({
		name: "chat.subscribe_push",
		summary: "Send chat notifications to your device",
		description:
			"Register the endpoint and keys from your browser's PushSubscription. The endpoint gets encrypted notifications for this account.",
		http: { method: "POST", path: "/api/v1/chat/push-subscriptions" },
		scopes: ["chat.read", "chat.webhooks"],
		callers: ["human"],
		annotations: { ...CHANGE, openWorld: true },
		input: ChatPushSubscription.extend({ expected_principal_id: ExpectedPrincipal }),
		output: z.object({ subscribed: z.boolean() }),
		errors: ["invalid", "conflict"],
	}),
	"chat.unsubscribe_push": defineOperation({
		name: "chat.unsubscribe_push",
		summary: "Stop chat notifications on your device",
		description: "Remove this browser's push endpoint from your account.",
		http: { method: "POST", path: "/api/v1/chat/push-subscriptions/remove" },
		scopes: ["chat.webhooks"],
		callers: ["human"],
		annotations: { ...CHANGE, destructive: true },
		input: z.strictObject({ endpoint: Endpoint, expected_principal_id: ExpectedPrincipal }),
		output: z.object({ deleted: z.boolean() }),
		errors: ["conflict"],
	}),
	"chat.get_presence": defineOperation({
		name: "chat.get_presence",
		summary: "Read the presence of the people and agents you show",
		description:
			"Pass up to 50 principal ids with a comma between them. The result gives availability and custom status for those principals in your organization.",
		http: { method: "GET", path: "/api/v1/chat/presence" },
		scopes: ["chat.read", "directory.read"],
		callers: ["human", "agent"],
		annotations: READ,
		input: z.strictObject({
			principal_ids: z
				.string()
				.min(1)
				.max(2048)
				.refine((value) => {
					const ids = value.split(",");
					return (
						ids.length <= CHAT_PRESENCE_LIMITS.batch && ids.every((id) => PrincipalId.safeParse(id.trim()).success)
					);
				}, "Use between 1 and 50 principal ids with a comma between them."),
		}),
		output: z.object({ principals: z.array(ChatPresence) }),
		errors: [],
	}),
	"chat.set_status": defineOperation({
		name: "chat.set_status",
		summary: "Set your status",
		description:
			"Set a status text, an emoji, or both. Set expires_at to a UTC timestamp or null for no end time. Set status to null to clear it.",
		http: { method: "POST", path: "/api/v1/chat/status" },
		scopes: ["chat.write"],
		callers: ["human", "agent"],
		annotations: CHANGE,
		input: z.strictObject({ status: ChatStatus.nullable() }),
		output: z.object({ status: ChatStatus.nullable() }),
		errors: [],
	}),
} as const;

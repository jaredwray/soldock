import type { ChatDndSchedule, ChatNotificationLevel, ChatNotificationSettings } from "@asterra/contracts";
import type { CredentialRef } from "./access.ts";

export const NOTIFICATION_MIGRATION = [
	// Keep the total in the same transaction as each room state, also for rooms from before this migration.
	`INSERT INTO meta (key, value) SELECT 'chat_unread', COALESCE(SUM(unread_count), 0) FROM chat_rooms WHERE joined = 1`,
	`CREATE TRIGGER chat_room_unread_insert AFTER INSERT ON chat_rooms WHEN NEW.unread_count > 0 BEGIN
		UPDATE meta SET value = value + NEW.unread_count WHERE key = 'chat_unread'; END`,
	`CREATE TRIGGER chat_room_unread_update AFTER UPDATE OF unread_count ON chat_rooms
		WHEN COALESCE(NEW.unread_count, 0) != COALESCE(OLD.unread_count, 0) BEGIN
		UPDATE meta SET value = value + COALESCE(NEW.unread_count, 0) - COALESCE(OLD.unread_count, 0)
		WHERE key = 'chat_unread'; END`,
	`CREATE TRIGGER chat_room_unread_delete AFTER DELETE ON chat_rooms WHEN OLD.unread_count > 0 BEGIN
		UPDATE meta SET value = value - OLD.unread_count WHERE key = 'chat_unread'; END`,
	"CREATE TABLE chat_notification_levels (room_id TEXT PRIMARY KEY, level TEXT NOT NULL) WITHOUT ROWID",
	`CREATE TABLE chat_push_devices (
		id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
		credential TEXT NOT NULL, registered_at INTEGER NOT NULL
	) WITHOUT ROWID`,
	`CREATE TABLE chat_notification_sounds (message_id TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID`,
	"CREATE INDEX chat_notification_sounds_at ON chat_notification_sounds (at)",
];

type Preferences = Omit<ChatNotificationSettings, "room_levels">;
export type NotificationUpdate = { [K in keyof Preferences]?: Preferences[K] | undefined };

const DEFAULTS: Preferences = { default_level: "all", sound: true, dnd: null };
/** The most push devices one person can register. */
const DEVICE_LIMIT = 32;
/** A delayed event can still send a push. Its sound belongs only to a recent message. */
export const SOUND_WINDOW_MS = 60_000;

function quietHours(schedule: ChatDndSchedule, occurredAt: number): boolean {
	if (schedule.start === schedule.end) return true;
	const clock = new Intl.DateTimeFormat("en-GB", {
		timeZone: schedule.time_zone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	return [occurredAt, Date.now()].some((at) => {
		const time = clock.format(at);
		return schedule.start < schedule.end
			? time >= schedule.start && time < schedule.end
			: time >= schedule.start || time < schedule.end;
	});
}

export interface PushDevice {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

type DeviceRow = {
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	credential: string;
	registered_at: number;
};

/** Notification state of one principal. The room outbox supplies one event for each committed message. */
export class ChatNotifications {
	private readonly sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.sql = sql;
	}

	unreadCount(): number {
		return Number(this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'chat_unread'").one().value);
	}

	private preferences(): Preferences {
		const row = this.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'chat_notifications'")
			.toArray()[0];
		return row ? (JSON.parse(row.value) as Preferences) : DEFAULTS;
	}

	settings(): ChatNotificationSettings {
		const levels = this.sql.exec<{ room_id: string; level: ChatNotificationLevel }>(
			"SELECT room_id, level FROM chat_notification_levels",
		);
		return {
			...this.preferences(),
			room_levels: Object.fromEntries(Array.from(levels, (row) => [row.room_id, row.level])),
		};
	}

	update(input: NotificationUpdate): ChatNotificationSettings {
		const preferences = this.preferences();
		this.sql.exec(
			"INSERT OR REPLACE INTO meta (key, value) VALUES ('chat_notifications', ?)",
			JSON.stringify({ ...preferences, ...input }),
		);
		return this.settings();
	}

	setRoomLevel(roomId: string, level: ChatNotificationLevel | null): void {
		if (level === null) this.sql.exec("DELETE FROM chat_notification_levels WHERE room_id = ?", roomId);
		else this.sql.exec("INSERT OR REPLACE INTO chat_notification_levels (room_id, level) VALUES (?, ?)", roomId, level);
	}

	/** Check quiet hours at the post and at delivery. A delayed retry must respect both times. */
	policy(
		roomId: string,
		reason: string | undefined,
		occurredAt: number,
		membershipId: string | undefined,
	): { allowed: boolean; sound: boolean } {
		const settings = this.preferences();
		// An earlier Worker can call the object without an id. Earlier snapshots also have no id until their next update.
		const level =
			this.sql
				.exec<{ level: ChatNotificationLevel }>(
					`SELECT level FROM chat_notification_levels JOIN chat_rooms USING (room_id)
					WHERE room_id = ?1 AND joined = 1 AND (?2 IS NULL OR membership_id IS NULL OR membership_id = ?2)`,
					roomId,
					membershipId ?? null,
				)
				.toArray()[0]?.level ?? settings.default_level;
		const allowed =
			(level === "all" || (level === "mentions" && reason === "mention")) &&
			!(settings.dnd && quietHours(settings.dnd, occurredAt));
		return { allowed, sound: settings.sound };
	}

	/** True while the quiet hours of the principal apply at `at` or now. */
	quiet(at: number): boolean {
		const { dnd } = this.preferences();
		return dnd !== null && quietHours(dnd, at);
	}

	/** The sound setting of the principal. */
	sound(): boolean {
		return this.preferences().sound;
	}

	register(device: PushDevice, credential: CredentialRef): boolean {
		const previous = this.sql
			.exec<DeviceRow>("SELECT * FROM chat_push_devices WHERE endpoint = ?", device.endpoint)
			.toArray()[0];
		const binding = JSON.stringify(credential);
		if (
			previous?.auth === device.keys.auth &&
			previous.p256dh === device.keys.p256dh &&
			previous.credential === binding
		)
			return true;
		if (
			!previous &&
			this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chat_push_devices").one().n >= DEVICE_LIMIT
		)
			return false;
		// A new registration gets a new id. An old retry or a late 410 cannot target its replacement.
		this.sql.exec(
			`INSERT OR REPLACE INTO chat_push_devices
			(id, endpoint, auth, p256dh, credential, registered_at) VALUES (?, ?, ?, ?, ?, ?)`,
			crypto.randomUUID(),
			device.endpoint,
			device.keys.auth,
			device.keys.p256dh,
			binding,
			Date.now(),
		);
		return true;
	}

	unsubscribe(endpoint: string): boolean {
		return this.sql.exec("DELETE FROM chat_push_devices WHERE endpoint = ?", endpoint).rowsWritten > 0;
	}

	expire(id: string): void {
		this.sql.exec("DELETE FROM chat_push_devices WHERE id = ?", id);
	}

	credentials(at = Number.MAX_SAFE_INTEGER): { id: string; ref: CredentialRef }[] {
		return this.sql
			.exec<{ id: string; credential: string }>(
				"SELECT id, credential FROM chat_push_devices WHERE registered_at <= ?",
				at,
			)
			.toArray()
			.map(({ id, credential }) => ({ id, ref: JSON.parse(credential) as CredentialRef }));
	}

	device(id: string, at: number): DeviceRow | undefined {
		return this.sql
			.exec<DeviceRow>("SELECT * FROM chat_push_devices WHERE id = ? AND registered_at <= ?", id, at)
			.toArray()[0];
	}

	claimSound(messageId: string, at: number, devices: string[]): boolean {
		this.sql.exec("DELETE FROM chat_notification_sounds WHERE at < ?", Date.now() - SOUND_WINDOW_MS);
		return (
			this.sql.exec(
				"INSERT OR IGNORE INTO chat_notification_sounds (message_id, at, foreground_devices) VALUES (?, ?, ?)",
				messageId,
				at,
				JSON.stringify(devices),
			).rowsWritten > 0
		);
	}
	/** A retry can use the system sound when this device received no live alert for the post. */
	sentForegroundSound(messageId: string, deviceId: string): boolean {
		return (
			this.sql
				.exec(
					"SELECT 1 FROM chat_notification_sounds s, json_each(s.foreground_devices) d WHERE s.message_id = ? AND d.value = ?",
					messageId,
					deviceId,
				)
				.toArray().length > 0
		);
	}
}

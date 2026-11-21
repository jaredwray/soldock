import { CHAT_PRESENCE_LIMITS, ChatActivity } from "@asterra/contracts";
import type { CredentialRef } from "./access.ts";

/** The attachment stays with its socket while the object sleeps. Older sockets have no activity. */
export interface EventsSocketState {
	credential: CredentialRef;
	feed: boolean;
	openedAt: number;
	checkedAt: number;
	activity?: { active: boolean; room_id: string | null; at: number };
}

const LEASE_MS = 3 * CHAT_PRESENCE_LIMITS.heartbeatMs;
const RENEW_MS = 2 * CHAT_PRESENCE_LIMITS.heartbeatMs;

export function readActivity(message: string | ArrayBuffer): ChatActivity | null {
	if (typeof message !== "string" || message.length > 512) return null;
	try {
		return ChatActivity.safeParse(JSON.parse(message)).data ?? null;
	} catch {
		return null;
	}
}

function openSockets(ctx: DurableObjectState): EventsSocketState[] {
	return ctx.getWebSockets().flatMap((socket) => {
		if (socket.readyState !== WebSocket.OPEN) return [];
		const state = socket.deserializeAttachment() as EventsSocketState | null;
		return state?.checkedAt ? [state] : [];
	});
}

/** Read the current attachments. The directory projection can be behind a tab that just changed rooms. */
export function viewsRoom(ctx: DurableObjectState, roomId: string): boolean {
	const now = Date.now();
	return openSockets(ctx).some(({ activity }) => activity?.room_id === roomId && activity.at + LEASE_MS > now);
}

/** Keep the earliest alarm. Device changes in one interval produce one directory write. */
export async function schedulePresence(
	ctx: DurableObjectState,
	delay: number = CHAT_PRESENCE_LIMITS.refreshMs,
): Promise<void> {
	const due = Date.now() + delay;
	const alarm = await ctx.storage.getAlarm();
	if (alarm === null || due < alarm) await ctx.storage.setAlarm(due);
}

/** Renew the lease only while a socket is open. A lost update expires on read. */
export async function publishPresence(ctx: DurableObjectState, db: D1Database): Promise<void> {
	const sockets = openSockets(ctx);
	const now = Date.now();
	const onlineUntil = sockets.length ? now + LEASE_MS : 0;
	const activeUntil = Math.max(0, ...sockets.map(({ activity }) => (activity?.active ? activity.at + LEASE_MS : 0)));
	const owner = ctx.storage.sql
		.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'presence_principal'")
		.toArray()[0];
	if (!owner) return;
	if (sockets.length) await schedulePresence(ctx, RENEW_MS);
	await db
		.prepare("UPDATE principals SET chat_online_until = ?, chat_active_until = ? WHERE id = ?")
		.bind(onlineUntil, activeUntil, owner.value)
		.run();
}

import type { ChatBody } from "@asterra/contracts";
import { credentialState } from "../identity/index.ts";
import { log } from "../platform/index.ts";
import { messageContent } from "./body.ts";
import type { ScheduledInput } from "./message-state.ts";
import type { ChatRoomDO } from "./room.ts";
import { type Refusal, refuse } from "./room-errors.ts";

const RECEIPT_MS = 24 * 60 * 60 * 1000;
const MIN_ARCHIVE_RETRY_MS = 60_000;
const MAX_ARCHIVE_RETRY_MS = 60 * MIN_ARCHIVE_RETRY_MS;

/** Reserve a message id and its send time together. The receipt also covers a retry after delivery. */
export function queueScheduled(
	storage: DurableObjectStorage,
	owner: string,
	input: ScheduledInput,
	blocked: Refusal | null,
) {
	const sql = storage.sql;
	const now = Date.now();
	const receipt = sql
		.exec<{ request_hash: string; message_id: string }>(
			"SELECT request_hash, message_id FROM schedule_receipts WHERE principal_id = ? AND key = ? AND expires_at > ?",
			owner,
			input.key,
			now,
		)
		.toArray()[0];
	if (receipt) {
		if (receipt.request_hash !== input.hash)
			return refuse("conflict", "The key belongs to a different scheduled message.");
		return { message_id: receipt.message_id };
	}
	if (blocked) return blocked;
	if (input.sendAt <= now) return refuse("invalid", "Choose a future time for the message.");
	const { n } = sql
		.exec<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_messages WHERE principal_id = ?", owner)
		.one();
	if (n >= 100) return refuse("conflict", "You can schedule up to 100 messages in a room.");
	storage.transactionSync(() => {
		sql.exec("DELETE FROM schedule_receipts WHERE expires_at <= ?", now);
		sql.exec(
			`INSERT INTO schedule_receipts(principal_id, key, request_hash, message_id, expires_at)
			VALUES (?, ?, ?, ?, ?)`,
			owner,
			input.key,
			input.hash,
			input.id,
			input.sendAt + RECEIPT_MS,
		);
		sql.exec(
			`INSERT INTO scheduled_messages(message_id, principal_id, parent_id, body_json, binding_json, origin, send_at, next_attempt_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			input.id,
			owner,
			input.parentId,
			JSON.stringify(input.body),
			JSON.stringify(input.binding),
			input.origin,
			input.sendAt,
			input.sendAt,
		);
	});
	return { message_id: input.id };
}

type Pending = { message_id: string; parent_id: string | null; body_json: string; send_at: number };

export function scheduledFor(sql: SqlStorage, owner: string) {
	const rows = sql.exec<Pending>(
		`SELECT message_id, parent_id, body_json, send_at FROM scheduled_messages
		 WHERE principal_id = ? ORDER BY send_at, message_id`,
		owner,
	);
	return {
		messages: rows.toArray().map((row) => ({
			message_id: row.message_id,
			parent_id: row.parent_id,
			body: JSON.parse(row.body_json) as ChatBody,
			send_at: new Date(row.send_at).toISOString(),
		})),
	};
}

function retryAfter(sql: SqlStorage, messageId: string, delay: number): void {
	sql.exec("UPDATE scheduled_messages SET next_attempt_at = ? WHERE message_id = ?", Date.now() + delay, messageId);
}

/** Use the normal post path. The room checks membership and consumes the pending row in its message transaction. */
export async function sendScheduled(
	sql: SqlStorage,
	db: D1Database,
	roomId: string,
	room: Pick<ChatRoomDO, "postMessage">,
) {
	const due = sql
		.exec<Pending & { binding_json: string; origin: string }>(
			`SELECT message_id, parent_id, body_json, send_at, binding_json, origin FROM scheduled_messages
		 WHERE next_attempt_at <= ? ORDER BY next_attempt_at, message_id LIMIT 10`,
			Date.now(),
		)
		.toArray();
	for (const row of due) {
		try {
			const credential = await credentialState(db, JSON.parse(row.binding_json) as ScheduledInput["binding"]);
			if (credential.state === "archived") {
				// Check soon after the missed send, then less often for accounts that stay archived.
				const elapsed = Date.now() - row.send_at;
				retryAfter(sql, row.message_id, Math.min(MAX_ARCHIVE_RETRY_MS, Math.max(MIN_ARCHIVE_RETRY_MS, elapsed)));
				continue;
			}
			if (credential.state === "live") {
				const principal = credential.principal;
				const result = await room.postMessage(
					{ roomId, actor: { principal_id: principal.id, kind: principal.kind, display_name: principal.display_name } },
					{
						id: row.message_id,
						parentId: row.parent_id,
						content: messageContent({ body: JSON.parse(row.body_json) as ChatBody }),
						linkOrigin: row.origin,
						alsoInRoom: false,
						clientKey: null,
						scheduled: true,
					},
				);
				if (!("error" in result)) continue;
				if (result.error.code === "rate_limited") {
					retryAfter(sql, row.message_id, 1000);
					continue;
				}
			}
			sql.exec("DELETE FROM scheduled_messages WHERE message_id = ?", row.message_id);
		} catch {
			// A binding can be temporarily unavailable. Keep the send and let the other alarm work proceed.
			retryAfter(sql, row.message_id, 60_000);
			log("warn", "scheduled chat send will retry", { roomId, messageId: row.message_id });
		}
	}
}

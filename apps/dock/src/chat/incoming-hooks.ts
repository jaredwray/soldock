import { type CredentialBinding, credentialState } from "../identity/index.ts";
import { newId, randomToken } from "../platform/index.ts";

import { chatWebhookBoundary } from "../webhooks/index.ts";
import type { ActorRecord } from "./room.ts";

export function freshHookTimestamp(seconds: number): boolean {
	return Math.abs(Date.now() / 1000 - seconds) <= 300;
}

export interface IncomingDelivery {
	hookId: string;
	timestamp: number;
}

/** Read the durable credential last. A signed delivery then commits without another asynchronous read. */
export async function authorizeHook(sql: SqlStorage, db: D1Database, delivery: IncomingDelivery, owner: string) {
	const [hook] = sql
		.exec<{ binding_json: string }>(
			"SELECT binding_json FROM incoming_hooks WHERE id = ? AND owner = ?",
			delivery.hookId,
			owner,
		)
		.toArray();
	if (!hook) return null;
	const boundary = await chatWebhookBoundary(db);
	const state = await credentialState(db, JSON.parse(hook.binding_json) as CredentialBinding);
	if (state.state !== "live" || !freshHookTimestamp(delivery.timestamp)) return null;
	const author: ActorRecord = {
		principal_id: state.principal.id,
		display_name: state.principal.display_name,
		kind: state.principal.kind,
	};
	return { boundary, author };
}

export const incomingHookMigration = [
	"ALTER TABLE messages ADD COLUMN untrusted INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE messages ADD COLUMN buttons_json TEXT",
	"ALTER TABLE messages ADD COLUMN action_id TEXT",
	`CREATE TABLE incoming_hooks (
		id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES members(principal_id) ON DELETE CASCADE,
		label TEXT NOT NULL, secret TEXT NOT NULL, binding_json TEXT NOT NULL
	)`,
	"CREATE INDEX incoming_hooks_owner ON incoming_hooks(owner)",
	`CREATE TRIGGER delete_room_hooks AFTER UPDATE OF deleted ON room WHEN NEW.deleted = 1
		BEGIN DELETE FROM incoming_hooks; END`,
	`CREATE TRIGGER delete_message_actions AFTER UPDATE OF deleted_at ON messages WHEN NEW.deleted_at IS NOT NULL
		BEGIN UPDATE messages SET buttons_json = NULL, action_id = NULL WHERE id = NEW.id; END`,
];

export function createHook(sql: SqlStorage, binding: CredentialBinding, label: string) {
	const hook = { id: newId("hook"), label };
	const secret = randomToken();
	const inserted = sql
		.exec(
			`INSERT INTO incoming_hooks (id, owner, label, secret, binding_json)
		SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM incoming_hooks WHERE owner = ?) < 10 RETURNING id`,
			hook.id,
			binding.principalId,
			label,
			secret,
			JSON.stringify(binding),
			binding.principalId,
		)
		.toArray();
	return inserted.length ? { hook, secret } : null;
}

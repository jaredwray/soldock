import { type ChatPresence, type ChatStatus, commaListEntries } from "@asterra/contracts";
import { type HandlerMap, OperationError } from "../platform/index.ts";
import { auditOk } from "./access.ts";
import type { CallContext } from "./auth.ts";

interface PresenceRow {
	id: string;
	chat_online_until: number;
	chat_active_until: number;
	chat_status_json: string | null;
}

function currentStatus(status: ChatStatus | null, now: number): ChatStatus | null {
	return status?.expires_at && Date.parse(status.expires_at) <= now ? null : status;
}

export const chatPresenceHandlers: Pick<HandlerMap<CallContext>, "chat.get_presence" | "chat.set_status"> = {
	async "chat.get_presence"(call, input) {
		const ids = [...new Set(commaListEntries(input.principal_ids))];
		const { results } = await call.env.DIRECTORY.prepare(
			`SELECT p.id, p.chat_online_until, p.chat_active_until, p.chat_status_json
			FROM json_each(?) wanted CROSS JOIN principals p ON p.id = wanted.value
			WHERE p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY wanted.key`,
		)
			.bind(JSON.stringify(ids))
			.all<PresenceRow>();
		const now = Date.now();
		const principals = results.map(
			(row): ChatPresence => ({
				principal_id: row.id,
				availability: row.chat_online_until <= now ? "offline" : row.chat_active_until > now ? "active" : "away",
				status: currentStatus(row.chat_status_json ? (JSON.parse(row.chat_status_json) as ChatStatus) : null, now),
			}),
		);
		return { principals };
	},

	async "chat.set_status"(call, { status }) {
		if (status && !currentStatus(status, Date.now())) {
			throw new OperationError("invalid", "The end of the status must be in the future.");
		}
		const principalId = call.caller.principal.id;
		await call.env.DIRECTORY.prepare("UPDATE principals SET chat_status_json = ? WHERE id = ?")
			.bind(status === null ? null : JSON.stringify(status), principalId)
			.run();
		auditOk(call, "chat.set_status", principalId);
		return { status };
	},
};

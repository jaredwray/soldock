import type { ChatRoomPolicy } from "@asterra/contracts";

export const ROOM_DAY_MS = 86_400_000;
export const roomPolicySchema = [
	"ALTER TABLE room ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
	"ALTER TABLE room ADD COLUMN posting TEXT NOT NULL DEFAULT 'members' CHECK (posting IN ('members','owners'))",
	"ALTER TABLE room ADD COLUMN retention_days INTEGER",
	"ALTER TABLE room ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
	"CREATE INDEX messages_retention ON messages (created_at, seq) WHERE deleted_at IS NULL",
];

export interface StoredPolicy {
	archived: number;
	posting: "members" | "owners";
	retention_days: number | null;
	deleted: number;
}

export type PolicyUpdate = { [K in keyof ChatRoomPolicy]?: ChatRoomPolicy[K] | undefined };

export function roomPolicy(row: StoredPolicy): ChatRoomPolicy {
	return { archived: row.archived === 1, posting: row.posting, retention_days: row.retention_days };
}

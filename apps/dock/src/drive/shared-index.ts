import type { SharedDriveRole } from "@asterra/contracts";

// Reads of the index of the shared drives in D1 (`shared_drives`, `shared_drive_members`). Each
// `DriveSpaceDO` of a shared drive writes its own rows. The index is a copy for the lists, and it tells
// which ids are live shared drives. The drive object decides each access.

export interface SharedDriveRow {
	id: string;
	name: string;
	name_key: string;
	created_at: number;
	member_count: number;
	role: SharedDriveRole | null;
}

/** The ids from the list that are not a live shared drive: no row in the index, or a deleted drive. */
export async function unknownSharedDriveIds(db: D1Database, ids: readonly string[]): Promise<string[]> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return [];
	const { results } = await db
		.prepare(
			"SELECT d.id FROM shared_drives d JOIN json_each(?) wanted ON wanted.value = d.id WHERE d.deleted_at IS NULL",
		)
		.bind(JSON.stringify(unique))
		.all<{ id: string }>();
	const live = new Set(results.map((row) => row.id));
	return unique.filter((id) => !live.has(id));
}

/** The state of one shared drive in the index: `live`, `deleted`, or null when the index has no row. */
export async function sharedDriveState(db: D1Database, id: string): Promise<"live" | "deleted" | null> {
	const row = await db
		.prepare("SELECT deleted_at FROM shared_drives WHERE id = ?")
		.bind(id)
		.first<{ deleted_at: number | null }>();
	return row === null ? null : row.deleted_at === null ? "live" : "deleted";
}

/**
 * One page of shared drives, in the order of their names: the drives that the principal is a member of,
 * or each drive with `all`. The member count leaves out the principals that the directory deleted.
 * `after` is the name key and the id of the last drive of the page before.
 */
export async function listSharedDriveRows(
	db: D1Database,
	principalId: string,
	input: { all: boolean; after: [string, string] | null; limit: number },
): Promise<SharedDriveRow[]> {
	const { results } = await db
		.prepare(
			`SELECT d.id, d.name, d.name_key, d.created_at, m.role,
				(SELECT COUNT(*) FROM shared_drive_members c JOIN principals p ON p.id = c.principal_id
					WHERE c.drive_id = d.id AND p.deleted_at IS NULL) AS member_count
			FROM shared_drives d
			LEFT JOIN shared_drive_members m ON m.drive_id = d.id AND m.principal_id = ?1
			WHERE d.deleted_at IS NULL
				AND (?2 = 1 OR m.role IS NOT NULL)
				AND (?3 IS NULL OR d.name_key > ?3 OR (d.name_key = ?3 AND d.id > ?4))
			ORDER BY d.name_key, d.id LIMIT ?5`,
		)
		.bind(principalId, input.all ? 1 : 0, input.after?.[0] ?? null, input.after?.[1] ?? null, input.limit)
		.all<SharedDriveRow>();
	return results;
}

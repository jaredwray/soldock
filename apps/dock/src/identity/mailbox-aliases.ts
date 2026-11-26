import { MAILBOX_ALIAS_LIMITS } from "@asterra/contracts";
import { conflictOf, normalizeAddress } from "./store.ts";
import { isTeamMailboxId, resolveMailboxAddress } from "./team-mailboxes.ts";

/**
 * Mailbox aliases: extra addresses that receive mail for a mailbox. The alias of the own mailbox of a
 * principal is a row of `addresses` with `is_primary = 0`. The alias of a team mailbox is a row of
 * `team_mailbox_aliases`. Triggers in D1 (migration 0040) keep each address in one place only.
 */
export interface MailboxAliasRecord {
	address: string;
	created_at: string;
}

/** The aliases of a mailbox, the oldest first. A mailbox that does not exist has none. */
export async function listMailboxAliases(db: D1Database, mailboxId: string): Promise<MailboxAliasRecord[]> {
	const statement = isTeamMailboxId(mailboxId)
		? db.prepare(
				"SELECT address, created_at FROM team_mailbox_aliases WHERE mailbox_id = ? ORDER BY created_at, address",
			)
		: db.prepare(
				"SELECT address, created_at FROM addresses WHERE principal_id = ? AND is_primary = 0 ORDER BY created_at, address",
			);
	const { results } = await statement.bind(mailboxId).all<MailboxAliasRecord>();
	return results;
}

/**
 * The result of an add:
 * - `added`: the mailbox has the new alias.
 * - `exists`: the mailbox had the alias before. Nothing changed.
 * - `primary`: the address is the primary address of the mailbox.
 * - `taken`: a different mailbox has the address.
 * - `full`: the mailbox has the most aliases that it can have.
 * - `gone`: the mailbox does not exist, or a directory reset is in progress.
 */
export type AddAliasResult = "added" | "exists" | "primary" | "taken" | "full" | "gone";

/**
 * Adds an alias to a mailbox. The insert does the checks again in its statement, so two parallel calls cannot
 * go past the limit. The unique keys and the triggers stop an insert of an address that a parallel call
 * took after the first check. The function then reads the holder again: the same mailbox gives `exists`, as
 * a later call does, and a different mailbox gives `taken`.
 * The caller makes sure that the domain is saved. The trigger of the domain does the check again.
 */
export async function addMailboxAlias(
	db: D1Database,
	mailboxId: string,
	address: string,
	createdBy: string,
): Promise<AddAliasResult> {
	const normalized = normalizeAddress(address);
	const held = async (): Promise<"taken" | "primary" | "exists" | null> => {
		const holder = await resolveMailboxAddress(db, normalized);
		if (!holder) return null;
		if (holder.id !== mailboxId) return "taken";
		return holder.address === normalized ? "primary" : "exists";
	};
	const before = await held();
	if (before) return before;
	const now = new Date().toISOString();
	const statement = isTeamMailboxId(mailboxId)
		? db
				.prepare(
					`INSERT INTO team_mailbox_aliases (address, mailbox_id, created_by, created_at)
					SELECT ?1, ?2, ?3, ?4
					WHERE EXISTS (SELECT 1 FROM team_mailboxes WHERE id = ?2)
					AND NOT EXISTS (SELECT 1 FROM setup_lock WHERE token IS NOT NULL)
					AND (SELECT COUNT(*) FROM team_mailbox_aliases WHERE mailbox_id = ?2) < ?5`,
				)
				.bind(normalized, mailboxId, createdBy, now, MAILBOX_ALIAS_LIMITS.aliases)
		: db
				.prepare(
					`INSERT INTO addresses (address, principal_id, is_primary, created_at)
					SELECT ?1, ?2, 0, ?3
					WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?2 AND deleted_at IS NULL)
					AND NOT EXISTS (SELECT 1 FROM setup_lock WHERE token IS NOT NULL)
					AND (SELECT COUNT(*) FROM addresses WHERE principal_id = ?2 AND is_primary = 0) < ?4`,
				)
				.bind(normalized, mailboxId, now, MAILBOX_ALIAS_LIMITS.aliases);
	let changes: number;
	try {
		changes = (await statement.run()).meta.changes;
	} catch (error) {
		const conflict = conflictOf(error);
		// A parallel call took the address after the check above. Read the holder again.
		if (conflict?.code === "conflict") {
			const after = await held();
			if (after) return after;
		}
		throw conflict ?? error;
	}
	if (changes === 1) return "added";
	// The guards of the insert stopped it. A parallel call can have added this alias as the last one that the
	// mailbox can have, so read the holder again before the limit.
	const after = await held();
	if (after) return after;
	const aliases = await listMailboxAliases(db, mailboxId);
	return aliases.length >= MAILBOX_ALIAS_LIMITS.aliases ? "full" : "gone";
}

/**
 * Removes an alias from a mailbox. Returns false when the mailbox does not have the alias. The statement
 * never removes the primary address of a principal.
 */
export async function removeMailboxAlias(db: D1Database, mailboxId: string, address: string): Promise<boolean> {
	const statement = isTeamMailboxId(mailboxId)
		? db.prepare("DELETE FROM team_mailbox_aliases WHERE address = ? AND mailbox_id = ?")
		: db.prepare("DELETE FROM addresses WHERE address = ? AND principal_id = ? AND is_primary = 0");
	const result = await statement.bind(normalizeAddress(address), mailboxId).run();
	return result.meta.changes === 1;
}

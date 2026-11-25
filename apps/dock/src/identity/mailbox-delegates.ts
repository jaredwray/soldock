import { MAILBOX_DELEGATE_LIMITS, type MailboxMemberScope } from "@asterra/contracts";
import { type MemberMailboxRecord, parseMemberScopes, storedMemberScopes } from "./team-mailboxes.ts";

// The delegates of a mailbox: the people and agents that a person lets use their own mailbox (D1 table
// `mailbox_delegates`, migration 0036). A mailbox has no delegate until its owner adds one. A grant counts
// only while the owner is a person who is not archived and not deleted: the queries here check that on each
// read, so the access ends at once with the grant, and stops while the owner is archived.

/** One delegate of a mailbox, with what the delegate can do in it. */
export interface MailboxDelegateRecord {
	principal_id: string;
	scopes: MailboxMemberScope[];
	created_at: string;
}

/** The delegates of the own mailbox of a person, in the order in which the person added them. */
export async function listMailboxDelegates(db: D1Database, mailboxId: string): Promise<MailboxDelegateRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT principal_id, scopes, created_at FROM mailbox_delegates
			WHERE mailbox_id = ? ORDER BY created_at, principal_id`,
		)
		.bind(mailboxId)
		.all<{ principal_id: string; scopes: string; created_at: string }>();
	return results.map((row) => ({ ...row, scopes: parseMemberScopes(row.scopes) }));
}

/**
 * Adds a delegate with these scopes, or gives a delegate these scopes. Returns false when the mailbox has
 * the most delegates that it can have, when the owner is not a person, or when the owner or the delegate
 * was deleted during the request. A principal is never a delegate of the own mailbox.
 */
export async function setMailboxDelegate(
	db: D1Database,
	mailboxId: string,
	principalId: string,
	scopes: readonly MailboxMemberScope[],
): Promise<boolean> {
	if (mailboxId === principalId) return false;
	const stored = storedMemberScopes(scopes);
	const [updated, inserted] = await db.batch([
		// A delegate takes no new place, so the count does not apply to a change of its scopes.
		db
			.prepare("UPDATE mailbox_delegates SET scopes = ?3 WHERE mailbox_id = ?1 AND principal_id = ?2")
			.bind(mailboxId, principalId, stored),
		// The count is in the statement, so two parallel calls cannot go past the limit. A delegate has a row,
		// so the insert then changes nothing.
		db
			.prepare(
				`INSERT INTO mailbox_delegates (mailbox_id, principal_id, scopes, created_at)
				SELECT ?1, ?2, ?3, ?4
				WHERE (SELECT COUNT(*) FROM mailbox_delegates WHERE mailbox_id = ?1) < ?5
				AND EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND kind = 'human' AND deleted_at IS NULL)
				AND EXISTS (SELECT 1 FROM principals WHERE id = ?2 AND deleted_at IS NULL)
				ON CONFLICT DO NOTHING`,
			)
			.bind(mailboxId, principalId, stored, new Date().toISOString(), MAILBOX_DELEGATE_LIMITS.delegates),
	]);
	return updated?.meta.changes === 1 || inserted?.meta.changes === 1;
}

/** Removes a delegate. Returns false when the principal was not a delegate of the mailbox. */
export async function removeMailboxDelegate(db: D1Database, mailboxId: string, principalId: string): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM mailbox_delegates WHERE mailbox_id = ? AND principal_id = ?")
		.bind(mailboxId, principalId)
		.run();
	return result.meta.changes === 1;
}

/**
 * The mailboxes of people that a principal can use as a delegate, with the name and the primary address of
 * each owner. The owner must be a person who is not archived and not deleted: a deleted principal has no
 * address, so the join leaves it out.
 */
const DELEGATED_MAILBOX_SELECT = `SELECT p.id AS id, 'delegated' AS kind, a.address AS address,
	p.display_name AS display_name, d.scopes AS scopes
	FROM mailbox_delegates d
	JOIN principals p ON p.id = d.mailbox_id AND p.kind = 'human' AND p.archived_at IS NULL AND p.deleted_at IS NULL
	JOIN addresses a ON a.principal_id = p.id AND a.is_primary = 1
	WHERE d.principal_id = ?1`;

type DelegatedMailboxRow = Omit<MemberMailboxRecord, "scopes"> & { scopes: string };

/** The mailboxes that their owners let a principal use, by the name of the owner, each with the scopes of the grant. */
export async function delegatedMailboxesOf(db: D1Database, principalId: string): Promise<MemberMailboxRecord[]> {
	const { results } = await db
		.prepare(`${DELEGATED_MAILBOX_SELECT} ORDER BY p.display_name, p.id`)
		.bind(principalId)
		.all<DelegatedMailboxRow>();
	return results.map((row) => ({ ...row, kind: "delegated", scopes: parseMemberScopes(row.scopes) }));
}

/**
 * The mailbox of a person, for a delegate of that person, with the scopes of the grant. Null when the owner
 * gave this principal no grant, or when the owner is archived or deleted. Each call reads the directory, so
 * a removed grant and a removed scope end at once.
 */
export async function delegatedMailboxFor(
	db: D1Database,
	mailboxId: string,
	principalId: string,
): Promise<MemberMailboxRecord | null> {
	const row = await db
		.prepare(`${DELEGATED_MAILBOX_SELECT} AND d.mailbox_id = ?2`)
		.bind(principalId, mailboxId)
		.first<DelegatedMailboxRow>();
	return row ? { ...row, kind: "delegated", scopes: parseMemberScopes(row.scopes) } : null;
}

import { TEAM_MAILBOX_LIMITS } from "@soldock/contracts";
import { newId, OperationError } from "../platform/index.ts";
import { conflictOf, normalizeAddress } from "./store.ts";

/** The prefix of a team mailbox id. A principal id starts with `prn_`, so the two never collide. */
const TEAM_MAILBOX_PREFIX = "tmb";

/** A team mailbox as the directory stores it, with the ids of its members. */
export interface TeamMailboxRecord {
	id: string;
	display_name: string;
	address: string;
	member_ids: string[];
	created_at: string;
}

/**
 * A mailbox that receives mail: the own mailbox of a principal, or a team mailbox. Its id names its
 * `MailboxDO` and the owner part of its R2 keys. `agent` is the own mailbox of an agent, as an owner or
 * an admin opens it: they can read it, and nothing more.
 */
export interface MailboxRecord {
	id: string;
	kind: "personal" | "team" | "agent";
	address: string;
	display_name: string;
}

type TeamMailboxRow = Omit<TeamMailboxRecord, "member_ids">;

const TEAM_MAILBOX_SELECT = "SELECT id, display_name, address, created_at FROM team_mailboxes";

export function isTeamMailboxId(id: string): boolean {
	return id.startsWith(`${TEAM_MAILBOX_PREFIX}_`);
}

async function membersOf(db: D1Database, mailboxId: string): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT principal_id FROM team_mailbox_members WHERE mailbox_id = ? ORDER BY created_at, principal_id")
		.bind(mailboxId)
		.all<{ principal_id: string }>();
	return results.map((row) => row.principal_id);
}

export async function getTeamMailbox(db: D1Database, id: string): Promise<TeamMailboxRecord | null> {
	const row = await db.prepare(`${TEAM_MAILBOX_SELECT} WHERE id = ?`).bind(id).first<TeamMailboxRow>();
	return row ? { ...row, member_ids: await membersOf(db, id) } : null;
}

/** Every team mailbox, by name, each with its members in the order in which they joined. */
export async function listTeamMailboxes(db: D1Database): Promise<TeamMailboxRecord[]> {
	const [mailboxes, members] = await db.batch<TeamMailboxRow | { mailbox_id: string; principal_id: string }>([
		db.prepare(`${TEAM_MAILBOX_SELECT} ORDER BY display_name, id`),
		db.prepare("SELECT mailbox_id, principal_id FROM team_mailbox_members ORDER BY created_at, principal_id"),
	]);
	const byMailbox = new Map<string, string[]>();
	for (const row of (members?.results ?? []) as { mailbox_id: string; principal_id: string }[]) {
		byMailbox.set(row.mailbox_id, [...(byMailbox.get(row.mailbox_id) ?? []), row.principal_id]);
	}
	return ((mailboxes?.results ?? []) as TeamMailboxRow[]).map((row) => ({
		...row,
		member_ids: byMailbox.get(row.id) ?? [],
	}));
}

/**
 * Creates a team mailbox and its first members in one transaction. Returns null, and writes nothing,
 * while a directory reset is in progress: the reset pauses the mailboxes that exist when it starts.
 */
export async function createTeamMailbox(
	db: D1Database,
	input: { display_name: string; address: string; member_ids: readonly string[]; created_by: string },
): Promise<TeamMailboxRecord | null> {
	const id = newId(TEAM_MAILBOX_PREFIX);
	const now = new Date().toISOString();
	const memberIds = [...new Set(input.member_ids)];
	try {
		const [created] = await db.batch([
			db
				.prepare(
					`INSERT INTO team_mailboxes (id, display_name, address, created_by, created_at)
					SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM setup_lock WHERE token IS NOT NULL)`,
				)
				.bind(id, input.display_name, normalizeAddress(input.address), input.created_by, now),
			...memberIds.map((principalId) =>
				db
					.prepare(
						`INSERT INTO team_mailbox_members (mailbox_id, principal_id, added_by, created_at)
						SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM team_mailboxes WHERE id = ?1)`,
					)
					.bind(id, principalId, input.created_by, now),
			),
		]);
		if (!created?.meta.changes) return null;
	} catch (error) {
		throw conflictOf(error) ?? error;
	}
	return getTeamMailbox(db, id);
}

/**
 * Adds a member. A second call for the same member changes nothing. Returns false when the mailbox
 * has the most members that it can have.
 */
export async function addTeamMailboxMember(
	db: D1Database,
	mailboxId: string,
	principalId: string,
	addedBy: string,
): Promise<boolean> {
	if (await isTeamMailboxMember(db, mailboxId, principalId)) return true;
	// The count is in the statement, so two parallel calls cannot go past the limit.
	const result = await db
		.prepare(
			`INSERT INTO team_mailbox_members (mailbox_id, principal_id, added_by, created_at)
			SELECT ?1, ?2, ?3, ?4
			WHERE (SELECT COUNT(*) FROM team_mailbox_members WHERE mailbox_id = ?1) < ?5
			ON CONFLICT DO NOTHING`,
		)
		.bind(mailboxId, principalId, addedBy, new Date().toISOString(), TEAM_MAILBOX_LIMITS.members)
		.run();
	return result.meta.changes === 1 || (await isTeamMailboxMember(db, mailboxId, principalId));
}

export async function removeTeamMailboxMember(db: D1Database, mailboxId: string, principalId: string): Promise<void> {
	await db
		.prepare("DELETE FROM team_mailbox_members WHERE mailbox_id = ? AND principal_id = ?")
		.bind(mailboxId, principalId)
		.run();
}

export async function isTeamMailboxMember(db: D1Database, mailboxId: string, principalId: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS found FROM team_mailbox_members WHERE mailbox_id = ? AND principal_id = ?")
		.bind(mailboxId, principalId)
		.first();
	return row !== null;
}

/** The team mailboxes that a principal is a member of, by name. */
export async function teamMailboxesOf(db: D1Database, principalId: string): Promise<MailboxRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, 'team' AS kind, t.address, t.display_name FROM team_mailboxes t
			JOIN team_mailbox_members m ON m.mailbox_id = t.id
			WHERE m.principal_id = ? ORDER BY t.display_name, t.id`,
		)
		.bind(principalId)
		.all<MailboxRecord>();
	return results;
}

/**
 * The team mailbox with this id, for a member. Throws `not_found` for an unknown id and `forbidden`
 * for a principal that is not a member. Each call reads the directory, so removed access ends at once.
 */
export async function teamMailboxFor(db: D1Database, mailboxId: string, principalId: string): Promise<MailboxRecord> {
	const row = await db
		.prepare(
			`SELECT t.id, 'team' AS kind, t.address, t.display_name, EXISTS (
				SELECT 1 FROM team_mailbox_members m WHERE m.mailbox_id = t.id AND m.principal_id = ?2
			) AS member
			FROM team_mailboxes t WHERE t.id = ?1`,
		)
		.bind(mailboxId, principalId)
		.first<MailboxRecord & { member: number }>();
	if (!row) throw new OperationError("not_found", "No team mailbox has that id.");
	if (row.member !== 1) {
		throw new OperationError(
			"forbidden",
			"You are not a member of this team mailbox. An owner or an admin can add you.",
		);
	}
	return { id: row.id, kind: "team", address: row.address, display_name: row.display_name };
}

const AGENT_MAILBOX_SELECT = `SELECT p.id AS id, 'agent' AS kind, a.address AS address, p.display_name AS display_name
	FROM principals p JOIN addresses a ON a.principal_id = p.id AND a.is_primary = 1
	WHERE p.kind = 'agent'`;

/** The own mailbox of each agent, by name. Only owners and admins get this list (`canReadAgentMailboxes`). */
export async function agentMailboxes(db: D1Database): Promise<MailboxRecord[]> {
	const { results } = await db.prepare(`${AGENT_MAILBOX_SELECT} ORDER BY p.display_name, p.id`).all<MailboxRecord>();
	return results;
}

/**
 * The own mailbox of an agent, for an owner or an admin. Throws `not_found` for an unknown id, and
 * `forbidden` for a person: the mailbox of a person is private. Each call reads the directory.
 */
export async function agentMailboxFor(db: D1Database, principalId: string): Promise<MailboxRecord> {
	const agent = await db.prepare(`${AGENT_MAILBOX_SELECT} AND p.id = ?`).bind(principalId).first<MailboxRecord>();
	if (agent) return { id: agent.id, kind: "agent", address: agent.address, display_name: agent.display_name };
	const exists = await db.prepare("SELECT 1 AS found FROM principals WHERE id = ?").bind(principalId).first();
	if (!exists) throw new OperationError("not_found", "No principal has that id.");
	throw new OperationError(
		"forbidden",
		"The mailbox of a person is private. Owners and admins can read the mailbox of an agent only.",
	);
}

const MAILBOX_BY_ADDRESS = `SELECT p.id AS id, 'personal' AS kind, primary_address.address AS address, p.display_name AS display_name
	FROM addresses target
	JOIN principals p ON p.id = target.principal_id
	JOIN addresses primary_address ON primary_address.principal_id = p.id AND primary_address.is_primary = 1
	WHERE target.address = ?1
	UNION ALL
	SELECT id, 'team' AS kind, address, display_name FROM team_mailboxes WHERE address = ?1`;

/** The mailbox that receives mail for an address, or null when the address is unknown. */
export async function resolveMailboxAddress(db: D1Database, address: string): Promise<MailboxRecord | null> {
	return await db.prepare(MAILBOX_BY_ADDRESS).bind(normalizeAddress(address)).first<MailboxRecord>();
}

/** The mailbox with this id (a principal id or a team mailbox id), with its current address, or null. */
export async function getMailbox(db: D1Database, id: string): Promise<MailboxRecord | null> {
	if (isTeamMailboxId(id)) {
		return await db
			.prepare("SELECT id, 'team' AS kind, address, display_name FROM team_mailboxes WHERE id = ?")
			.bind(id)
			.first<MailboxRecord>();
	}
	return await db
		.prepare(
			`SELECT p.id AS id, 'personal' AS kind, a.address AS address, p.display_name AS display_name
			FROM principals p JOIN addresses a ON a.principal_id = p.id AND a.is_primary = 1 WHERE p.id = ?`,
		)
		.bind(id)
		.first<MailboxRecord>();
}

/** The ids of every mailbox object: each principal and each team mailbox. A directory reset pauses them. */
export async function allMailboxIds(db: D1Database): Promise<string[]> {
	const { results } = await db.prepare("SELECT id FROM principals").all<{ id: string }>();
	let teams: { id: string }[] = [];
	try {
		teams = (await db.prepare("SELECT id FROM team_mailboxes").all<{ id: string }>()).results;
	} catch {
		// A directory from before migration 0005 has no team mailboxes. The reset must still work.
	}
	return [...results, ...teams].map(({ id }) => id);
}

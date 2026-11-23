import { MAILBOX_MEMBER_SCOPES, type MailboxMemberScope, TEAM_MAILBOX_LIMITS } from "@asterra/contracts";
import { newId, OperationError } from "../platform/index.ts";
import { type AgentWidening, conflictOf, normalizeAddress, widenAgentAccessStatement } from "./store.ts";

/** The prefix of a team mailbox id. A principal id starts with `prn_`, so the two never collide. */
const TEAM_MAILBOX_PREFIX = "tmb";

/** One member of a team mailbox, with what the member can do in it. */
export interface TeamMailboxMemberRecord {
	principal_id: string;
	scopes: MailboxMemberScope[];
}

/** A team mailbox as the directory stores it, with its members in the order in which they joined. */
export interface TeamMailboxRecord {
	id: string;
	display_name: string;
	address: string;
	member_ids: string[];
	members: TeamMailboxMemberRecord[];
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

/** A team mailbox for one of its members, with the scopes of that membership. */
export interface MemberMailboxRecord extends MailboxRecord {
	scopes: MailboxMemberScope[];
}

type TeamMailboxRow = Omit<TeamMailboxRecord, "member_ids" | "members">;

/**
 * The scopes of a membership, from the stored JSON list. A value that is not a list of mail scopes gives
 * no scope for the unknown parts, so a bad row never gives access.
 */
function parseMemberScopes(stored: string): MailboxMemberScope[] {
	let value: unknown;
	try {
		value = JSON.parse(stored);
	} catch {
		return [];
	}
	return Array.isArray(value) ? MAILBOX_MEMBER_SCOPES.filter((scope) => value.includes(scope)) : [];
}

/** The stored form of the scopes of a membership: in the order of `MAILBOX_MEMBER_SCOPES`, each one time. */
function storedMemberScopes(scopes: readonly MailboxMemberScope[]): string {
	return JSON.stringify(MAILBOX_MEMBER_SCOPES.filter((scope) => scopes.includes(scope)));
}

function withMembers(row: TeamMailboxRow, members: TeamMailboxMemberRecord[]): TeamMailboxRecord {
	return { ...row, member_ids: members.map((member) => member.principal_id), members };
}

const TEAM_MAILBOX_SELECT = "SELECT id, display_name, address, created_at FROM team_mailboxes";

export function isTeamMailboxId(id: string): boolean {
	return id.startsWith(`${TEAM_MAILBOX_PREFIX}_`);
}

async function membersOf(db: D1Database, mailboxId: string): Promise<TeamMailboxMemberRecord[]> {
	const { results } = await db
		.prepare(
			"SELECT principal_id, scopes FROM team_mailbox_members WHERE mailbox_id = ? ORDER BY created_at, principal_id",
		)
		.bind(mailboxId)
		.all<{ principal_id: string; scopes: string }>();
	return results.map((row) => ({ principal_id: row.principal_id, scopes: parseMemberScopes(row.scopes) }));
}

export async function getTeamMailbox(db: D1Database, id: string): Promise<TeamMailboxRecord | null> {
	const row = await db.prepare(`${TEAM_MAILBOX_SELECT} WHERE id = ?`).bind(id).first<TeamMailboxRow>();
	return row ? withMembers(row, await membersOf(db, id)) : null;
}

/** Every team mailbox, by name, each with its members in the order in which they joined. */
export async function listTeamMailboxes(db: D1Database): Promise<TeamMailboxRecord[]> {
	type MemberRow = { mailbox_id: string; principal_id: string; scopes: string };
	const [mailboxes, members] = await db.batch<TeamMailboxRow | MemberRow>([
		db.prepare(`${TEAM_MAILBOX_SELECT} ORDER BY display_name, id`),
		db.prepare("SELECT mailbox_id, principal_id, scopes FROM team_mailbox_members ORDER BY created_at, principal_id"),
	]);
	const byMailbox = new Map<string, TeamMailboxMemberRecord[]>();
	for (const row of (members?.results ?? []) as MemberRow[]) {
		const member = { principal_id: row.principal_id, scopes: parseMemberScopes(row.scopes) };
		byMailbox.set(row.mailbox_id, [...(byMailbox.get(row.mailbox_id) ?? []), member]);
	}
	return ((mailboxes?.results ?? []) as TeamMailboxRow[]).map((row) => withMembers(row, byMailbox.get(row.id) ?? []));
}

/**
 * Creates a team mailbox and its first members in one transaction. `widen` gives the access that the agents
 * of the first members get with the mailbox: the same transaction writes it. Returns null, and writes
 * nothing, while a directory reset is in progress: the reset pauses the mailboxes that exist when it starts.
 * It also returns null, and writes nothing, when the access of one of these agents changed after its read.
 */
export async function createTeamMailbox(
	db: D1Database,
	input: { display_name: string; address: string; member_ids: readonly string[]; created_by: string },
	widen: (mailboxId: string) => AgentWidening[] = () => [],
): Promise<TeamMailboxRecord | null> {
	const id = newId(TEAM_MAILBOX_PREFIX);
	const now = new Date().toISOString();
	const memberIds = [...new Set(input.member_ids)];
	const widenings = widen(id);
	const versions = widenings.map(({ agent }) => ({ id: agent.id, version: agent.access_version }));
	try {
		const [created] = await db.batch([
			db
				.prepare(
					`INSERT INTO team_mailboxes (id, display_name, address, created_by, created_at)
					SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM setup_lock WHERE token IS NOT NULL)
					AND NOT EXISTS (
						SELECT 1 FROM json_each(?6) expected JOIN principals p ON p.id = json_extract(expected.value, '$.id')
						WHERE p.access_version != json_extract(expected.value, '$.version')
					)`,
				)
				.bind(id, input.display_name, normalizeAddress(input.address), input.created_by, now, JSON.stringify(versions)),
			...memberIds.map((principalId) =>
				db
					.prepare(
						`INSERT INTO team_mailbox_members (mailbox_id, principal_id, added_by, created_at)
						SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM team_mailboxes WHERE id = ?1)
						AND EXISTS (SELECT 1 FROM principals WHERE id = ?2 AND deleted_at IS NULL)`,
					)
					.bind(id, principalId, input.created_by, now),
			),
			...widenings.map((widening) => widenAgentAccessStatement(db, widening, id)),
		]);
		if (!created?.meta.changes) return null;
	} catch (error) {
		throw conflictOf(error) ?? error;
	}
	return getTeamMailbox(db, id);
}

/** Changes the name of a team mailbox. Returns false when the mailbox is gone, for example after a reset. */
export async function renameTeamMailbox(db: D1Database, id: string, displayName: string): Promise<boolean> {
	const result = await db
		.prepare("UPDATE team_mailboxes SET display_name = ? WHERE id = ?")
		.bind(displayName, id)
		.run();
	return result.meta.changes === 1;
}

/**
 * Adds a member with these scopes, or gives a member these scopes. Without `scopes`, a new member gets each
 * scope, and a member keeps its scopes: a second call changes nothing. Returns false when the mailbox has
 * the most members that it can have, or when the principal was deleted during the request.
 *
 * `widening` is the access that an agent gets with the membership. The same transaction writes it. Then the
 * call also returns false, and writes nothing, when the access of the agent changed after its read.
 */
export async function addTeamMailboxMember(
	db: D1Database,
	mailboxId: string,
	principalId: string,
	addedBy: string,
	scopes?: readonly MailboxMemberScope[],
	widening?: AgentWidening,
): Promise<boolean> {
	const stored = scopes === undefined ? null : storedMemberScopes(scopes);
	const version = widening?.agent.access_version ?? null;
	const [updated, inserted, widened] = await db.batch([
		// A member takes no new place, so the count does not apply to a change of its scopes.
		db
			.prepare(
				`UPDATE team_mailbox_members SET scopes = COALESCE(?3, scopes) WHERE mailbox_id = ?1 AND principal_id = ?2
				AND (?4 IS NULL OR EXISTS (SELECT 1 FROM principals WHERE id = ?2 AND access_version = ?4))`,
			)
			.bind(mailboxId, principalId, stored, version),
		// The count is in the statement, so two parallel calls cannot go past the limit. A member has a row,
		// so the insert then changes nothing.
		db
			.prepare(
				`INSERT INTO team_mailbox_members (mailbox_id, principal_id, added_by, created_at, scopes)
				SELECT ?1, ?2, ?3, ?4, ?6
				WHERE (SELECT COUNT(*) FROM team_mailbox_members WHERE mailbox_id = ?1) < ?5
				AND EXISTS (SELECT 1 FROM principals WHERE id = ?2 AND deleted_at IS NULL AND (?7 IS NULL OR access_version = ?7))
				ON CONFLICT DO NOTHING`,
			)
			.bind(
				mailboxId,
				principalId,
				addedBy,
				new Date().toISOString(),
				TEAM_MAILBOX_LIMITS.members,
				stored ?? storedMemberScopes(MAILBOX_MEMBER_SCOPES),
				version,
			),
		...(widening ? [widenAgentAccessStatement(db, widening, mailboxId)] : []),
	]);
	// The statement of the agent matches only with the membership, so its result is the result of the three.
	if (widening) return widened?.meta.changes === 1;
	return updated?.meta.changes === 1 || inserted?.meta.changes === 1;
}

export async function removeTeamMailboxMember(db: D1Database, mailboxId: string, principalId: string): Promise<void> {
	await db
		.prepare("DELETE FROM team_mailbox_members WHERE mailbox_id = ? AND principal_id = ?")
		.bind(mailboxId, principalId)
		.run();
}

/** The scopes of a member in a team mailbox, or null for a principal that is not a member. */
export async function teamMailboxMemberScopes(
	db: D1Database,
	mailboxId: string,
	principalId: string,
): Promise<MailboxMemberScope[] | null> {
	const row = await db
		.prepare("SELECT scopes FROM team_mailbox_members WHERE mailbox_id = ? AND principal_id = ?")
		.bind(mailboxId, principalId)
		.first<{ scopes: string }>();
	return row ? parseMemberScopes(row.scopes) : null;
}

/** The team mailboxes that a principal is a member of, by name, each with the scopes of the membership. */
export async function teamMailboxesOf(db: D1Database, principalId: string): Promise<MemberMailboxRecord[]> {
	const { results } = await db
		.prepare(
			`SELECT t.id, 'team' AS kind, t.address, t.display_name, m.scopes FROM team_mailboxes t
			JOIN team_mailbox_members m ON m.mailbox_id = t.id
			WHERE m.principal_id = ? ORDER BY t.display_name, t.id`,
		)
		.bind(principalId)
		.all<MailboxRecord & { scopes: string }>();
	return results.map((row) => ({ ...row, scopes: parseMemberScopes(row.scopes) }));
}

/**
 * The team mailbox with this id, for a member. Throws `not_found` for an unknown id and `forbidden`
 * for a principal that is not a member, or for a member without one of the scopes in `needed`. Each call
 * reads the directory, so removed access and a removed scope end at once.
 */
export async function teamMailboxFor(
	db: D1Database,
	mailboxId: string,
	principalId: string,
	needed: readonly MailboxMemberScope[] = [],
): Promise<MemberMailboxRecord> {
	const row = await db
		.prepare(
			`SELECT t.id, 'team' AS kind, t.address, t.display_name, (
				SELECT m.scopes FROM team_mailbox_members m WHERE m.mailbox_id = t.id AND m.principal_id = ?2
			) AS scopes
			FROM team_mailboxes t WHERE t.id = ?1`,
		)
		.bind(mailboxId, principalId)
		.first<MailboxRecord & { scopes: string | null }>();
	if (!row) throw new OperationError("not_found", "No team mailbox has that id.");
	if (row.scopes === null) {
		throw new OperationError(
			"forbidden",
			"You are not a member of this team mailbox. An owner or an admin can add you.",
		);
	}
	const scopes = parseMemberScopes(row.scopes);
	const missing = needed.filter((scope) => !scopes.includes(scope));
	if (missing.length > 0) {
		throw new OperationError(
			"forbidden",
			`Your membership of this team mailbox does not have ${missing.join(", ")}. An owner or an admin can add it.`,
		);
	}
	return { id: row.id, kind: "team", address: row.address, display_name: row.display_name, scopes };
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
 * The own mailbox of an agent, for an owner or an admin. Throws `not_found` for an unknown id and for a
 * deleted principal, and `forbidden` for a person: the mailbox of a person is private. An archived agent
 * keeps its mailbox, so they can still read it. Each call reads the directory.
 */
export async function agentMailboxFor(db: D1Database, principalId: string): Promise<MailboxRecord> {
	// A deleted principal has no address, so the join leaves it out.
	const agent = await db.prepare(`${AGENT_MAILBOX_SELECT} AND p.id = ?`).bind(principalId).first<MailboxRecord>();
	if (agent) return { id: agent.id, kind: "agent", address: agent.address, display_name: agent.display_name };
	const exists = await db
		.prepare("SELECT 1 AS found FROM principals WHERE id = ? AND deleted_at IS NULL")
		.bind(principalId)
		.first();
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

import directorySchema from "../../migrations/0001_directory.sql";
import mailDomainSchema from "../../migrations/0003_mail_domains.sql";
import passwordSchema from "../../migrations/0004_password_sign_in.sql";
import teamMailboxSchema from "../../migrations/0005_team_mailboxes.sql";
import { log, OperationError, randomToken } from "../platform/index.ts";
import { allMailboxIds } from "./team-mailboxes.ts";

/** Freezes principal creation and waits for old outbound side effects before a reset. */
export async function prepareFreshDirectory(env: Env) {
	const token = randomToken(32);
	const now = Date.now();
	const generation =
		await env.DIRECTORY.prepare(`UPDATE setup_lock SET token = ?, expires_at = ?, generation = generation + 1
		WHERE id = 1 AND (token IS NULL OR expires_at < ?) RETURNING generation`)
			.bind(token, now + 10 * 60 * 1000, now)
			.first<number>("generation");
	if (generation === null) throw new OperationError("conflict", "A directory reset is already in progress.");
	let mailboxes: DurableObjectStub<import("../mail/index.ts").MailboxDO>[] = [];
	async function finish(committed: boolean) {
		const results = await Promise.allSettled(
			mailboxes.map((mailbox) => (committed ? mailbox.cancelDeliveries(token) : mailbox.resumeDeliveries(token))),
		);
		for (const result of results)
			if (result.status === "rejected")
				log("error", "mailbox reset cleanup failed", { committed, error: String(result.reason) });
		if (!committed) await env.DIRECTORY.prepare("UPDATE setup_lock SET token = NULL WHERE token = ?").bind(token).run();
	}
	try {
		// The mailbox of each principal and each team mailbox: a team mailbox also has an outbox.
		const ids = await allMailboxIds(env.DIRECTORY);
		mailboxes = ids.map((id) => env.MAILBOX.get(env.MAILBOX.idFromName(id)));
		const paused = await Promise.allSettled(mailboxes.map((mailbox) => mailbox.pauseDeliveries(token, generation)));
		const failed = paused.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		return {
			statements: [
				// A lost lease violates the id CHECK and rolls back the whole batch before any reset.
				env.DIRECTORY.prepare(`INSERT INTO setup_lock (id, token, expires_at)
					VALUES (CASE WHEN EXISTS (SELECT 1 FROM setup_lock WHERE token = ?) THEN 1 ELSE 0 END, ?, ?)
					ON CONFLICT (id) DO UPDATE SET token = excluded.token`).bind(token, token, now + 10 * 60 * 1000),
				...freshDirectoryStatements(env.DIRECTORY),
				env.DIRECTORY.prepare("UPDATE setup_lock SET token = NULL WHERE token = ?").bind(token),
			],
			finish,
		};
	} catch (error) {
		await finish(false);
		throw error;
	}
}

/**
 * Recreates the directory in the same transaction as the new owner and key. It runs the directory
 * migrations in order, so a fresh directory has the same schema as an upgraded one.
 */
function freshDirectoryStatements(db: D1Database): D1PreparedStatement[] {
	// The base schema has no triggers. Later migrations use explicit statement markers for their triggers.
	const schema = directorySchema
		.replace(/--[^\n]*/g, "")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
	return [
		// The team mailbox tables refer to principals, and one trigger on mail_domains refers to them. They
		// go first: a rename in the replay of 0004 fails while a trigger refers to a missing table.
		"DROP TRIGGER IF EXISTS mail_domain_in_use_team",
		"DROP TABLE IF EXISTS team_mailbox_members",
		"DROP TABLE IF EXISTS team_mailboxes",
		"DROP TABLE IF EXISTS sessions",
		"DROP TABLE IF EXISTS sign_in_codes",
		"DROP TABLE IF EXISTS api_keys",
		"DROP TABLE IF EXISTS addresses",
		// Remove references from agents before SQLite deletes the principals table.
		"DELETE FROM principals WHERE kind = 'agent'",
		"DROP TABLE principals",
		...schema,
		...mailDomainSchema.split("--> statement-breakpoint"),
		...passwordSchema.split("--> statement-breakpoint"),
		...teamMailboxSchema.split("--> statement-breakpoint"),
		// The directory now has the schema of each bundled migration. Record them in the table that
		// `wrangler d1 migrations apply` reads, or it runs them again later. A second run of 0004 would
		// copy the principals without their passwords. The columns are the ones that wrangler creates.
		`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
			applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`,
		`INSERT OR IGNORE INTO d1_migrations (name) VALUES ${BUNDLED_MIGRATIONS.map((name) => `('${name}')`).join(", ")}`,
	].map((statement) => db.prepare(statement));
}

/** The directory migrations that a fresh start leaves applied. 0002 made `setup_lock`, which the reset needs. */
const BUNDLED_MIGRATIONS = [
	"0001_directory.sql",
	"0002_setup_lock.sql",
	"0003_mail_domains.sql",
	"0004_password_sign_in.sql",
	"0005_team_mailboxes.sql",
] as const;

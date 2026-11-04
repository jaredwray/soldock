import directorySchema from "../../migrations/0001_directory.sql";
import { log, OperationError, randomToken } from "../platform/index.ts";

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
		const { results } = await env.DIRECTORY.prepare("SELECT id FROM principals").all<{ id: string }>();
		mailboxes = results.map(({ id }) => env.MAILBOX.get(env.MAILBOX.idFromName(id)));
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

/** Recreates the directory in the same transaction as the new owner and key. */
function freshDirectoryStatements(db: D1Database): D1PreparedStatement[] {
	// The schema has no triggers or semicolons in string literals. Add future migrations here too.
	const schema = directorySchema
		.replace(/--[^\n]*/g, "")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
	return [
		"DROP TABLE IF EXISTS sessions",
		"DROP TABLE IF EXISTS sign_in_codes",
		"DROP TABLE IF EXISTS api_keys",
		"DROP TABLE IF EXISTS addresses",
		// Remove references from agents before SQLite deletes the principals table.
		"DELETE FROM principals WHERE kind = 'agent'",
		"DROP TABLE principals",
		...schema,
	].map((statement) => db.prepare(statement));
}

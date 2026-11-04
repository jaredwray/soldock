import directorySchema from "../../migrations/0001_directory.sql";

/** Recreates the directory in the same transaction as the new owner and key. */
export function freshDirectoryStatements(db: D1Database): D1PreparedStatement[] {
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

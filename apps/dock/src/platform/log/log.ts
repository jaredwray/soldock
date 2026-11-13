type Level = "debug" | "info" | "warn" | "error";

/**
 * Writes one structured JSON log line. Never pass message content, secrets or full addresses of
 * external people: logs leave the mailbox boundary.
 */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
	const line = JSON.stringify({ level, msg, ...fields });
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);
}

/**
 * The audit record of a mutating operation. Until the audit log in R2 exists, it goes to Workers
 * Logs with `audit: true`, so it can be found and exported.
 */
export function audit(fields: {
	op: string;
	actor: string;
	actorKind: string;
	credential: string;
	target?: string;
	/** The mailbox of a mail operation, when it is not the own mailbox of the actor. */
	mailbox?: string;
	result: "ok" | "denied" | "error";
	requestId?: string;
	code?: string;
}): void {
	log("info", "audit", { audit: true, ...fields });
}

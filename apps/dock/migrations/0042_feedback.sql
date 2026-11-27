-- The feedback settings of the organization. One row. An owner or an admin changes it in Admin › General.
CREATE TABLE feedback_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	-- 1: people can send bug reports and ideas as public GitHub issues. Off by default.
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
	-- The GitHub repository of the issues.
	repo_owner TEXT NOT NULL DEFAULT 'jaredwray',
	repo_name TEXT NOT NULL DEFAULT 'soldock',
	-- The GitHub token that creates the issues. Sealed with ENCRYPTION_KEY when it is set. No answer, log or
	-- audit line contains it.
	github_token TEXT,
	updated_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO feedback_settings (id) VALUES (1);
--> statement-breakpoint
-- One row for each report. The title and the description are not here: the GitHub issue holds them.
CREATE TABLE feedback_reports (
	id TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('bug', 'idea')),
	status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
	issue_number INTEGER,
	issue_url TEXT,
	idempotency_key TEXT,
	-- The requests to GitHub for this row. A failed row can try again with the same key, at most
	-- FEEDBACK_LIMITS.attemptsPerReport times in all.
	attempts INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX feedback_reports_key ON feedback_reports (principal_id, idempotency_key)
	WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX feedback_reports_principal ON feedback_reports (principal_id, created_at);
--> statement-breakpoint
CREATE INDEX feedback_reports_created ON feedback_reports (created_at);
--> statement-breakpoint
-- One row for each screenshot or screen recording. The bytes are in R2 BLOBS at `feedback/<id>`. Only the
-- SHA-256 of the token of the public address is here.
CREATE TABLE feedback_attachments (
	id TEXT PRIMARY KEY,
	principal_id TEXT NOT NULL,
	-- Null until a sent report holds the attachment.
	report_id TEXT,
	token_hash TEXT NOT NULL,
	mime_type TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
	size INTEGER NOT NULL,
	width INTEGER,
	height INTEGER,
	created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX feedback_attachments_report ON feedback_attachments (report_id);
--> statement-breakpoint
CREATE INDEX feedback_attachments_principal ON feedback_attachments (principal_id, created_at);

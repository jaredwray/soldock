-- The mail settings of the organization. One row. An owner or an admin changes it in Admin › Mail.
CREATE TABLE mail_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	-- 1: the Screener is on in each mailbox of a person and each team mailbox whose setting is inherit.
	screener_default INTEGER NOT NULL DEFAULT 0 CHECK (screener_default IN (0, 1)),
	updated_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
INSERT INTO mail_settings (id) VALUES (1);

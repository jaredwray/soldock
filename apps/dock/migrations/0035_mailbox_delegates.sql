-- The delegates of a mailbox: the people and agents that a person lets use their own mailbox. A mailbox has
-- no delegate until its owner adds one, so the own mailbox of each person stays private by default. Only the
-- owner of the mailbox changes this list (`mail.set_delegate`, `mail.remove_delegate`): never an owner or an
-- admin of the organization for a different person, and never an agent.
-- `mailbox_id` is the id of the person who owns the mailbox. `principal_id` is the delegate. `scopes` is what
-- the delegate can do in the mailbox, as a JSON list of `mail.read`, `mail.modify` and `mail.send`, as for a
-- member of a team mailbox (migration 0029).
-- A Worker from before this migration does not read the table, so a grant gives nothing there.
-- The statement markers let a fresh reset replay this file without a SQL parser.
CREATE TABLE IF NOT EXISTS mailbox_delegates (
	mailbox_id TEXT NOT NULL REFERENCES principals (id),
	principal_id TEXT NOT NULL REFERENCES principals (id),
	scopes TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (mailbox_id, principal_id),
	CHECK (mailbox_id <> principal_id)
) WITHOUT ROWID;
--> statement-breakpoint
-- `mail.list_mailboxes` reads the mailboxes that a principal can use.
CREATE INDEX IF NOT EXISTS mailbox_delegates_principal ON mailbox_delegates (principal_id);

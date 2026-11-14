-- Owners and admins archive and delete people and agents. Both columns are nullable, so the Worker from
-- before this migration still reads and writes the directory while the deploy applies it.
-- The statement markers let a fresh reset replay this file without a SQL parser.

-- An archived principal cannot sign in or use a credential. Its data stays. A restore clears the column.
ALTER TABLE principals ADD COLUMN archived_at TEXT;
--> statement-breakpoint
-- A deleted principal keeps its row, so the references of keys, team mailboxes and OAuth rows to it stay
-- valid. Its addresses, sessions and team mailbox memberships go, and its credentials stop. No query of
-- the directory returns it, because each one needs its primary address or checks this column.
ALTER TABLE principals ADD COLUMN deleted_at TEXT;

-- Mailbox aliases: extra addresses that receive mail for a mailbox. Mail from the mailbox always uses its
-- primary address. Only an owner or an admin adds or removes an alias.
-- The alias of the own mailbox of a principal is a row of `addresses` with `is_primary = 0`. That table and
-- its triggers (migrations 0003, 0004 and 0005) already give one owner for each address, so it needs no
-- change. The alias of a team mailbox is a row of the table below.
-- Principals, team mailboxes and aliases share one set of addresses. The triggers below keep an address in
-- one place only, in the transaction of the write. No statement changes the address of a row, so checks
-- before an insert are sufficient.
-- A Worker from before this migration delivers mail for a personal alias, because it reads each row of
-- `addresses`. It does not read the table below, so it rejects mail to a team alias.
-- The statement markers let a fresh reset replay this file without a SQL parser.
CREATE TABLE IF NOT EXISTS team_mailbox_aliases (
	-- Lowercase, without a +tag, on a saved mail domain.
	address TEXT PRIMARY KEY,
	mailbox_id TEXT NOT NULL REFERENCES team_mailboxes (id),
	created_by TEXT NOT NULL REFERENCES principals (id),
	created_at TEXT NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS team_mailbox_aliases_mailbox ON team_mailbox_aliases (mailbox_id);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS team_mailbox_alias_address_free BEFORE INSERT ON team_mailbox_aliases
WHEN EXISTS (SELECT 1 FROM addresses WHERE address = NEW.address)
	OR EXISTS (SELECT 1 FROM team_mailboxes WHERE address = NEW.address)
BEGIN
	SELECT RAISE(ABORT, 'address_in_use');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS address_not_team_mailbox_alias BEFORE INSERT ON addresses
WHEN EXISTS (SELECT 1 FROM team_mailbox_aliases WHERE address = NEW.address)
BEGIN
	SELECT RAISE(ABORT, 'address_in_use');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS team_mailbox_not_alias BEFORE INSERT ON team_mailboxes
WHEN EXISTS (SELECT 1 FROM team_mailbox_aliases WHERE address = NEW.address)
BEGIN
	SELECT RAISE(ABORT, 'address_in_use');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS team_mailbox_alias_mail_domain BEFORE INSERT ON team_mailbox_aliases
WHEN NOT EXISTS (SELECT 1 FROM mail_domains WHERE domain = substr(NEW.address, instr(NEW.address, '@') + 1))
BEGIN
	SELECT RAISE(ABORT, 'address_mail_domain');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS mail_domain_in_use_team_alias BEFORE DELETE ON mail_domains
WHEN EXISTS (SELECT 1 FROM team_mailbox_aliases WHERE substr(address, instr(address, '@') + 1) = OLD.domain)
BEGIN
	SELECT RAISE(ABORT, 'mail_domain_in_use');
END;

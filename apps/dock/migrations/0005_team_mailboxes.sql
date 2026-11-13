-- Team mailboxes: a mailbox with its own address that a list of people and agents shares. A team
-- mailbox is not a principal: it has no credential. Each member uses it with their own credential.
-- The statement markers let a fresh reset replay this file without a SQL parser.
CREATE TABLE IF NOT EXISTS team_mailboxes (
	id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL,
	-- Lowercase, without a +tag, on a saved mail domain. Team mailboxes and principals share one set of
	-- addresses: the triggers below keep an address out of `addresses` and this table at the same time.
	address TEXT NOT NULL UNIQUE,
	created_by TEXT NOT NULL REFERENCES principals (id),
	created_at TEXT NOT NULL
);
--> statement-breakpoint
-- The people and agents that can use a team mailbox. Only an owner or an admin changes this list.
CREATE TABLE IF NOT EXISTS team_mailbox_members (
	mailbox_id TEXT NOT NULL REFERENCES team_mailboxes (id),
	principal_id TEXT NOT NULL REFERENCES principals (id),
	added_by TEXT NOT NULL REFERENCES principals (id),
	created_at TEXT NOT NULL,
	PRIMARY KEY (mailbox_id, principal_id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS team_mailbox_members_principal ON team_mailbox_members (principal_id);
--> statement-breakpoint
-- These checks share the write transaction, so concurrent account, team mailbox and domain changes stay valid.
CREATE TRIGGER IF NOT EXISTS team_mailbox_address_free BEFORE INSERT ON team_mailboxes
WHEN EXISTS (SELECT 1 FROM addresses WHERE address = NEW.address)
BEGIN
	SELECT RAISE(ABORT, 'address_in_use');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS address_not_team_mailbox BEFORE INSERT ON addresses
WHEN EXISTS (SELECT 1 FROM team_mailboxes WHERE address = NEW.address)
BEGIN
	SELECT RAISE(ABORT, 'address_in_use');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS team_mailbox_mail_domain BEFORE INSERT ON team_mailboxes
WHEN NOT EXISTS (SELECT 1 FROM mail_domains WHERE domain = substr(NEW.address, instr(NEW.address, '@') + 1))
BEGIN
	SELECT RAISE(ABORT, 'address_mail_domain');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS mail_domain_in_use_team BEFORE DELETE ON mail_domains
WHEN EXISTS (SELECT 1 FROM team_mailboxes WHERE substr(address, instr(address, '@') + 1) = OLD.domain)
BEGIN
	SELECT RAISE(ABORT, 'mail_domain_in_use');
END;

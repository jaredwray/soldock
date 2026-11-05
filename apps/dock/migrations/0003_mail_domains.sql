-- Mail domains are admin settings. Keep the domains of existing mailbox addresses on upgrade.
-- The statement markers also let a fresh reset restore the triggers without a SQL parser.
CREATE TABLE IF NOT EXISTS mail_domains (
	domain TEXT PRIMARY KEY NOT NULL CHECK (domain = lower(domain))
);
--> statement-breakpoint
INSERT OR IGNORE INTO mail_domains (domain)
SELECT DISTINCT lower(substr(address, instr(address, '@') + 1)) FROM addresses;
--> statement-breakpoint
-- These checks share the write transaction, so concurrent settings and account changes stay valid.
CREATE TRIGGER IF NOT EXISTS mail_domain_in_use BEFORE DELETE ON mail_domains
WHEN EXISTS (SELECT 1 FROM addresses WHERE substr(address, instr(address, '@') + 1) = OLD.domain)
BEGIN
	SELECT RAISE(ABORT, 'mail_domain_in_use');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS mail_domain_sign_in BEFORE INSERT ON mail_domains
WHEN EXISTS (SELECT 1 FROM principals WHERE substr(sign_in_email, instr(sign_in_email, '@') + 1) = NEW.domain)
BEGIN
	SELECT RAISE(ABORT, 'mail_domain_sign_in');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS address_mail_domain BEFORE INSERT ON addresses
WHEN NOT EXISTS (SELECT 1 FROM mail_domains WHERE domain = substr(NEW.address, instr(NEW.address, '@') + 1))
BEGIN
	SELECT RAISE(ABORT, 'address_mail_domain');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS principal_sign_in_domain BEFORE INSERT ON principals
WHEN EXISTS (SELECT 1 FROM mail_domains WHERE domain = substr(NEW.sign_in_email, instr(NEW.sign_in_email, '@') + 1))
BEGIN
	SELECT RAISE(ABORT, 'principal_sign_in_domain');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS update_sign_in_domain BEFORE UPDATE OF sign_in_email ON principals
WHEN EXISTS (SELECT 1 FROM mail_domains WHERE domain = substr(NEW.sign_in_email, instr(NEW.sign_in_email, '@') + 1))
BEGIN
	SELECT RAISE(ABORT, 'principal_sign_in_domain');
END;

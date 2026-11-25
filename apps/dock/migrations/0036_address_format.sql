-- The address format of the organization. The New member form of the web app fills in the address of a new
-- person from the display name in this format. An owner or an admin changes it in Admin › Mail.
-- The deploy applies the migrations while the Worker from before runs. That Worker does not read the columns,
-- and the defaults give each column a value.
-- 1: the form fills in the address. 0: the admin types each address.
ALTER TABLE mail_settings ADD COLUMN address_format_enabled INTEGER NOT NULL DEFAULT 1 CHECK (address_format_enabled IN (0, 1));
--> statement-breakpoint
-- first.last: ada.lovelace. first: ada. flast: alovelace, the first letter of the first name and the last name.
ALTER TABLE mail_settings ADD COLUMN address_format TEXT NOT NULL DEFAULT 'first.last' CHECK (address_format IN ('first.last', 'first', 'flast'));

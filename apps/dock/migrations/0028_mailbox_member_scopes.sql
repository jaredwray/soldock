-- What a member can do in a team mailbox: the mail scopes of the membership, as a JSON list of `mail.read`,
-- `mail.modify` and `mail.send`. The rule is the same for a person, an agent and a service account. An owner or
-- an admin sets the scopes in the settings of the mailbox.
-- A member from before this migration keeps the three scopes: each member could read the mailbox, change it and
-- send from it. The deploy applies the migrations while the Worker from before runs. That Worker does not name
-- the column in its insert, so a member that it adds gets the default too.
-- The statement markers let a fresh reset replay this file without a SQL parser.
ALTER TABLE team_mailbox_members ADD COLUMN scopes TEXT NOT NULL DEFAULT '["mail.read","mail.modify","mail.send"]';

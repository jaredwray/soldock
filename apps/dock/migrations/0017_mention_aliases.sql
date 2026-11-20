-- The name aliases of a mention of Chat, so the room reads only the principals that a message can name, not
-- the whole directory. `alias_first` is the first word of the display name, and `alias_full` is the full
-- name without spaces, each in lowercase and without accents (`nameAliasParts` in the contracts). Null is a
-- part that is no alias. A create and a rename of a principal write them.
-- `aliases_set` is 0 for a row from before this migration: SQL cannot remove the accents of a name the way
-- the contracts do. The mention read always reads these rows, and writes their aliases, a batch at a time.
-- A deleted principal has no address, so the read never finds it: its row is not in the index of unset rows.
-- The previous Worker does not read or write these columns. A principal that it creates gets 0. A rename
-- that keeps both aliases as they were gets 0 from the trigger at the end, so the read writes them again.
-- A rename of this Worker that gives the same aliases fires it too. D1 counts the write of the trigger in
-- `meta.changes`, so the rename counts its own rows with RETURNING.
ALTER TABLE principals ADD COLUMN alias_first TEXT;
--> statement-breakpoint
ALTER TABLE principals ADD COLUMN alias_full TEXT;
--> statement-breakpoint
ALTER TABLE principals ADD COLUMN aliases_set INTEGER NOT NULL DEFAULT 0 CHECK (aliases_set IN (0, 1));
--> statement-breakpoint
CREATE INDEX principals_alias_first ON principals (alias_first) WHERE alias_first IS NOT NULL;
--> statement-breakpoint
CREATE INDEX principals_alias_full ON principals (alias_full) WHERE alias_full IS NOT NULL;
--> statement-breakpoint
CREATE INDEX principals_aliases_unset ON principals (id) WHERE aliases_set = 0 AND deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER principals_aliases_stale AFTER UPDATE OF display_name ON principals
WHEN NEW.display_name IS NOT OLD.display_name AND NEW.alias_first IS OLD.alias_first
	AND NEW.alias_full IS OLD.alias_full
BEGIN
	UPDATE principals SET aliases_set = 0 WHERE id = NEW.id;
END;

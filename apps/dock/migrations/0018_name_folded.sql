-- The display name in the form of a search: lowercase and without accents, with its spaces (`searchFold` in
-- the contracts). `directory.list_principals` finds a part of it, so "garcia" finds "María García" as the
-- `@` list of Chat does. A create, a rename and the fill of the mention read write it, with the aliases.
-- Each row gets `aliases_set = 0`, so the next mention read writes this column too.
-- The trigger of 0017 marks a rename that keeps the aliases. The Worker of 0017 writes the aliases but not
-- this column, so the trigger now marks each rename that keeps `name_folded` as it was. A rename of this
-- Worker that gives the same folded name fires it too, which costs one more write only: the rename counts
-- its rows with RETURNING.
ALTER TABLE principals ADD COLUMN name_folded TEXT;
--> statement-breakpoint
DROP TRIGGER principals_aliases_stale;
--> statement-breakpoint
CREATE TRIGGER principals_aliases_stale AFTER UPDATE OF display_name ON principals
WHEN NEW.display_name IS NOT OLD.display_name AND NEW.name_folded IS OLD.name_folded
BEGIN
	UPDATE principals SET aliases_set = 0 WHERE id = NEW.id;
END;
--> statement-breakpoint
UPDATE principals SET aliases_set = 0 WHERE deleted_at IS NULL;

-- The display name in the form of a search: lowercase and without accents, with its spaces (`searchFold` in
-- the contracts). `directory.list_principals` finds a part of it, so "garcia" finds "María García" as the
-- `@` list of Chat does. A create, a rename and the fill write it, with the aliases of 0017.
-- A live row needs the fill when `aliases_set = 0` or `name_folded IS NULL`. This column has its own mark
-- (NULL): the Worker of 0017 writes `aliases_set = 1` in its fill and its create, but not this column. The
-- index of 0017 stays, because that Worker names it in its read.
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
CREATE INDEX principals_names_unset ON principals (id)
	WHERE (aliases_set = 0 OR name_folded IS NULL) AND deleted_at IS NULL;

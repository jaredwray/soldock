-- The order of `directory.list_principals`: the kind, the display name, then the id. With this index, a
-- page in the order of the names reads its rows in that order and stops at its limit. Without it, each
-- page reads and sorts the whole table.
CREATE INDEX principals_directory_order ON principals (kind, display_name, id);

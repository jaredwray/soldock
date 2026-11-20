-- API keys: the resource limits of a key, as JSON (`KeyLimits` of the contracts). NULL: a key without limits.
-- A limit tells where a key works: which drives and folders, which mail, and which recipients and rooms.
-- The secret of a key with limits starts with `sdl_`. The previous Worker accepts only `sdk_` secrets, so it
-- refuses a key with limits. It never uses such a key without its limits, also after a rollback.
-- A fresh reset replays this file. It has one statement, so it needs no statement marker.

ALTER TABLE api_keys ADD COLUMN limits TEXT;

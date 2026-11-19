-- Link previews of Chat: a cache of the facts of a web page, so a link in many messages costs one fetch.
-- The key is the SHA-256 of the address. The cache does not keep the address itself.
-- A failed fetch is kept for a shorter time. Each write deletes some expired rows.
-- The cache holds no picture: each message stores the picture of its own preview.
CREATE TABLE link_previews (
	url_hash TEXT PRIMARY KEY,
	result_json TEXT NOT NULL,
	fetched_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX link_previews_expires ON link_previews (expires_at);

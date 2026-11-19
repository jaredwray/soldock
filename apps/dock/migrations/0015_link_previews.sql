-- Link previews of Chat: a cache of the facts of a web page, so a link in many messages costs one fetch.
-- The key is the SHA-256 of the address. A failed fetch is kept for a shorter time.
-- The cache holds no picture: each message stores the picture of its own preview.
CREATE TABLE link_previews (
	url_hash TEXT PRIMARY KEY,
	url TEXT NOT NULL,
	result_json TEXT NOT NULL,
	fetched_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX link_previews_expires ON link_previews (expires_at);

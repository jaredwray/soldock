-- The requests of agents and service accounts to share a Drive item with a different agent or service
-- account. An agent cannot give such an account a grant itself: a person who manages that account approves or
-- denies the request. One row is one request that waits for that person. An approval and a denial delete the
-- row. `item_name` is the name of the item at the time of the request, for the lists. `notified_id` is the
-- person who got the request in the activity list of Chat, or null.
-- The deploy applies the migrations while the Worker from before runs. That Worker does not read the table.
CREATE TABLE drive_share_requests (
	id TEXT PRIMARY KEY,
	space_id TEXT NOT NULL,
	item_id TEXT NOT NULL,
	item_name TEXT NOT NULL,
	principal_id TEXT NOT NULL,
	requested_by TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
	notified_id TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (space_id, item_id, principal_id)
);
--> statement-breakpoint
CREATE INDEX drive_share_requests_principal ON drive_share_requests (principal_id, created_at);
--> statement-breakpoint
CREATE INDEX drive_share_requests_requester ON drive_share_requests (requested_by, created_at);

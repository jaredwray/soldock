-- The requests of agents and service accounts to make a different agent or service account a member of a
-- room. An agent cannot add such an account itself: a person who manages the account approves or denies the
-- request. One row is one request that waits for that person. An approval and a denial delete the row.
-- `room_name` is the name of the room at the time of the request, for the lists. `notified_id` is the person
-- who got the request in the activity list of Chat, or null.
-- The deploy applies the migrations while the Worker from before runs. That Worker does not read the table.
CREATE TABLE chat_member_requests (
	id TEXT PRIMARY KEY,
	room_id TEXT NOT NULL,
	room_name TEXT,
	principal_id TEXT NOT NULL,
	requested_by TEXT NOT NULL,
	scopes TEXT NOT NULL,
	notified_id TEXT,
	created_at TEXT NOT NULL,
	UNIQUE (room_id, principal_id)
);
--> statement-breakpoint
CREATE INDEX chat_member_requests_principal ON chat_member_requests (principal_id, created_at);
--> statement-breakpoint
CREATE INDEX chat_member_requests_requester ON chat_member_requests (requested_by, created_at);

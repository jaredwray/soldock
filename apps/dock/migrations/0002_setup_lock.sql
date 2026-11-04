-- A reset blocks new principals until every old mailbox stops its outbound deliveries.
CREATE TABLE setup_lock (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	token TEXT,
	expires_at INTEGER NOT NULL,
	generation INTEGER NOT NULL DEFAULT 0
);

INSERT INTO setup_lock (id, token, expires_at) VALUES (1, NULL, 0);

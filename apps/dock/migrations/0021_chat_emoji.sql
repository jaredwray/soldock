-- One catalog for the organization. A room stores only the name of a reaction.
CREATE TABLE chat_emoji (
	name TEXT PRIMARY KEY NOT NULL,
	content_base64 TEXT NOT NULL
);

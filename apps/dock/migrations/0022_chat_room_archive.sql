-- Archived rooms keep their history for members. The public browser lists active rooms.
ALTER TABLE chat_rooms ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

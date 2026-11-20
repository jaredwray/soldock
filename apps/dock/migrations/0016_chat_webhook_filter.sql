-- Chat subscriptions: the messages that a subscription sends.
-- `all`: each message of a joined chat. `addressed`: only a message for the target of the subscription.
-- A row from before this column sends each message, as before. So does a row that the previous Worker inserts.
-- Mail and Drive do not read this column. The previous Worker does not read it either.
-- The statement markers let a fresh reset replay this file without a SQL parser.

ALTER TABLE webhook_subscriptions ADD COLUMN chat_filter TEXT NOT NULL DEFAULT 'all'
	CHECK (chat_filter IN ('all', 'addressed'));

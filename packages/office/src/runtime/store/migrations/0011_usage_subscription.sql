-- A model call on a subscription: its usd is what the API would charge, which the session's cost cap counts; the
-- subscription pays nothing for it, so cost reports leave it out.
ALTER TABLE usage ADD COLUMN subscription INTEGER NOT NULL DEFAULT 0;
-- The part of a session's cost its subscription's calls make up, at what the API would charge.
ALTER TABLE sessions ADD COLUMN subscription_cost REAL NOT NULL DEFAULT 0;

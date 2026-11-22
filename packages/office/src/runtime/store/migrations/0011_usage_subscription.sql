-- A model call on a subscription: its usd is what the API would charge, which the session's cost cap counts; the
-- subscription pays nothing for it, so cost reports leave it out.
ALTER TABLE usage ADD COLUMN subscription INTEGER NOT NULL DEFAULT 0;

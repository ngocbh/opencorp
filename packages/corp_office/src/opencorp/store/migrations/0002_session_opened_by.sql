-- Session.opened_by: the human who opened the session. NULL for rows from before it existed.
ALTER TABLE sessions ADD COLUMN opened_by TEXT;

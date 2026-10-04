-- Session.connection, .model, .model_note: the chat's model choice. NULL for rows from before them.
ALTER TABLE sessions ADD COLUMN connection TEXT;
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN model_note TEXT;
-- Feedback.failure: why learning from it failed. NULL for rows from before it.
ALTER TABLE feedback ADD COLUMN failure TEXT;

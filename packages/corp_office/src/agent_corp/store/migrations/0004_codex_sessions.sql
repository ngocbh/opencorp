-- Session.harness_model, .harness_usage (JSON) and .parent_session_id: a harness session's model, token counts,
-- and the session it continues. NULL for rows from before them.
ALTER TABLE sessions ADD COLUMN harness_model TEXT;
ALTER TABLE sessions ADD COLUMN harness_usage TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
-- Message.author: the human who sent a user message. NULL for rows from before it and for composer messages.
ALTER TABLE messages ADD COLUMN author TEXT;

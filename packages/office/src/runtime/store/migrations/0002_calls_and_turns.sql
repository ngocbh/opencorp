-- A question is a yian host call: stored once and reused by its call id. Null for a Codex request.
ALTER TABLE questions ADD COLUMN call_id TEXT;
CREATE UNIQUE INDEX questions_call ON questions (call_id) WHERE call_id IS NOT NULL;
-- Finished replies: the next fresh run's turns input.
ALTER TABLE sessions ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;

-- A session's mode: auto, default, ask or dontAsk. Sessions start in auto, and existing ones become auto.
ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto';

-- A Codex session's running turn, so a restart can tell a turn that was cut off from a card left open after one.
ALTER TABLE sessions ADD COLUMN harness_turn_id TEXT;

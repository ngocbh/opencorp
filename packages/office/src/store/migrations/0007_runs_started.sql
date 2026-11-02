-- When a run's worker said it started, so a run whose log was deleted later is told apart from one that never
-- started, after an office restart too.
ALTER TABLE runs ADD COLUMN started_at TEXT;

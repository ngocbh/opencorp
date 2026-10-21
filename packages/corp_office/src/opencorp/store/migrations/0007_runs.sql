-- Every run the office launched: who started it, what it was started from, when, and how it ended. The run log
-- (runs/<session>/runs/<run_id>.jsonl) is the record of what ran; this keeps what the log can't know. The outcome
-- columns are written once, when the office learns the run is over.
CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    flow TEXT NOT NULL,
    flow_path TEXT NOT NULL,
    driver TEXT NOT NULL,
    parent_run_id TEXT,
    launched_at TEXT NOT NULL,
    outcome TEXT,
    reason TEXT,
    failed_node TEXT,
    ended_at TEXT
);
CREATE INDEX runs_parent ON runs (parent_run_id);
CREATE INDEX runs_session ON runs (session_id);
CREATE INDEX runs_driver ON runs (driver, run_id);
CREATE INDEX runs_outcome ON runs (outcome, run_id);
-- The list's since and until filters read a range of launch times.
CREATE INDEX runs_launched ON runs (launched_at);
-- Participants and current nodes read questions by run; questions_run_node skips ask_user rows (null node_id).
CREATE INDEX questions_run ON questions (run_id);
-- A run page sums its run's usage.
CREATE INDEX usage_run ON usage (run_id);

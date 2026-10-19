-- Browsers signed in to this office's HQ listeners. Office-local, never committed to the company repo. A row holds
-- the sha256 of its cookie's secret, never the secret, and password_fp: the first 16 hex of sha256 of the person's
-- password hash when it was issued, so a password change by any writer ends the session.
CREATE TABLE hq_sessions (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    name TEXT NOT NULL,
    label TEXT,
    secret_sha256 TEXT NOT NULL UNIQUE,
    password_fp TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    via TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT
);
CREATE INDEX hq_sessions_person ON hq_sessions (person);

-- Cost reports sum usage since a time.
CREATE INDEX usage_at ON usage (at);

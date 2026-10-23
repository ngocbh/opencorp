-- The office store (design §5.1). Entity tables have one column per field of their protocol schema
-- (packages/protocol/src/schemas/); list and object fields are JSON text.
-- Enum values are not CHECKed: the protocol may add enum members without a migration.

CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    requester TEXT NOT NULL,
    assignee TEXT,
    parent_id TEXT,
    groups TEXT NOT NULL DEFAULT '[]',
    gate INTEGER NOT NULL DEFAULT 0,
    resolved_by TEXT,
    on_behalf_of TEXT,
    summary TEXT,
    cost REAL NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX work_items_assignee ON work_items (assignee, status);

CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    on_behalf_of TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX comments_work_item ON comments (work_item_id, created_at);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    harness TEXT NOT NULL,
    office TEXT NOT NULL,
    cwd TEXT NOT NULL,
    repo_commit TEXT NOT NULL,
    status TEXT NOT NULL,
    kind TEXT NOT NULL,
    waiting_on TEXT NOT NULL DEFAULT '[]',
    capped INTEGER NOT NULL DEFAULT 0,
    harness_session_id TEXT,
    work_item_id TEXT,
    question_id TEXT,
    seed TEXT,
    cost REAL NOT NULL DEFAULT 0,
    cost_cap_usd REAL,
    opened_by TEXT,
    connection TEXT,
    model TEXT,
    model_note TEXT,
    harness_model TEXT,
    harness_usage TEXT,
    parent_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX sessions_person ON sessions (person, updated_at);

-- Session.run_ids, in order.
CREATE TABLE session_runs (
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    run_id TEXT NOT NULL UNIQUE,
    seq INTEGER NOT NULL,
    PRIMARY KEY (session_id, run_id)
);

-- The office's own facts about a run; yian's run log and index hold its status, times, failure, parent and
-- tokens. ended_at is set only with end_reason (an end the office decided).
CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    driver TEXT NOT NULL,
    flow TEXT NOT NULL,
    flow_path TEXT NOT NULL,
    connection TEXT,
    model TEXT,
    config_sha256 TEXT,
    end_reason TEXT,
    ended_at TEXT,
    replaces_run_id TEXT,
    created_at TEXT NOT NULL,
    CHECK ((end_reason IS NULL) = (ended_at IS NULL))
);
CREATE INDEX runs_session ON runs (session_id);

CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    node_id TEXT,
    source TEXT NOT NULL,
    asker TEXT NOT NULL,
    work_item_id TEXT,
    title TEXT,
    question TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    questions TEXT,
    answer_schema TEXT NOT NULL DEFAULT '[]',
    discussion TEXT NOT NULL DEFAULT '[]',
    gate INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    -- JSON. SQL NULL until answered; once answered it may be the JSON text 'null'.
    answer TEXT,
    answer_kind TEXT,
    answered_by TEXT,
    side_session_id TEXT,
    carried_from TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
-- A human_input question is keyed by its node; model ask_user calls (null node) are not.
CREATE UNIQUE INDEX questions_run_node ON questions (run_id, node_id) WHERE node_id IS NOT NULL;
CREATE INDEX questions_session ON questions (session_id, status);
CREATE INDEX questions_run ON questions (run_id);

CREATE TABLE worked_folders (
    person TEXT NOT NULL,
    cwd TEXT NOT NULL,
    last_at TEXT NOT NULL,
    PRIMARY KEY (person, cwd)
);

CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    person TEXT NOT NULL,
    session_id TEXT,
    run_id TEXT,
    kind TEXT NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT
);
CREATE INDEX audit_session ON audit (session_id);

-- Money only: a run's tokens are in yian's run index.
CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    model TEXT NOT NULL,
    usd REAL NOT NULL
);
CREATE INDEX usage_session ON usage (session_id);
CREATE INDEX usage_run ON usage (run_id);
-- Cost reports sum usage since a time.
CREATE INDEX usage_at ON usage (at);

-- One live process per key: a session's worker (<session_id>), a harness (harness:<session_id>) or a sandboxed
-- call (call:<id>). The reaper checks pid and start_time before killing pgid.
CREATE TABLE workers (
    key TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    pgid INTEGER NOT NULL,
    start_time REAL NOT NULL
);

-- Browsers signed in to this office's HQ listeners. A row holds the sha256 of its cookie's secret, never the
-- secret, and password_fp: the first 16 hex of sha256 of the person's password hash when it was issued, so a
-- password change by any writer ends the session.
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

-- The office store. Entity tables have one column per protocol model field
-- (packages/corp_office/src/agent_corp/protocol/models.py); list and object fields are JSON text.
-- Enum values are not CHECKed: the schema may add enum members without a migration.

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
    harness_session_id TEXT,
    work_item_id TEXT,
    question_id TEXT,
    seed TEXT,
    cost REAL NOT NULL DEFAULT 0,
    cost_cap_usd REAL,
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

CREATE TABLE feedback (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    "commit" TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX feedback_session ON feedback (session_id, status);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX messages_session ON messages (session_id, created_at);

-- Message.parts, in order; data is the part's JSON.
CREATE TABLE parts (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX parts_message ON parts (message_id, seq);

-- Metadata events, written in the same transaction as the change they describe.
-- seq orders them; sent_at is set once relayed.
CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT
);
CREATE INDEX outbox_unsent ON outbox (seq) WHERE sent_at IS NULL;

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

CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    usd REAL NOT NULL
);
CREATE INDEX usage_session ON usage (session_id);

-- One live worker per session; the reaper checks pid and start_time before killing pgid.
CREATE TABLE workers (
    session_id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    pgid INTEGER NOT NULL,
    start_time REAL NOT NULL
);

CREATE TABLE debriefs (
    session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    summary TEXT,
    status TEXT,
    artifacts TEXT NOT NULL DEFAULT '[]',
    decisions TEXT NOT NULL DEFAULT '[]',
    follow_ups TEXT NOT NULL DEFAULT '[]',
    open_questions TEXT NOT NULL DEFAULT '[]',
    cost REAL NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE profile_proposals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    person TEXT NOT NULL,
    base_version TEXT NOT NULL,
    text TEXT NOT NULL,
    diff TEXT NOT NULL,
    status TEXT NOT NULL,
    "commit" TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX profile_proposals_person ON profile_proposals (person, status);

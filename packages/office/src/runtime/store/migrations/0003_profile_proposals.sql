-- The profile manager's proposed profile rewrites, one column per field of ProfileProposal.
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
CREATE INDEX profile_proposals_person ON profile_proposals (person, created_at);

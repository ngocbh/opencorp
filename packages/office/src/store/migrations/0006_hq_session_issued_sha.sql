-- The HEAD a browser session was issued at, so a check sees its person removed since then, not only at HEAD.
ALTER TABLE hq_sessions ADD COLUMN issued_sha TEXT;

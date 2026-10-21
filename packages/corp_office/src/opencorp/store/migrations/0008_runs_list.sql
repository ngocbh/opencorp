-- The list's since and until filters also list a top-level run when a run it started was launched in range: this
-- reads the children launched in a range, and their parents, without visiting any other row.
CREATE INDEX runs_child_launched ON runs (launched_at, parent_run_id) WHERE parent_run_id IS NOT NULL;
-- The list's default shows every open run (no outcome yet), however old: this reads them, and the parents of open
-- children, without visiting the closed ones.
CREATE INDEX runs_open ON runs (parent_run_id, run_id) WHERE outcome IS NULL;

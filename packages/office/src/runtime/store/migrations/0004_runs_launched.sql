-- Run Logs filters runs by launch time (a launch range, or recent): without this index those lists scan the table.
CREATE INDEX runs_launched ON runs (created_at);

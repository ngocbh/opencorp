-- Session.waiting_on (JSON text) and Session.capped: who a waiting session waits on, and whether its cost cap holds
-- it. NULL in rows from before them, read back as [] and false.
ALTER TABLE sessions ADD COLUMN waiting_on TEXT;
ALTER TABLE sessions ADD COLUMN capped INTEGER;

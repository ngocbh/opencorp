-- The audit table goes: why a call ran, what was refused, who answered and how a command ended are in the run log,
-- the question records and the terminal records (#302). Its index goes with it.
DROP TABLE IF EXISTS audit;

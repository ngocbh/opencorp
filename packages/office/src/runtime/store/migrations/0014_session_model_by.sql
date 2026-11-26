-- Who last switched a chat's connection or model: the run hears the switch as their action, after a restart too.
ALTER TABLE sessions ADD COLUMN model_by TEXT;

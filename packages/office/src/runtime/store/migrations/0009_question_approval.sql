-- An approval card's action, as JSON: what it would run, why policy asked, and the rules it would add.
ALTER TABLE questions ADD COLUMN approval TEXT;

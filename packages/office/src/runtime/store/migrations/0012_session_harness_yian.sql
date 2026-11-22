-- The harness of an employee's own chat, on the Yian engine, was named `composer`; it is `yian` now.
UPDATE sessions SET harness = 'yian' WHERE harness = 'composer';

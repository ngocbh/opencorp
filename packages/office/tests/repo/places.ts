/**
 * Where each office file goes while the old folders move to the layers (ARCHITECTURE.md, "The office's layers").
 *
 * `PLACES` and `TEST_PLACES` map each file at an old path under `src/` or `tests/` to its final path. The relayout
 * codemod (`script/relayout.ts`) moves one category's files and deletes their lines. `UPWARD` and `CYCLES` are the
 * imports that still point up and the folder cycles inside a category: a PR that fixes one deletes its line, and no
 * PR adds one. `layer_direction.test.ts` and `layout.test.ts` hold every list exact. This file goes once the moves
 * are done.
 */

/** Each `src/` file at an old path, by its path under `src/`: its final path. */
export const PLACES: Readonly<Record<string, string>> = {
  "daemon/auth.ts": "server/auth.ts",
  "daemon/http.ts": "server/http.ts",
  "daemon/main.ts": "server/daemon/main.ts",
  "daemon/office.ts": "server/office.ts",
  "daemon/routes/connections.ts": "server/routes/connections.ts",
  "daemon/routes/costs.ts": "server/routes/costs.ts",
  "daemon/routes/devices.ts": "server/routes/devices.ts",
  "daemon/routes/events.ts": "server/routes/events.ts",
  "daemon/routes/index.ts": "server/routes/index.ts",
  "daemon/routes/people.ts": "server/routes/people.ts",
  "daemon/routes/profiles.ts": "server/routes/profiles.ts",
  "daemon/routes/questions.ts": "server/routes/questions.ts",
  "daemon/routes/runs.ts": "server/routes/runs.ts",
  "daemon/routes/sessions.ts": "server/routes/sessions.ts",
  "daemon/routes/work_items.ts": "server/routes/work_items.ts",
  "extensions/index.ts": "server/daemon/extensions.ts",
  "hq/api.ts": "server/hq/api.ts",
  "hq/auth.ts": "server/hq/auth.ts",
  "hq/config.ts": "server/hq/config.ts",
  "hq/core.ts": "server/hq/core.ts",
  "hq/guard.ts": "server/hq/guard.ts",
  "hq/login.ts": "server/hq/login.ts",
  "hq/pairing.ts": "server/hq/pairing.ts",
  "hq/servers.ts": "server/hq/servers.ts",
  "hq/sessions.ts": "server/hq/sessions.ts",
  "hq/static.ts": "server/hq/static.ts",
  "hq/status.ts": "server/hq/status.ts",
  "hq/version.ts": "server/hq/version.ts",
  "install/main.ts": "server/commands/main.ts",
}

/** Each `tests/` file at an old path, by its path under `tests/`: its final path. */
export const TEST_PLACES: Readonly<Record<string, string>> = {
  "daemon/app.test.ts": "server/app.test.ts",
  "daemon/auth.test.ts": "server/auth.test.ts",
  "daemon/extensions.test.ts": "server/daemon/extensions.test.ts",
  "daemon/helpers.ts": "server/helpers.ts",
  "daemon/http.test.ts": "server/http.test.ts",
  "daemon/main.test.ts": "server/daemon/main.test.ts",
  "daemon/office.test.ts": "server/office.test.ts",
  "daemon/routes_connections.test.ts": "server/routes/connections.test.ts",
  "daemon/routes_costs.test.ts": "server/routes/costs.test.ts",
  "daemon/routes_events.test.ts": "server/routes/events.test.ts",
  "daemon/routes_people.test.ts": "server/routes/people.test.ts",
  "daemon/routes_profiles.test.ts": "server/routes/profiles.test.ts",
  "daemon/routes_questions.test.ts": "server/routes/questions.test.ts",
  "daemon/routes_runs.test.ts": "server/routes/runs.test.ts",
  "daemon/routes_sessions.test.ts": "server/routes/sessions.test.ts",
  "daemon/routes_work_items.test.ts": "server/routes/work_items.test.ts",
  "hq/api.test.ts": "server/hq/api.test.ts",
  "hq/app_fixture.test.ts": "server/hq/app_fixture.test.ts",
  "hq/auth.test.ts": "server/hq/auth.test.ts",
  "hq/config.test.ts": "server/hq/config.test.ts",
  "hq/core.test.ts": "server/hq/core.test.ts",
  "hq/events.test.ts": "server/hq/events.test.ts",
  "hq/guard.test.ts": "server/hq/guard.test.ts",
  "hq/helpers.ts": "server/hq/helpers.ts",
  "hq/login.test.ts": "server/hq/login.test.ts",
  "hq/pairing.test.ts": "server/hq/pairing.test.ts",
  "hq/servers.test.ts": "server/hq/servers.test.ts",
  "hq/sessions.test.ts": "server/hq/sessions.test.ts",
  "hq/source.test.ts": "server/hq/source.test.ts",
  "hq/static.test.ts": "server/hq/static.test.ts",
  "hq/status.test.ts": "server/hq/status.test.ts",
  "hq/version.test.ts": "server/hq/version.test.ts",
  "install/main.test.ts": "server/commands/main.test.ts",
}

/** Each import that still points up, one line per name, as `<importer> -> <imported> <name>` in today's `src/`
 *  paths. A dynamic import's name is `import()`. */
export const UPWARD: readonly string[] = []

/** Each folder cycle inside a category, as its folders sorted; a category's root files are the category. */
export const CYCLES: readonly (readonly string[])[] = []

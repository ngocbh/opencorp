# Architecture

This repo holds OpenCorp's packages: the office daemon, the protocol it shares with its clients, the
client library, the TUI, the CLI and HQ's web app, with Yian as a submodule. This file maps them,
lays out the office's layers and lists the rules the code relies on. The office is moving to the
layout below (#889). While the moves run, this file describes the target.

## The packages

```
tui ──┐
cli ──┼──▶ client ──▶ protocol ◀── office ──▶ yian
app ──┘                              ▲          ▲
cli ─────────────────────────────────┴──────────┘
```

The TUI, CLI and HQ app go through `client`, which uses `protocol`. The office uses `protocol` and
`yian`. The CLI also imports the office directly (`main.ts`, `office.ts`, `commands/{tui,hq}.ts`,
`runs_indexer.ts`) and yian (`nodes/code/worker.ts`). Each client also takes its types from
`protocol`, and the CLI runs the TUI.

```
packages/office/                      # office daemon, run worker, sandbox launcher, permission layer, harness adapters
packages/yian/                        # submodule; the Yian engine the office runs flows on
packages/protocol/                    # zod schemas: the protocol the office and the clients share
packages/client/                      # the TS client the TUI, CLI and HQ app reach the office with
packages/tui/                         # the TUI (forked from OpenCode)
packages/cli/                         # the `opencorp` CLI (npm package "opencorp")
packages/app/                         # OpenCorp HQ, the web app (#184)
docs/plans/                           # design docs and plans (local only, gitignored)
```

The clients (TUI, CLI, HQ app) reach the office through the wrapper `packages/cli/bin/opencorp` in a
checkout, and the compiled binary when installed.

## The office's layers

Each category is a top-level folder of `packages/office/src/`. The order, lowest first:

1. `util/`, with `platform.ts` beside it in `src/`
2. `company/`
3. `runtime/`
4. `models/`
5. `tools/`
6. `features/`
7. `server/`
8. `main.ts`, which picks the mode. Each mode's entry lives in its own layer:
   - the worker in `runtime/worker`;
   - the file helper in `runtime/sandbox`;
   - the daemon in `server/daemon`;
   - the setup commands in `server/commands`.

`testing/` sits outside: it may import anything, and nothing in `src/` imports it.

### Import rules

1. **Every file has a layer.** A file is under a category folder, or is `main.ts`, `platform.ts` or
   `files.d.ts`. A new top-level file under `src/` fails.
2. **Imports go down or stay in their layer.** Static imports, `import type`, `export … from`, dynamic
   `import()`, `import("…")` types and data imports (`with { type: "file" }`) all count.
3. **Inside a category, the folder graph has no cycles.** The category's root files count as one node, the base
   its folders may use.
4. **`util/` imports only** `node:`, `platform.ts`, `util/`, `@ngocbh/yian/platform` and `@opencorp/protocol`
   (with its subpaths). `platform.ts` may also import `bun:`. util knows nothing of the company, models, flows or the
   office's state.

Until the moves are done, a ratchet list, `UPWARD` in `packages/office/tests/repo/places.ts`, exempts
each import that still breaks rule 2 or 4, and the change that fixes an import deletes its line.
Two of them, by today's paths, break rule 4: `perm/redact → secrets` and `platform → sandbox/policy`.

`places.ts` also maps each file's path today to its final one (`PLACES`, `TEST_PLACES`) and lists the folder
cycles left in `CYCLES`; `packages/office/script/relayout.ts` makes each move. A new file in an old folder (one that
still holds a `PLACES` entry) needs its own `PLACES` or `TEST_PLACES` entry, naming its final path in the layers
above; the layer and layout tests fail until it has one.

**Type-only imports count.**
- A card's "Depends on" is the design dependency. A type import ties a module to the shape of the code above it:
  a change there breaks its typecheck. Hiding it would make the card false.
- Yian's layer test counts them, and one rule across both repos is simpler.
- Erasing them would matter only for load-order cycles, which rule 2 already prevents.
- The cost is small, and it is a gain in itself. A lower module stops taking the whole `Office`. It names what it
  uses in a narrow interface it declares: `ChatOffice`, `CodexOffice`, `CardOffice`, `QuestionsHost` or `OfficeHq`.
  `Office` (or `Hq`) satisfies each one structurally.

### Category cards

`util` includes `platform.ts`.

| Category | Is | Does | Depends on | Used by |
|---|---|---|---|---|
| `util/` | Helpers that know nothing of the company, models, flows or the office's state | Files that never follow links, private files, processes, the inherited env, scrubbing, error texts, the office home's paths, sockets, the checkout's path, a redirect page that keeps a link out of an opener's arguments. `platform.ts` holds every Bun call | — | every layer |
| `company/` | The company | Loads, lints, commits and watches its repo; people, org chart, SOP flows, profiles, hiring; the chat flow's paths; the starting company | util | runtime, tools, features, server |
| `runtime/` | What runs agents safely | The database, the sandbox, who is acting, worker processes, the record of runs, what sessions share, permissions, held questions, the event bus, asset secrets, the office as a service | util, company | models, tools, features, server, `main.ts` |
| `models/` | The office's model connections and their policy | Connections, ChatGPT logins, model lists, prices and cost caps, the model check | util, runtime | features, server, `main.ts` |
| `tools/` | What agents use | Typed tool groups (company, work items, workspace, toolbox) and the instruments (`codex/` now; `terminal/` and `claude/` in #888) | util, company, runtime | features |
| `features/` | What the owner and agents do | Chat, Codex sessions, questions, profiles, setup, doctor, `opencorp hq` | util, company, runtime, models, tools | server; the CLI (`reach`) |
| `server/` | The office's processes and how clients reach them | The `Office` and its HTTP API, HQ's web server, the daemon process, and the process that runs the CLI's setup commands (`opencorp install …`, before any office exists) | everything below | `main.ts`; the CLI, TUI and HQ app |
| `testing/` | Fakes for tests | Fake model, ssh and Codex; a temp office | anything | tests in every package; `tui/script/dev.ts` |

**`models/` stays a layer.** It holds policy that is OpenCorp's, not Yian's: which connection the office and each
employee use, prices and cost caps, and who may change them. Folding it into `runtime/` would mix "which model and
what it costs" with "how agents run safely". It shrinks as yian#1713–1715 land.

**Why `server/commands/` is in `server/`.** It must sit above `features/{setup, doctor}` and `server/hq` (whose
`checks.ts` it injects into doctor). Like `server/daemon/`, it is a process entry. A ninth `modes/` category would
hold one file.

### Folder cards

Same-category dependencies are named by folder; "runtime" alone means its root files. Users outside
the office package come after a `;`. These are the folders after the moves (moving there now).

| Folder | Is | Does | Depends on | Used by |
|---|---|---|---|---|
| `company/template/` | The starting company (data) | The files `init` writes into a new repo; `template.ts` reads them | — | `company/template.ts` |
| `runtime/` root files | Asset secrets and the event bus | `secrets.ts`: asset secrets under `office/secrets`. `bus.ts`: the office's events and live events | util | runtime/permissions, features/{chat, codex}, server |
| `runtime/store/` | The office's database | Opens and migrates SQLite; rows for sessions, questions, runs, workers, HQ sessions; which statuses are live | util | runtime/{permissions, questions, runs, sessions, worker}, models, tools, tools/codex, features/{chat, codex, doctor, profile, questions}, server |
| `runtime/sandbox/` | The fence around an agent's commands | bubblewrap and Seatbelt profiles; runs a command in one; `fs_helper.ts`, the file helper that runs inside | util | runtime/service, tools, features/{chat, codex, doctor}, server, `main.ts` |
| `runtime/auth/` | Who is acting | This device's identity; devices, tokens, passwords; the roster at HEAD | util, company | runtime/service, features/{setup, doctor}, server |
| `runtime/worker/` | The processes that run flows | Spawns workers, hands them jobs, serves their memories, reaps strays; the worker's entry, its job handlers injected; what a fresh chat run takes from the run it replaces | util, company, runtime/store | runtime/{questions, runs, sessions}, models, tools, every feature, server, `main.ts` |
| `runtime/service/` | The office as a background service | launchd, systemd, tmux or a plain process; starts, stops and pins the daemon; the programs it may spawn | util, runtime/{auth, sandbox} | features/{codex, setup, doctor}, server, `main.ts` |
| `runtime/runs/` | The record of runs | Indexes and reads Yian run logs for Run Logs; live runs; outcomes | util, company, runtime/{store, worker} | runtime/sessions, features/{chat, questions}, server |
| `runtime/sessions/` | What every session harness shares | Status rules and `HarnessError`; the extension hooks; the `SessionHarness` and `CardActor` contracts the routes and cards call | runtime/{store, worker, runs} | features/{chat, codex, questions}, server |
| `runtime/permissions/` | Who or what may do what | The reference monitor that checks and audits each tool call; the asset kinds it runs; who may manage connections | util, company, runtime, runtime/store | tools, features/chat, server |
| `runtime/questions/` | Questions held for an answer | Holds an `ask_user` or `ask_manager` until answered; checks, normalizes and formats answers | util, company, runtime/{store, worker} | tools, features/{chat, questions} |
| `models/` | Model connections and policy | As its category card; `flows/check_model.yaml` is the check's flow | util, runtime/{store, worker} | features/{chat, codex, doctor, reach, setup}, server, `main.ts` |
| `tools/` root files | The typed tools | Builds each run's tool groups: company (`ask_manager`, work items), workspace (files and shell in the sandbox), toolbox (asset tools) | util, company, runtime/{permissions, questions, sandbox, store, worker} | features/chat |
| `tools/codex/` | The Codex instrument's driver | Runs `codex app-server`, speaks its JSON-RPC, translates its events and approvals | util, runtime/store | features/{chat, codex, doctor} |
| `features/chat/` | Conversations with an employee | Drives a session's runs: run specs, transcripts, the live relay. Its flows are in `company/template/shared/flows/` | util, company, runtime (root, permissions, questions, runs, sandbox, sessions, store, worker), models, tools, tools/codex, features/{codex, profile} | features/questions (types), server |
| `features/codex/` | The owner's Codex sessions (#144) | A session harness beside the chat harness | util, company, runtime (root, sandbox, service, sessions, store, worker), models, tools/codex | features/chat, server |
| `features/questions/` | What people do with a question | Card actions and side chats; registers itself as an office extension. `side_chat.yaml` is in the template | util, company, runtime/{questions, runs, sessions, store, worker}, features/chat (types) | server |
| `features/profile/` | The profile manager | A chat that proposes edits to a person's profile. `profile_manager.yaml` is in the template | company, runtime/{store, worker} | features/chat, server |
| `features/setup/` | Setting up this machine's office | `init`, `onboard`, `offboard`: `flows/init.yaml`, the interview, `tools/draft.ts`, the model picker (until yian#1714), the prompters | util, company, runtime/{auth, service, worker}, models | features/{doctor, reach}, server |
| `features/doctor/` | The health check (no flow) | Checks home, company, model, service, sandbox and Codex; HQ's checks are passed in by `server/` | util, company, runtime/{auth, sandbox, service, store, worker}, models, tools/codex, features/setup | server |
| `features/reach/` | Reaching an HQ on another machine | `opencorp hq`: learn the path (`flows/learn_hq.yaml`), replay it, connect | util, runtime/worker, models, features/setup | ; the CLI only |
| `server/` root files | What every server part takes | `office.ts`: the `Office`, `RequestContext`, and `OfficeHq`, what the socket routes call on HQ. `http.ts`: HTTP plumbing and errors. `auth.ts`: who a request acts as | util, company, runtime (root, auth, runs, sandbox, service, sessions, store, worker), models, features/{chat, codex, questions} | server/{routes, hq, daemon} |
| `server/routes/` | The office's API | The HTTP routes clients call on the socket, HQ's among them (`hq.ts`) | server, util, company, runtime (root, auth, permissions, runs, sessions, store, worker), models, features/{chat, profile, questions, setup} | server/{hq, daemon} |
| `server/hq/` | HQ's web server | Serves the web app: guard, login, pairing, browser sessions, its API; the app's build ids (`version.ts`); HQ's checks for doctor (`checks.ts`) | server, server/routes, util, company, runtime (root, auth, service, store), features/doctor | server/{daemon, commands}; the CLI, the app |
| `server/daemon/` | The office process | Start and stop, the lock, sockets, extensions; builds the `Office` and wires everything | everything below; server, server/{routes, hq} | `main.ts` |
| `server/commands/` | The setup commands' process | `opencorp install init/onboard/offboard/doctor/start/stop/restart`, in a child; JSON prompts for the TUI | util, company, runtime/{auth, service}, models, features/{setup, doctor}, server/hq | `main.ts` |

**Inside each category, folders are ordered:**
- runtime: root, store, sandbox, auth → worker, service → questions, runs, permissions → sessions;
- tools: root and `codex/` are independent;
- features: profile, codex, setup → chat, doctor, reach → questions;
- server: root → routes → hq → daemon, commands.

**What #888 adds (future, not today):**
- `tools/terminal/` and `tools/claude/`, which depend only on util, `runtime/sandbox` and `runtime/permissions`'
  office-free policy;
- `runtime/permissions/` gains modes and rules, as a module that needs no store, beside `monitor.ts`, which needs
  the store and asset secrets;
- `tools/codex/` loses `runtime/store`: its process records become injected;
- `features/reach/tools/shell.ts` goes, replaced by `tools/terminal/`;
- the session-folder checks (`checkFolder`, `folderOf`, `checkOverlap`, `unsafeWorkspace`) move to
  `runtime/sessions/` once a second harness needs them;
- step 8 of #888 decides whether `features/codex/` folds into employee chats that drive the Codex instrument.

## Feature folders

Each feature of the office is Yian flows plus the code that runs them, laid out the same way:

```
packages/office/src/features/<feature>/
  flows/    its Yian flows (.yaml)
  tools/    the host tools those flows call, one file per tool
  skills/   the skills its agents grant (<name>/SKILL.md)
  run.ts    drives its runs: loads the flows, binds the tools and skills, starts the runs, reads the results
  *.ts      only what can't be a flow, tool or skill: schemas, file layout, platform plumbing
```

- A prompt stays inline in its flow. It moves to a file that flows `!include` only when several flows share it.
- Fixed text and data that code shows, such as risk texts, are files the code embeds, as it embeds flows, not `.ts` constants.
- A tool goes in the shared `src/tools/` only when flows of more than one feature call it under the same trust model: the same sandbox and the same approver. A tool whose safety depends on who runs it stays in its feature, even when another feature has one of the same name. `features/reach/tools/shell.ts` (today `reach/tools/shell.ts`) runs unsandboxed as the owner, after the owner approves each command; `tools/workspace.ts`'s `shell` runs sandboxed in an employee's workspace.
- yian's built-ins (`ask_user`, `load_skill`, …) aren't host tools. A feature supplies only how a question reaches a person: its ask handler, in `run.ts`.
- An employee's own SOPs are flows in the company repo (`company/template/`), not in a feature folder.
- Tests mirror the layout: `tests/features/<feature>/tools/<tool>.test.ts`, `tests/features/<feature>/run.test.ts`.
- The old folders move to this layout only through #889's codemod; don't move them by hand.

## Rules that must not break

| Rule | Test |
|---|---|
| One-way imports; no folder cycles; every file layered; util stays generic | `packages/office/tests/repo/layer_direction.test.ts` |
| Bun only in `platform.ts`; no spawn of `process.execPath` elsewhere | `packages/office/tests/repo/layer_direction.test.ts` ("no Bun or bun: API outside platform.ts", "no spawn of process.execPath outside platform.ts") |
| src loads modules only with `import`, never `require()`, `module.require`, `import.meta.require` or `createRequire`; a dynamic import names its module in one quoted string | the same ("src loads modules only with import, never require", "every dynamic import in src names its module in one quoted string") |
| The daemon loads only builtins and the pre-re-exec files before it re-execs; `daemonMain` pins first | the same ("the daemon loads only builtins and the pre-re-exec files before it re-execs", "daemonMain pins the daemon before it loads the daemon") |
| The sandbox helper imports only `node:` | the same ("the sandbox helper imports only node builtins"), and `packages/cli/test/entry.test.ts` ("the fs helper imports only node builtins") |
| The cards match the imports | the same, once the moves are done |
| `tests/` mirrors `src/`; every old test file is placed; feature folders keep their shape | `packages/office/tests/repo/layout.test.ts` |
| Only the worker hosts yian runs | "no office code outside the worker calls a yian host function" in `packages/office/tests/features/chat/session_actor.test.ts` (today `tests/chat/`) |
| Protocol changes update every package | the TUI's and HQ's contract tests against a real office (existing) |
| Secrets never in argv, logs or the model | no single test: HQ pairing's, login's and redaction's tests each cover part (existing) |
| The run log is the source of truth; everything is a flow | no test; held in review |

### Protocol schema

The protocol is the zod schemas in `packages/protocol/src/schemas/`: the office and every client
take their types from them, and nothing is generated.

A PR may add, rename or remove a protocol field as long as it updates every package that uses it
(office, client, TUI, CLI, HQ app) in the same PR, and adds the matching store migration in
`packages/office/src/runtime/store/migrations/` (today `src/store/migrations/`) when a field lands on
a schema the store persists, since inserts fail until the column exists. The additive-only rule and
the schema-only-PR rule the port suspended stay off until there are outside clients to keep
compatible.

Clients ignore enum values and event types they don't know. Make timestamps with `now()` from
`@opencorp/protocol`.

## Where tests live

The office lives in `packages/office` (`@opencorp/office`): a module is
`packages/office/src/<category>/…/<mod>.ts` and its tests are
`packages/office/tests/<category>/…/<mod>.test.ts`, each test's name in words. Run them with
`(cd packages/office && bun test <file>)`.

The office's e2e tests (`tests/e2e/`) and its sandbox tests run with the rest of its suite; a
sandbox test skips where it can't sandbox, unless `CI` or `OPENCORP_TEST_SANDBOX` is set.

The clients' tests run against a real office on a temp home (`@opencorp/office/testing/office`).
Fakes are kept only for scripted tests (the TUI's frame tests, HQ's Playwright tests), and a
contract test checks each against the real office.

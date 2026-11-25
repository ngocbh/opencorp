# Architecture

This repo holds OpenCorp's packages: the office daemon, the protocol it shares with its clients, the
client library, the TUI, the CLI and HQ's web app, with Yian as a submodule. This file maps them,
lays out the office's layers and lists the rules the code relies on. The office's code follows the
layout below.

## The packages

```
tui ──┐
cli ──┼──▶ client ──▶ protocol ◀── office ──▶ yian
app ──┘                              ▲          ▲
cli ─────────────────────────────────┴──────────┘
```

The TUI, CLI and HQ app go through `client`, which uses `protocol`. The office uses `protocol` and
`yian`. The CLI also imports the office directly (`main.ts`, `office.ts`, `chat.ts`, `commands/{tui,hq}.ts`,
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
docs/                                 # the docs site (Starlight), published at opencorp.readthedocs.io
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
| `util/` | Helpers that know nothing of the company, models, flows or the office's state | Files that never follow links, private files, processes, the inherited env, finding a program on `PATH`, scrubbing, error texts, ids, the office home's paths, sockets, the checkout's path, a redirect page that keeps a link out of an opener's arguments, how a command is shown to the owner, an output's last lines and a duration as a note to an agent quotes them. `platform.ts` holds every Bun call | — | every layer |
| `company/` | The company | Loads, lints, commits and watches its repo; people, org chart, SOP flows (their child flows, CODE files and tool modules confined to the repo, lint's error for a module whose literal imports resolve outside it, until yian#1811 confines them, and for a module file given two `uses:` aliases, since tool rules name a module by its alias; a tool module gets nothing from the office through `ctx` (`ctx.context` is `undefined`), but runs on a worker thread, unsandboxed, as the office user, with the owner's full power; each model call of its tools goes through the session's mode, and a granted flow that calls one runs under the deny and `dontAsk` rules on it), profiles, hiring; the agents' and the company's rules for commands, typed input and tool calls (`rules.yaml`, read at HEAD), and a tool call's words for them; the chat flow's paths; the starting company | util | runtime, tools, features, server |
| `runtime/` | What runs agents safely | The database, the sandbox, who is acting, worker processes, the record of runs, what sessions share, permissions, held questions, the event bus, asset secrets, the office as a service | util, company | models, tools, features, server, `main.ts` |
| `models/` | The office's model connections and their policy | Connections, ChatGPT logins, model lists, prices and cost caps, the model check | util, runtime | features, server, `main.ts` |
| `tools/` | What agents use | Typed tool groups (company, work items, workspace, terminal, toolbox) and the instruments (`codex/`, `claude/` and `terminal/`, with what the harness instruments share in `harness/`) | util, company, runtime | features |
| `features/` | What the owner and agents do | Chat, Codex sessions, employees' Claude Code sessions, questions, profiles, setup, doctor, `opencorp hq` | util, company, runtime, models, tools | server; the CLI (`reach`) |
| `server/` | The office's processes and how clients reach them | The `Office` and its HTTP API, HQ's web server, the daemon process, the process that runs the CLI's setup commands (`opencorp install …`, before any office exists), and the host that serves a built-in agent's chat with no office | everything below | `main.ts`; the CLI, TUI and HQ app |
| `testing/` | Fakes for tests | Fake model, ssh, Codex and Claude Code; a temp office; whether the sandbox runs here | anything | tests in every package; `tui/script/dev.ts` |

**`models/` stays a layer.** It holds policy that is OpenCorp's, not Yian's: which connection the office and each
employee use, prices and cost caps, and who may change them. Folding it into `runtime/` would mix "which model and
what it costs" with "how agents run safely". It shrinks as yian#1713–1715 land.

**Why `server/commands/` is in `server/`.** It must sit above `features/{setup, doctor}` and `server/hq` (whose
`checks.ts` it injects into doctor). Like `server/daemon/`, it is a process entry. A ninth `modes/` category would
hold one file.

### Folder cards

These are the folders. In "Depends on" and "Used by", a category alone ("runtime") means its root files, or the
whole category for util, company and models, which have no code folders; "runtime/store" or "runtime/{runs, store}"
names folders, and "runtime (root, store)" names both. Users outside the office package come after a `;`.
Each card's "Depends on" and "Used by", up to the `;`, are checked against the imports
(`packages/office/tests/repo/layer_direction.test.ts`, "each folder card in ARCHITECTURE.md names what its folder
imports and what imports it").

| Folder | Is | Does | Depends on | Used by |
|---|---|---|---|---|
| `company/template/` | The starting company (data) | The files `init` writes into a new repo, among them the shared flows: the chats' and the SOP that drives a harness (`drive_harness.yaml`); `template.ts` reads them | — | `company/template.ts` |
| `runtime/` root files | Asset secrets and the event bus | `secrets.ts`: asset secrets under `office/secrets`. `bus.ts`: the office's events and live events | util | runtime/permissions, features/{chat, claude, codex}, server (root, daemon, hq, local, routes) |
| `runtime/store/` | The office's database | Opens and migrates SQLite; rows for sessions, questions, runs, workers, HQ sessions; which statuses are live | util | runtime/{questions, runs, sessions, worker}, models, tools, features/{chat, claude, codex, doctor, profile, questions}, server (root, daemon, hq, local, routes) |
| `runtime/sandbox/` | The fence around an agent's commands | bubblewrap and Seatbelt profiles; runs a command in one; `fs_helper.ts`, the file helper that runs inside; the permission a harness's own sandbox enforces, the folder's git root and the harnesses' own config folders it takes, and the checks of the harness the office runs (`harness_profile.ts`); each harness's private folder under `/tmp`, with a fresh temp folder per session and a private folder linking to the programs its sandbox runs, and each harness's MCP folder in the office's home, with a folder per session whose allowed MCP servers start in its empty folder (`harness_temp.ts`) | util | runtime/{service, sessions}, tools (root, claude, terminal), features/{chat, claude, codex, doctor, reach}, server (root, daemon), main.ts |
| `runtime/auth/` | Who is acting | This device's identity; devices, tokens, passwords; the roster at HEAD | util, company | runtime/service, features/{doctor, setup}, server (root, commands, hq, local, routes) |
| `runtime/worker/` | The processes that run flows | Spawns workers, hands them jobs, serves their memories, reaps strays; the worker's entry, its job handlers injected; what a fresh chat run takes from the run it replaces; a running tool call's interrupt and steer, from the agent's to the office tool's (`tool_interrupt`, `tool_steer`: Yian's `ctx.interrupted` and `ctx.steered`); each tool call an agent's model makes, asked of the office before it runs (`gate_call`, Yian's `beforeToolCall`; a request that fails refuses the call), a granted flow's naming the module tools its own steps call (`wraps.ts`), and a held call's `release` | util, company, runtime/store | runtime/{permissions, questions, runs, sessions}, models, tools, features/{chat, claude, codex, doctor, profile, questions, reach, setup}, server (root, daemon, local, routes), main.ts |
| `runtime/service/` | The office as a background service | launchd, systemd, tmux or a plain process; starts, stops and pins the daemon; the programs it may spawn | util, runtime/{auth, sandbox} | features/{claude, codex, doctor, setup}, server (root, commands, daemon, hq), main.ts |
| `runtime/runs/` | The record of runs | Indexes and reads Yian run logs for Run Logs, an agent's model calls through Yian's reader (`calls.ts`); live runs; outcomes | util, company, runtime/{store, worker} | runtime/sessions, features/{chat, doctor, questions}, server (root, daemon, routes) |
| `runtime/sessions/` | What every session harness shares | Status rules and `HarnessError`, and whether an instrument session matches the record its chat continues it from (`state.ts`); the extension hooks; the `SessionHarness` and `CardActor` contracts the routes and cards call; the live instruments of each session (`instruments.ts`), published as they change and print; what a feature gives the no-office host for a built-in agent's session, what the host binds for its tools, and the chat that runs the session with the TUI on it (`builtin.ts`); the checks of a session's folder (`folder.ts`); an employee's harness permission from their person, their listed folders as listed (`permission.ts`); the two speakers of a harness instrument's session, as each is labelled and what the harness is told of them (`speakers.ts`) | util, company, runtime/{permissions, runs, sandbox, store, worker} | features/{chat, claude, codex, doctor, questions, reach, setup}, server (root, daemon, local, routes) |
| `runtime/permissions/` | Who or what may do what | The reference monitor that checks and runs each asset tool call, its result redacted of the company's secrets (the run log keeps each call and its result); the asset kinds it runs; who may manage connections; the gate's policy for each tool call an agent's model makes, which needs no office: a shell command or typed line by the mode, the rules and the command reader (`policy.ts`, `commands.ts`), any other call by its source and `tool` rules, and a granted flow also by the module tools its own steps call (`gate.ts`), each run, refused, held for a card or held for Auto's check; Auto's check: `classifier.ts` runs `flows/classify_command.yaml`, its verdict decided again by the mode and rules when it lands | util, company, runtime (root, worker) | runtime/sessions, tools (root, terminal), features/{chat, reach}, server/{daemon, local, routes}, main.ts |
| `runtime/questions/` | Questions held for an answer | Holds an `ask_user`, `ask_manager` or an approval until answered; checks, normalizes and formats answers | util, company, runtime/{store, worker} | tools, features/{chat, questions}, server/local |
| `models/` | Model connections and policy | As its category card; `flows/check_model.yaml` is the check's flow | util, runtime/{store, worker} | features/{chat, codex, doctor, reach, setup}, server (root, commands, daemon, local, routes), main.ts |
| `tools/` root files | The typed tools | Builds each run's tool groups: company (`ask_manager`, work items), workspace (the file tools in the sandbox, and the pipes the terminal runs commands through in it), terminal (the session's shells, as its host binds them), codex and claude (the session's Codex and Claude Code instruments, as its host binds them), toolbox (asset tools) | util, company, runtime/{permissions, questions, sandbox, store, worker}, tools/terminal | features/chat |
| `tools/codex/` | The Codex instrument | Runs `codex app-server`, speaks its JSON-RPC, translates its events and requests, and declines its approvals; the codex tool group (`instrument.ts`, `tools.ts`, `record.ts`): the harness instrument in Codex's words, with its tool parts as its trace shows them | util, tools/harness | features/{chat, codex, doctor} |
| `tools/claude/` | The Claude Code instrument | Runs the `claude` CLI over its stream-json stdio under an employee's permission (`claude.ts`): its settings and listed folders, no settings files or plugins, no MCP servers but the owner's ones the employee may use, edits accepted and nothing asked, a fixed PATH and temp folder, auto memory off; checks its version and sign-in from `initialize`, refuses every request it sends, takes no message from the owner's other sessions, and says what to fix when its sandbox can't start; the line protocol (`stream.ts`); its lines as transcript events (`translate.ts`); doctor's probe of a start (`probe.ts`); the owner's and the project's `CLAUDE.md`, read and passed as appended system prompt text, after the office's own words (`instructions.ts`); the socat its Linux sandbox runs inside, checked, run once, and with the folders it loads from read there (`socat.ts`); the claude tool group (`instrument.ts`): the harness instrument in Claude Code's words, with each tool call as its trace shows it; the owner's MCP servers from `.claude.json`, and the 0600 file that hands a start those its employee may use, each started in the office's empty folder (`mcp.ts`) | util, company, runtime/sandbox, tools/harness | features/{chat, claude, doctor} |
| `tools/harness/` | What the harness drivers and instruments share | The types an external agent harness adapter takes and passes: its events (messages, parts, turns, cards), its open and process (`adapter.ts`); a harness instrument (`instrument.ts`, `tools.ts`), each harness naming itself: a chat's sessions of one harness by name, each opened by its host, at most four live, two speakers (each entry's author the office's, never a text's), the owner's turns the owner's to stop, replies in pages, Esc through the call's interrupt, and the employee's turn stopped when the chat's run stops; and each session's record (`record.ts`: `meta.json`, `conversation.log`, `trace.log`, and their entries as JSON lines), its newest part kept in memory, a long entry as its head and tail, and the next name's number (`instrument.json`); after an office restart, the sessions taken back from their records and listed, a cut-off turn marked, each continued through the host's resume by the driver's next send or the owner's next message; a reply within 5 seconds unless the call says, or at once when a steer waits for the driver (Yian's `ctx.steered`), and the note of a turn a reply said runs on, once it ends, for the host to give the chat, each note kept in the record until delivered | util | tools/{claude, codex}, features/{chat, claude, codex} |
| `tools/terminal/` | The terminal instrument | The PTY shell an agent and the owner share (`shell.ts`), its prompt guards, the workspace's pipes shell (`pipes.ts`), the model's view of a shell (the screen as it is), and its record (`meta.json`, `output.log`); the terminal tool group (`terminal.ts`, `tools.ts`): shells by name, each command and each whole typed line planned from the shells (`plan`) for the session's gate, which decides it and holds what asks, and run only on what the gate decided, while the shell is where it was decided; a call cut off stopping the command it waited on, and a reply with no exit saying why; each command it ran, who ran it, when and its exit, in the shell's record; the note of a command its reply said runs on, once it ends, for the host to give the session, and a reply within 5 seconds where the host takes notes, or at once when a steer waits for the agent (Yian's `ctx.steered`), after the shell's check for a secret prompt, and a note when that command waits at one later; a shell as its session's live instrument (`instrument.ts`) | util, runtime/{permissions, sandbox} | tools, features/{chat, doctor, reach}, server/{daemon, local} |
| `features/chat/` | Conversations with an employee | Drives a session's runs: run specs, transcripts, the live relay, approvals, and the gate on every tool call (`gate.ts`, which the no-office host binds too) with its holds (cards made once yian holds a call, released or completed as answered, decided again after a rule is added, a worker starts or a restart); the employee's terminal (`terminal.ts`): its commands, decided by the run's gate, in the terminal's pipes shell in its workspace, each shell listed as the session's instrument, with its record in the session's `terminal/` folder, and the note of each command that ended sent to the run signed by its shell (the actor's `note`); the employee's Codex and Claude Code instruments (`instrument.ts`, bound in `codex.ts` and `claude.ts`): each session the chat's child session, listed as its instrument, with its record in the session's `codex/` or `claude/` folder, kept across an office restart, and the note of each turn that ended sent to the run signed by its session; a person's move of their unread message between the inbox and the queue, recorded in the session's folder until it is done, so a restart finishes it (`moves.ts`). Its flows are in `company/template/shared/flows/` | util, company, runtime (root, permissions, questions, runs, sandbox, sessions, store, worker), models, tools (root, claude, codex, harness, terminal), features/{claude, codex, profile} | features/questions, server (root, daemon, local, routes) |
| `features/codex/` | The owner's Codex sessions (#144) | A session harness beside the chat harness; each Codex thread under an employee's permission, with its own temp folder, the fence, the harness PATH and the owner's MCP servers off but those the employee may use, which start in the office's empty folder, its load and each message refused where a trusted project's own config would load, and each message where an MCP server was added since the load, but one the employee may use that Codex reaches by URL, and doctor's probe of one, which also runs a command in Codex's sandbox (`thread.ts`); a Codex installed in a folder the permission denies (the standalone installer's `~/.codex`) run from the office's private copy of its install in the owner's cache, one per Codex, mended in place when a file of it goes missing, and the copies of other Codexes removed once unused for a day and no program runs from them (`install.ts`); an employee chat's instrument sessions, its child sessions, with each message labelled for Codex and the owner's word winning, ended by an office restart and continued on their thread (`thread/resume`) by the chat's next instrument | util, company, runtime (root, sandbox, service, sessions, store, worker), models, tools/{codex, harness} | features/{chat, doctor}, server (root, daemon) |
| `features/claude/` | Employees' Claude Code sessions | Each an employee chat's instrument and that chat's child session (`sessions.ts`): one `claude` per session under the employee's permission, with a fresh temp folder, the MCP servers the employee may use (their definitions, and the empty folder they start in, in a folder of the session's in the office's home) and the speakers' instructions at each start; both speakers' messages labelled and sent as `next`, so a message mid-turn joins the turn; the owner's messages, Esc and its end through the session routes; Claude Code stopped after five idle minutes, and resumed (`--resume`) by the next message, as after it exits on its own; ended by an office stop without telling its instrument, and what a crash left ended at the next start, its record marked interrupted; continued after a restart (`--resume`) by the chat's next instrument | util, company, runtime (root, sandbox, service, sessions, store, worker), tools/{claude, harness} | features/chat, server (root, daemon) |
| `features/questions/` | What people do with a question | Card actions and side chats; registers itself as an office extension. `side_chat.yaml` is in the template | util, company, runtime/{questions, runs, sessions, store, worker}, features/chat | server (root, daemon, routes) |
| `features/profile/` | The profile manager | A chat that proposes edits to a person's profile. `profile_manager.yaml` is in the template | company, runtime/{store, worker} | features/chat, server/routes |
| `features/setup/` | Setting up this machine's office | `init`, `onboard`, `offboard`. init asks the model, the password and the remote on the terminal, then interviews the owner in a chat with OpenCorp (`flows/init.yaml`), which `interview.ts` hands to the no-office host as a built-in session; `propose_company` (`tools/`) holds the company on a card the session holds. Also the model picker (until yian#1714) and the prompters | util, company, runtime/{auth, service, sessions, worker}, models | features/{doctor, reach}, server/{commands, routes} |
| `features/doctor/` | The health check (no flow) | Checks home, company, model, the run logs (of a schema this office reads), service, sandbox (and a sandboxed program on a terminal), Codex (its version, sign-in, and a thread and a command in its sandbox under an employee's permission) and Claude Code (its version, and a start under an employee's permission that reads its sign-in), and the MCP servers each employee may use, by name, with whether each harness defines them; HQ's checks are passed in by `server/` | util, company, runtime/{auth, runs, sandbox, service, sessions, store, worker}, models, tools/{claude, codex, terminal}, features/{codex, setup} | server/{commands, hq} |
| `features/reach/` | Reaching an HQ on another machine | `opencorp hq`: the saved destinations, each in `hq/<name>/` with the model's sign-in shared (`paths.ts`), which there are and `--list`, `--rename` and `--forget` (`destinations.ts`); replay a destination's path, connect, hold it; learning, a chat with OpenCorp (`flows/learn_hq.yaml`) that `run.ts` hands to the no-office host as a built-in session: learning's terminal (`terminal.ts`), whose shells run in an SSH-only sandbox of their own, the agent's ssh wrapper in place of the system's ssh on Linux (`sandbox.ts`), and `save_access`, whose card the session holds and whose chain test runs in OpenCorp's connection shell (`connection.ts`), which then holds the tunnel | util, runtime/{permissions, sandbox, sessions, worker}, models, tools/terminal, features/setup | ; the CLI only |
| `server/` root files | What every server part takes | `office.ts`: the `Office`, `RequestContext`, and `OfficeHq`, what the socket routes call on HQ. `http.ts`: HTTP plumbing and errors. `auth.ts`: who a request acts as | util, company, runtime (root, auth, runs, sandbox, service, sessions, store, worker), models, features/{chat, claude, codex, questions} | server/{daemon, hq, local, routes} |
| `server/routes/` | The office's API | The HTTP routes clients call on the socket, HQ's among them (`hq.ts`). The event and instrument routes take narrow hosts (`EventsHost`, `InstrumentsHost`), which the `Office` and the no-office host each satisfy | util, company, runtime (root, auth, permissions, runs, sessions, store, worker), models, features/{chat, profile, questions, setup}, server | server/{daemon, hq, local} |
| `server/local/` | The no-office host | One built-in agent's chat with no office running, served as the office serves a session (`host.ts`): its flow in a kept `opencorp __worker`, every tool call through the chat's gate (`features/chat/gate.ts`) in the four modes with session rules only, its cards in memory, Auto's check as a worker job, its shells as instruments. Its routes (`routes.ts`) go through the office's pipeline on a private socket in a fresh 0700 folder, with a random token per start held in memory (`serve.ts`) | util, company, runtime (root, auth, permissions, questions, sessions, store, worker), models, tools/terminal, features/chat, server (root, routes) | — |
| `server/hq/` | HQ's web server | Serves the web app: guard, login, pairing, browser sessions, its API; the app's build ids (`version.ts`); HQ's checks for doctor (`checks.ts`) | util, company, runtime (root, auth, service, store), features/doctor, server (root, routes) | server/{commands, daemon}; the CLI, the app |
| `server/daemon/` | The office process | Start and stop, the lock, sockets, extensions; builds the `Office` and wires everything | util, company, runtime (root, permissions, runs, sandbox, service, sessions, store, worker), models, tools/terminal, features/{chat, claude, codex, questions}, server (root, hq, routes) | main.ts |
| `server/commands/` | The setup commands' process | `opencorp install init/onboard/offboard/doctor/start/stop/restart`, in a child, each asking on the terminal; init's interview runs in the chat the CLI's entry hands it (`Setup.chat`) | util, company, runtime/{auth, service}, models, features/{doctor, setup}, server/hq | main.ts |

**Inside each category, folders are ordered:**
- runtime: root, store, sandbox, auth → worker, service → questions, runs, permissions → sessions;
- tools: `harness/` → `codex/`, `claude/`; `terminal/` is independent; the root uses `terminal/`;
- features: profile, codex, claude, setup → chat, doctor, reach → questions;
- server: root → routes → hq, local → daemon, commands.

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
- A tool goes in the shared `src/tools/` when flows of more than one feature call it. Shared tools take their trust settings from the host, never from the model: the sandbox profile, the mode and rules, and who drives. A tool whose trust can't be bound that way stays in its feature.
- yian's built-ins (`ask_user`, `load_skill`, …) aren't host tools. A feature supplies only how a question reaches a person: its ask handler, in `run.ts`.
- An employee's own SOPs are flows in the company repo (`company/template/`), not in a feature folder.
- Tests mirror the layout: `tests/features/<feature>/tools/<tool>.test.ts`, `tests/features/<feature>/run.test.ts`.

## Rules that must not break

| Rule | Test |
|---|---|
| One-way imports; no folder cycles; every file layered; util stays generic | `packages/office/tests/repo/layer_direction.test.ts` |
| Bun only in `platform.ts`; no spawn of `process.execPath` elsewhere | `packages/office/tests/repo/layer_direction.test.ts` ("no Bun or bun: API outside platform.ts", "no spawn of process.execPath outside platform.ts") |
| src loads modules only with `import`, never `require()`, `module.require`, `import.meta.require` or `createRequire`; a dynamic import names its module in one quoted string | the same ("src loads modules only with import, never require", "every dynamic import in src names its module in one quoted string") |
| The daemon loads only builtins and the pre-re-exec files before it re-execs; `daemonMain` pins first | the same ("the daemon loads only builtins and the pre-re-exec files before it re-execs", "daemonMain pins the daemon before it loads the daemon") |
| The sandbox helper imports only `node:` | the same ("the sandbox helper imports only node builtins"), and `packages/cli/test/entry.test.ts` ("the fs helper imports only node builtins") |
| The cards match the imports | the same ("each folder card in ARCHITECTURE.md names what its folder imports and what imports it") |
| `tests/` mirrors `src/`; feature folders keep their shape | `packages/office/tests/repo/layout.test.ts` |
| Only the worker hosts yian runs | "no office code outside the worker calls a yian host function" in `packages/office/tests/features/chat/session_actor.test.ts` |
| Protocol changes update every package | the TUI's and HQ's contract tests against a real office (existing) |
| Secrets never in argv or logs; no scrubbing of an instrument's view or record, but the sandbox and the command reader's credential check keep the model's key and other credentials out of a shell's reach (the monitor's and the session actor's redactions stay). A harness runs as the owner with its own login and config; its own sandbox holds its commands to the employee's permission, which reads no credential folder, harness config or `~/.opencorp`, and nothing escalates but the MCP servers the owner allows that employee, which run as the owner and whose definitions their commands can't read | no single test: HQ pairing's, login's and redaction's tests each cover part (existing); the reader's credential check: `packages/office/tests/runtime/permissions/commands.test.ts` and `policy.test.ts`; a harness's permission: `packages/office/tests/runtime/sandbox/harness_profile.test.ts`, and every Codex thread under it: `packages/office/tests/features/codex/session.test.ts` |
| The run log is the source of truth; everything is a flow | no test; held in review |

### Protocol schema

The protocol is the zod schemas in `packages/protocol/src/schemas/`: the office and every client
take their types from them, and nothing is generated.

A PR may add, rename or remove a protocol field as long as it updates every package that uses it
(office, client, TUI, CLI, HQ app) in the same PR, and adds the matching store migration in
`packages/office/src/runtime/store/migrations/` when a field lands on a schema the store persists,
since inserts fail until the column exists. The additive-only rule and the schema-only-PR rule the
port suspended stay off until there are outside clients to keep compatible.

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

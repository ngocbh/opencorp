# agent-corp design (v5)

- Date: 2026-09-28
- Status: applies [review 3](agent-corp-design-review-3.md) and the owner's decisions after it
- Previous versions: [v4](agent-corp-design-v4.md) (after [review 2](agent-corp-design-review-2.md)),
  [v3](agent-corp-design-v3.md), [v2](agent-corp-design-v2.md) (after
  [review 1](agent-corp-design-review-1.md)), [v1](2026-09-27-agent-corp-design.md)
- Decision record: [issue #1](https://github.com/ngocbh/agent-corp/issues/1)
- Engine issues: agent-composer #256 (`ProfileMemory`), #324, #325, #327, #328, #330,
  #331 (open); #326 and #329 (closed, not needed)

Paths are relative to `agent-composer/` unless they start with `packages/` (OpenCode,
`~/workspace/opencode/`) or name an agent-corp directory.

## Changes from v4

Review 3 found one critical issue (C1) and eight important ones (I1–I8). The owner also
replaced the notebook with a markdown profile. Where v5 and v4 disagree, v5 wins.

- **Notebook → profile (owner decision).** Each agent is defined and remembered by one
  markdown file, `people/<id>/profile.md`, like `CLAUDE.md`. It replaces both the planned
  `persona.md` and the JSONL notebook.
  - Composer's side is `ProfileMemory` ([#256](https://github.com/ngocbh/agent-composer/issues/256),
    updated with agent-corp's requirements): recall the whole document, and the learner
    proposes a new version of it during `backward()`.
  - #329 (`NotebookMemory`) is closed as superseded.
  - Learning edits are **applied and committed automatically**, with the source in the
    commit message.
  - Gone: the op log, `merge=union`, op ids, op-id snapshots, and review-3 I7.
  - The notebook view and notebook manager become the **profile view** and **profile
    manager**.
- **C1 + I1 (what is sandboxed, owner decision A).** Sandbox only code that the model
  controls, not the engine.
  - Composer run workers are ordinary trusted processes: they run only composer and flows
    from the owner's repo. They own their run log and `SessionMemory`, call the model with
    the owner's provider keys, and write `profile.md` through the office's repo lock.
  - **Workspace tools** (read, write, edit, shell) run in a sandboxed subprocess per
    session, limited to the session's workspace.
  - **Asset tools** still execute in the office, which holds asset credentials and checks
    grants.
  - Codex and Claude run fully sandboxed, as before, because they run arbitrary code.
  - This needs no composer changes.
- **I2 (hang while waiting on a question).** On interrupt or end, the office answers the
  run's in-flight `ask_user` and office-side tool calls with `[interrupted by the user]` and
  marks the question `stale`, so the interrupt takes effect at once.
- **I3 (#327 vs conversation recording).** The interrupt keeps a model reply that has
  already arrived, records skipped tool calls as `interrupted`, and closes the turn with
  the engine's existing `interrupted` turn status. Partial text exists only once #331
  streams. This part of #327 may change with the owner's memory unification work in
  composer.
- **I4 (loop `max`).** The office counts turns and sends the exit command at the limit. The
  loop's `max` is only a backstop, and `LoopMaxExceeded` ends the session.
- **I5 (feedback timing).** Feedback is queued per **session** until no run of that session
  is live.
- **I6 (leftover workers).** Workers talk to the office over an inherited `socketpair` and
  exit when it closes. The office records worker pids, then kills and reaps leftovers
  before any resume.
- **I8 (lint).** The one-frame lint is dropped. Any flow that needs the profile declares it,
  and #256's "only the outermost frame learns" handles nesting.
- **Suggestions adopted:**
  - open model `ask_user` questions of a resumed run become `stale`;
  - "errors as tool results" is limited to office-side denials; engine-side tool errors
    are an open question;
  - after the cost cap interrupts a chat, further turns wait until the cap is raised;
  - killed runs are resumed under the same run id, and only failed chat runs add a new one;
  - profile writes are idempotent per backward attempt;
  - the debrief of a killed run reads the office transcript and accepts a possible gap;
  - the M1.5 spike checks that Codex with network off can still reach the office MCP
    endpoint.

## 1. Overview and principles

agent-corp lets anyone build a **company of AI employees** that works for them and
evolves with them. It is the application layer.
[agent-composer](https://github.com/ngocbh/agent-composer), the `agent-composer/`
submodule, is the engine. We own both, so any engine capability agent-corp needs
becomes a **generic** agent-composer feature, never a company-specific one.

Principles:

1. Simplicity, generality, and flexibility, in both projects.
2. agent-corp uses only agent-composer's public API. Composer never learns about people,
   companies, or permissions. Identity lives in the tools agent-corp builds for each run.
3. Everything an employee does **in composer** is a flow: chat, SOPs, debriefs, and the
   profile manager. Flows bracket external harness sessions (Codex, Claude): a debrief
   runs after each one, and feedback applies to it.
4. **Company as code**: definitions and profiles live in a git repo, and every change is
   a diff.
5. **Hard guarantees come from structure, not prompts**: code the model controls runs in a
   sandbox, credentials are held only by the office, permissions are checked on every
   call, and composer SOPs can be gated.
6. **Cautious by default**. Autonomy grows through the owner's instructions and grants.
7. **Work items** are the only way people communicate, humans and agents alike.
8. **Server-first sessions**: the office owns sessions, and every UI is an equal client.
9. Data stays on the owner's machines. HQ holds metadata, summaries, and the canonical
   company repo. Transcripts and run logs stay on the office that produced them.

Non-goals for now: hosted multi-tenant SaaS, Windows offices, employees rewriting their
own flows mid-run, and real-money trading before gated SOPs exist.

## 2. Architecture

```
Terminal (ac) ──unix socket──► Office (per machine, Python)
                                 ├─► run workers (trusted): composer runs
                                 │     └─► workspace tool sandbox (per session): read/write/edit/shell
                                 ├─► harness processes (sandboxed): codex | claude
                                 │ outbound WebSocket + git (M2)
                                 ▼
Browser/phone ────────────────► HQ (TypeScript) ──relay──► same office
```

| Component | Tech | Role |
|---|---|---|
| `ac` | TypeScript/Bun, one binary | CLI and TUI. From M2 it also contains the HQ server and embedded web UI |
| TUI (`packages/tui`) | Fork of OpenCode's TUI (OpenTUI + Solid) | person picker, chat, steer and interrupt, work-item context, profile view, debrief and feedback |
| HQ (M2) | Hono, SSE, Drizzle + SQLite | registry, org, work items, session index, relay, pairing, canonical company repo (git over the tailnet) |
| Web UI (M2) | Solid.js with OpenCode `session-ui`/`ui` components | org, work items, sessions, live view, prompt and approve, Profile tab |
| Office | Python daemon, installed by `ac onboard` via uv; runs under launchd/systemd | hosts employees and sessions; holds asset secrets, grants, and the repo; executes asset tools; starts, tracks, and kills workers, tool sandboxes, and harness processes |
| Run worker | Python process per composer run | runs one `run_flow`/`resume_flow` with composer in-process |
| Workspace tool sandbox | sandboxed subprocess per session | executes read, write, edit, and shell inside the session's workspace |
| Engine | agent-composer (submodule, used as a library) | flows, memory, learning, run logs |

### TUI: forked from OpenCode

- Copy `packages/tui` into this repo at a recorded upstream commit, and keep the MIT
  notice. We don't sync with upstream; we cherry-pick fixes when they're worth it.
- **Data layer**: replace `context/sdk.tsx` and `sync.tsx`. Our protocol client keeps an
  SDK-shaped surface (the same method names for the calls we keep), so most of the ~40
  call sites change little. Vendor or stub the parts of OpenCode's `core`, `plugin`, and
  `ui` packages that the kept screens need. The first M1 TUI task is an inventory of
  these.
- **Remove**: LSP, MCP management, provider login and OAuth, git and workspace
  features, the formatter, plugins, and anything else our flows don't need.
- **Add**:
  - the person picker and "hire new…";
  - the work-item context header;
  - steer (Enter while busy) and interrupt (Esc);
  - a profile view with a profile-manager chat;
  - debrief and feedback screens.
- The aim is OpenCode-level polish, so only change what our purpose needs.

### Protocol

- It keeps OpenCode's shapes: Session, Message, Part, Permission, and Question. A Part
  is text, file, or a stateful `ToolPart` (pending, running, completed, or error).
  Permission and Question are separate entities. We add our own entities: WorkItem,
  Comment, Person, Profile, and Debrief.
- It is defined once, in JSON Schema, and generated into TypeScript and pydantic.
- It has two channels:
  - **Metadata events**: work items, comments, session status, summaries, and cost.
    These are durable, carry ULID event ids, go through an outbox, and replay
    idempotently.
  - **Live content**: messages, parts, and streams. These go only to subscribed clients.
    They are never sent through the outbox or stored at HQ. Clients fetch history from
    the office that owns the session.
- The worker forwards composer's `on_event` (observer events, including in-loop model
  and tool events from #331) and `on_stream` (token chunks) to the office, which maps
  them onto Parts and stores the session transcript. Harness events are mapped the same
  way.

### Composer runs

- The office starts one **run worker** process per `run_flow` or `resume_flow`. It passes
  one end of a `socketpair` as the worker's only channel to the office. The worker exits
  when the channel closes, so it never outlives the office.
- The worker is **trusted**: it runs composer and flows from the owner's repo, as the
  owner. It owns its run log and the session's `SessionMemory` store, and calls the model
  with the owner's provider keys. It does not hold asset credentials, and it never runs
  model-controlled code itself.
- The worker builds that run's tools and passes them with `tools=` (#324):
  - `ask_user` and the company tools, which forward to the office;
  - the person's permitted **asset tools**, through the `toolbox` group (#325), which
    forward to the office;
  - the person's **workspace tools**, through the same group, which forward to the
    session's sandbox.

  Every tool is bound to `(person id, session, run)`. The worker turns off the global tool
  registry fallback (#324), so only these tools exist in the run.
- The worker passes an inbox with `steering=` (#327). `drain` and `interrupted` are
  synchronous calls to the office, so the office knows exactly which steer messages were
  delivered.
- **Stopping a run**: the office kills the worker and waits for it to exit. Composer's log
  survives this: the `flock` is released by the OS, and `resume_flow` repairs a partial
  last line (`runtime/log.py:843`, `run.py:479`). Pause is "kill now, resume later".
  Composer has no cancel API, and nothing in the engine knows who is running.
- **Leftover workers**: the office records each worker's pid. On start, and before any
  resume, it kills and reaps leftovers, because the run log lock and the SQLite store fail
  immediately if another process holds them (`runtime/log.py:869`, `memory/storage.py:167`).

### Networking and data (M2)

- HQ binds to loopback and is exposed with `tailscale serve`. Every client device must
  be on the tailnet. Alternatives (a VPS, Cloudflare Tunnel) are documented and opt-in.
- Offices connect **outbound**, so clusters need no inbound ports.
- **Pairing**: offices and client devices join with a token the owner approves. Each
  client gets its own key.
- **Data residency**:
  - HQ stores metadata, summaries, and cost. It also hosts the canonical company repo,
    which includes profiles.
  - Transcripts, run logs, and secrets stay on the office that produced them.
  - A GitHub mirror of the company repo is optional and off by default.
  - A per-person provider policy controls which LLM providers may see which data.

### Naming and layout

agent-corp's CLI is `ac`. agent-composer's CLI is renamed `composer` (#330).

```
agent-composer/        # submodule; the office depends on it as a uv path dependency
packages/protocol/     # JSON Schema → TS types + pydantic
packages/tui/          # forked OpenCode TUI
packages/ac/           # CLI entry; HQ + web from M2
office/                # Python office daemon, run worker, tool sandbox, permission layer, harness adapters
docs/plans/
```

## 3. Data model

### Company repo (one git repo per company)

```
company.yaml
people/<id>/person.yaml      # structured fields
people/<id>/profile.md       # who the agent is, how it works, what it has learned (agents; optional for humans)
people/<id>/sops/            # agents' SOP flows
groups/<id>.yaml
assets/<id>.yaml             # things that can be used, with grants
shared/flows/                # chat.yaml, debrief.yaml, profile_manager.yaml, triage.yaml
```

**Identity**: people are identified the way users are in an OS:

- **`id`**: permanent and never reused, like a uid. Directories, references,
  permissions, profiles, and logs all use it. It's minted at creation, as a ULID by
  default or a slug chosen then.
- **`handle`**: unique and changeable, like a username, for example `@minh`. It's how
  people are addressed in the UI, CLI, and prompts.
- **`name`**: the display name.

Renaming someone changes their `handle` and `name`, never their `id`.

The org chart is **people plus reporting lines**. No roles are hardcoded: an assistant
or a CTO is just another person.

```yaml
# company.yaml
name: ngocbh-corp
hq: https://hq.my-tailnet.ts.net     # M2
ceo: ngocbh                          # person id; root of the org chart
defaults: { provider_policy: default, cost_cap_usd: 5, idle_end: 2h, max_turns: 500 }
```

```yaml
# people/ngocbh/person.yaml (a human)
id: ngocbh
handle: ngocbh
name: Hong Ngoc Bui
kind: human
title: CEO
manager: null
```

```yaml
# people/01J9Z3K7.../person.yaml (an agent)
id: 01J9Z3K7QX8R2M4T6V0W1Y3A5C
handle: ava
name: Ava
kind: agent
title: Executive Assistant
manager: ngocbh
groups: []
home_office: laptop              # where routines and folderless work run
main: ../../shared/flows/chat.yaml
sops: []                         # e.g. {flow: sops/trade.yaml, gate: true}
harnesses: [composer]
harness_policy: { sandbox: workspace-write, network: false }
routines:
  - name: triage_ceo_queue
    trigger: { event: work_item.created, assignee: ngocbh }   # plus a periodic sweep
    flow: ../../shared/flows/triage.yaml
provider_policy: default
```

```markdown
<!-- people/01J9Z3K7.../profile.md -->
# Ava, Executive Assistant

## Role
Screen the CEO's queue. Decide simple items on the CEO's behalf; forward the rest with a
summary, options, and a recommendation.

## How I work
- Cite the instruction I relied on for every on-behalf decision.

## Learned
- Travel bookings under $500: decide. Anything touching hiring: always forward.
```

The structure inside `profile.md` is free. The owner shapes it, and the learner keeps it.

```yaml
# groups/infra.yaml
id: infra
name: Infrastructure
parent: null                     # groups may nest (department → team)
head: 01J9...                    # optional person id
```

```yaml
# assets/cluster-a.yaml
id: cluster-a
kind: slurm_cluster              # selects the tool implementations
tools:
  submit_job: {}
  read_logs: {}
  cancel_job: {}
  delete_data: { risk: gated }   # reachable only through gated SOPs
grants:
  - who: group:infra
    can: [submit_job, read_logs]
    where: { partition: [gpu-small] }    # optional argument constraints
  - who: 01J9...                         # a person id
    can: [admin]
secrets: [cluster_a_ssh_key]             # names only; values live in the office secret store
```

```yaml
# assets/longhstu.yaml (workspace tools are an asset too)
id: longhstu
kind: local_folder
path: ~/workspace/longhstu       # resolved per office
tools: { read: {}, write: {}, edit: {}, shell: {} }
grants:
  - who: 01J9...                 # Minh
    can: [read, write, edit, shell]
```

Organizations grow by adding people. You can start flat, with everyone reporting to
the CEO, then add a CTO with reports, a CFO, or more assistants. The app filters by
**reporting subtree** ("everything under @kai") or by **group**.

### Distribution

- Each office keeps one clone of the company repo, outside every sandbox.
  - **Main working tree**: profile writes land here.
  - **Pinned definitions**: a session or run reads definitions from a **read-only
    worktree** for its pinned commit, cached by commit. Relative flow references resolve,
    and the profiles in the main tree never go back in time.
- **One repo lock** (an office-held lock that workers request over their channel)
  serializes profile writes, commits, pulls, and pushes.
- The office pulls on start, before each session, and when HQ sends `repo.updated` (M2).
- **Definition changes** (hiring, SOPs, grants):
  - M1: changes the owner starts from `ac`, such as "hire new…", show the diff and
    commit when the owner confirms.
  - M2: they are written on a branch, and the owner approves the diff to merge.
- **Profile edits** are committed automatically; see "Profile memory".
- **M1 has no remote.** From M2 the office pushes to HQ. HQ's pre-receive check accepts
  office pushes to main only if they change `people/*/profile.md` and nothing else.
- Which folders belong to which person is machine-specific, so it lives in the office
  store, not the repo.
- Schema validation and lint run in Python, in pre-merge CI and in the office on load.
  HQ trusts the office's lint result.

### Permissions

The office is an OS-style reference monitor, and it's the only process holding asset
credentials:

- **Subjects** are people, identified by `id`. Groups are how grants are shared.
- **Objects** are assets (`assets/*.yaml`, including workspace folders) and people's
  profiles.
- **Grants** list who can do what. `can` names tools or `admin`, and an optional
  `where` constrains the tool's arguments.
- **Enforcement**:
  - At run start, the office tells the worker which tools the person holds grants for.
  - The worker exposes them through the `toolbox` group (#325), with names namespaced by
    asset (`cluster_a__submit_job`, within `[a-zA-Z0-9_-]{1,64}`).
  - Every asset-tool call goes to the office, which:
    1. re-checks the grant against the repo state it currently has, including the
       arguments;
    2. executes the tool with credentials from its secret store;
    3. records an audit entry: person, run, tool, arguments, and result;
    4. returns the result, or a **denial or error as a tool result**. The model sees
       "permission denied: …" and the run continues.
  - Workspace-tool calls go to the session's sandbox, after the same grant check and audit.

  The model and the worker never see asset credentials. A tool the person has no grant
  for doesn't exist in their run.
- **Changes**: revoking a grant takes effect on the next call. A new grant on a tool the
  run already has also works immediately. A tool that wasn't in the run's toolbox
  appears in the next run.
- **Company tools** every person has: `ask_manager`, `create_work_item`, `comment`, and
  `ask_user`. Each is bound to the caller's id.
- **Profile access**: by default the person's **human** managers can read and edit their
  profile directly, and the person can read it. Agents never edit profiles directly (see
  "Who writes the profile"). A grant file can change the defaults.
- **Owner-only operations** (approving diffs, editing grants, editing profiles,
  answering on someone's behalf) go through the office socket. Only unsandboxed
  processes can reach it, and the model never runs code outside a sandbox.

### Runtime entities and ownership

| Entity | Owner | Others hold |
|---|---|---|
| Person, Group, Asset, routines, **profiles** | company repo (canonical copy at HQ from M2) | offices: clones |
| Office, pairing, client keys | HQ | office: its own credentials |
| WorkItem, Comment | HQ (office store before pairing or while HQ is unreachable) | offices: cache |
| Session (metadata) | office running it | HQ: index (status, summary, cost) |
| Message, Part, run logs, `SessionMemory`, secrets | office running the session | nobody; live relay only |
| PendingQuestion, queued feedback | office running the run | HQ: metadata (a gate question is also a work item) |

Fields:

- **WorkItem**: id (ULID), title, kind (`task` | `question`), status, assignee,
  requester, parent_id, groups, `gate` (bool), resolved_by, on_behalf_of, summary, cost,
  version, timestamps.
- **Comment**: id, work_item_id, author, body, on_behalf_of.
- **Session**: id, person, harness, harness_session_id, office, work_item_id, cwd,
  repo_commit, `run_ids[]`, status, cost, timestamps. A session normally has one run. A
  killed run is resumed under the same id. A new run is added only when a chat run
  **fails** and the office starts a fresh one.
- **PendingQuestion**: id, session_id, run_id, node_id (null for model `ask_user`),
  payload, gate, answer, answered_by, status (`open` | `answered` | `consumed` | `stale`).
- **RunRef**: office, run_id, work_item_id, repo_commit. It points to a run log on an
  office and is the target of feedback.

**Sync**: IDs are ULIDs, minted wherever an entity is created. An office that creates
work items offline, or before any HQ exists (as in M1), uploads them through the outbox
later. Each update carries the version it was based on. On a conflict, HQ keeps its
state and attaches the office's change as a comment. A human resolution at HQ always
stands.

### Work items and triage

- Humans are people with a work-item queue and no flows.
- Questions go up the `manager` chain. Each manager decides from its goals and
  instructions, or escalates. A question to the CEO is simply a work item assigned to
  the CEO.
- **Queue triage**: the assistant's `triage_ceo_queue` routine lets it act on the CEO's
  queue. The routine is in the repo, so the owner approved it, and HQ (the office
  store in M1) checks that the routine exists before accepting a resolution made on
  someone's behalf. For each item the assistant does one of two things:
  - decides it, marked "on behalf of" and citing the instruction it relied on; reopening
    that item counts as feedback;
  - leaves it assigned, with a triage comment: summary, options, and a recommendation.

  It starts out forwarding everything.
- **Gate items** (`gate: true`) can only be resolved by a human on a paired device (see
  "Gates"). Assistants may annotate them but not answer them.

### Employees and memory

- An employee is a persistent identity. Its runtime is **on demand**: it starts when a
  session, work item, comment, or routine arrives.
- **Main flow** (composer harness): a loop in the shape of `chat.yaml`
  (`src/agent_composer/cli/chat/chat.yaml`). `human_input` asks for the next message, a
  `case` routes the exit command to the loop's exit, and a tool-calling agent replies
  with the person's toolbox.
  - The reply agent is `steerable: true` (#327). It has `str` output, as #327 requires.
  - **Turn limit**: the office counts turns from `on_event` and sends the exit command at
    `max_turns`. The loop's own `max` is set higher, as a backstop only.
  - Conversation continuity comes from `long_term_memory: session`, with one **durable**
    `SessionMemory` (SQLite) per session. It's kept as long as the session's run logs,
    because resume and backward reopen it at its recorded snapshot.
  - The profile comes from `long_term_memory: profile` on the flow.
  - The main flow can evolve per role.
- **SOPs** are fixed flows for recurring work, later exposed as tools. Work evolves from
  improvising, to an SOP the owner approves as a diff, to improvements from feedback.
  An SOP declares `profile` too, so it can run and learn on its own. When a chat calls it,
  only the outermost frame recalls and learns (#256).
- **All runs start with `learnable=True`** (chat, SOP, debrief, triage, profile manager),
  so any finished run can take feedback.
- **Profile memory** (`ProfileMemory`, composer #256):
  - **Document**: one markdown document per instance. agent-corp creates one instance per
    person, stored at `people/<id>/profile.md`.
  - **Recall**: the whole document goes into context when the outermost frame opens. So
    the profile also carries the persona; no separate persona input is needed.
  - **Learning**: during `backward()`, the learner gets the trajectory, the feedback, and
    the current document, and proposes a new version. It may add, rewrite, merge, or
    delete text, and it keeps the document within budget.
  - **Storage**: agent-corp supplies a `ProfileStore`. `read(version)` returns the text at
    any git version a run recorded. `write(text, base_version, provenance)` takes the repo
    lock, writes the file, and commits. Writes are idempotent per backward attempt.
  - **Stale versions**: if the file changed since the run's version, `write` reports a
    mismatch. The learner re-applies its edit to the current text rather than overwriting.
    The same happens when a push to HQ loses a race (M2): the office pulls, and the
    learner re-applies. No git conflict reaches a human.
  - **Host methods**: `read` and `write` outside a run, for the profile view and the
    profile manager.
- **Who writes the profile**:
  - **Agents change their profile only through `backward()`.**
  - **Humans may edit directly**, subject to profile access. That can be by hand or
    through the profile manager.
- **Recall timing**: a live chat sees the profile as it was at session start. The next
  session picks up edits and new tools. External harnesses get `profile.md` injected at
  session start.
- **Auto-commit**: every profile write is committed automatically, with no approval. The
  message records the source, for example
  `profile(@minh): from feedback on run 01J… (ngocbh)` or
  `profile(@minh): ngocbh via profile manager`. `git log` and `git blame` are the
  provenance. From M2 the office then pushes; while offline, commits stay local and are
  pushed later.

### Learning and feedback

- **Feedback on a run** (a chat session, an SOP run, a debrief, or a reopened
  on-behalf-of decision) targets a **finished** run. Feedback is saved and queued per
  session until **no run of that session is live**, because `backward()` reopens the
  session's single-owner `SessionMemory` store. Then the office:
  1. starts a worker with the flow from the pinned read-only worktree, because
     `resume_flow` verifies the fingerprint (`docs/api.md:757`);
  2. calls `resume_flow` on the log, which reuses every finished node, so nothing
     re-runs;
  3. calls `result.backward(feedback)`. The profile learner proposes a new version of
     `profile.md`, and the store commits it.

  #328 allows more than one backward attempt per run, so anyone with profile access can
  add feedback to an old run later.
- **Feedback on one turn**: the feedback is text on the whole run that names the turn.
  The TUI pre-fills "About turn 3: …" when you pick a turn.
- **Where**: `ac feedback <session|run>` or the TUI debrief screen (M1), and the app (M2).
- **Retries**: a failed attempt is retried only if it failed before the store committed.
  Otherwise the feedback shows `learning failed` for a human to look at.
- **Feedback not tied to a run**: open the person's profile (the TUI profile view in M1,
  the HQ web Profile tab in M2) and edit it. Git keeps the history.
- **Profile manager** (`shared/flows/profile_manager.yaml`):
  - It's a built-in forward flow, not a person in the org chart.
  - You chat with it from the profile view: "merge the duplicate Python rules",
    "rewrite this section as a checklist".
  - It gets `read` and `propose_edit` for that profile through the toolbox. It returns a
    diff, and you click Apply. The commit is labelled `ngocbh via profile manager`.
  - It only runs when a human asks, so its changes count as that human's direct edits.

### Gates and sandboxing

Decision 7 = A: external harnesses are fenced rather than forbidden. After review 3
(owner decision A), the rule is: **sandbox the code the model controls, not the engine.**

- **Trusted, unsandboxed**: the office, `ac`, run workers, and the owner's shell. They run
  only the owner's code: composer, and flows and code nodes from the owner's repo.
- **Sandboxed** (macOS Seatbelt, Linux bubblewrap/Landlock), under the person's
  `harness_policy`:
  - the per-session **workspace tool sandbox**, where every read, write, edit, and shell
    call runs;
  - **Codex** and **Claude** processes.

  The sandbox allows the session's workspace (write) and the network only when a grant
  allows it. It denies the office socket, the office store, secrets, run logs,
  `SessionMemory` files, and the repo clone.
- **Channels into the office from sandboxed processes**: Codex and Claude reach company
  and asset tools only through the per-session MCP endpoint. It's authenticated with a
  secret created for that session and handed to the process at start. The secret is
  valid only for its own person and session.
- **Credential isolation**: asset secrets live in the office secret store, and only the
  office uses them, inside tool execution. Sandboxed processes get a scrubbed
  environment. Workers hold only the owner's model provider keys.
- **Flow-structure guarantees cover composer SOPs.**
  - Tools marked `risk: gated` can be reached only through SOPs marked `gate: true`,
    which contain authored approval nodes (`case` + `human_input`).
  - Lint rejects definitions that break this, and rejects `ask_user` inside gate SOPs.
  - Codex and Claude can *call* a gated SOP as a company tool, but the gate still applies.
- **Authored-only answers**: a question counts as a gate only if it comes from a gate
  SOP's `human_input`. The engine hides trusted `ask_user` fields from the model (#324),
  so a model `ask_user` call can never pose as one.
- **Paired-device approval**: a gate answer is accepted only from a paired client device
  with its own login, such as the web app on a phone. The local socket is not enough on
  its own, as defense in depth. Terminal approval may come later, with a passphrase that
  isn't stored or with Touch ID.
- **Consequence**: gated SOPs need M2 (pairing). M1 has no gated SOPs, but it already has
  the workspace sandbox and office-side asset tools.

## 4. Sessions

### Starting (M1, local)

1. **Start**: run `ac` (composer harness) or `ac codex` (M1.5) in `~/workspace/longhstu`.
   The picker lists people associated with the folder first, then recent people, then
   "hire new…". The owner picks @minh.
2. **Register**: the office creates a WorkItem (assignee Minh, requester the owner) and a
   Session with ULIDs. The session runs on the **office where the folder lives**: the
   identity travels, and the work stays next to the code.
3. **Boot**: the office pins the repo commit, starts the session's workspace sandbox, and
   starts a worker running the main flow as **one live run**. For Codex it starts the
   adapter instead, with `profile.md` injected, under his `harness_policy`.
4. **Connect**: `ac` talks to the local office directly over a unix socket. It never
   goes through HQ. Browsers and phones (M2) reach the office through HQ's relay. The
   office owns the session.

### Keys (composer chat)

| Input | Employee idle (waiting for your message) | Employee busy (replying or using tools) |
|---|---|---|
| Enter | New turn | **Steer**: the message goes to the run's inbox (#327) and is added at the top of the next tool-loop iteration. If the reply finishes before the message is delivered, it becomes your next turn. If the agent is waiting on a model `ask_user`, Enter answers that question |
| Esc | — | **Interrupt**: the office answers any in-flight `ask_user` or office-side tool call with `[interrupted by the user]`, and the reply stops at the next safe point (#327). The chat continues and waits for your next message. The TUI stops showing the stream immediately |
| Ctrl+C twice | Leave the view. The session keeps running on the office | — |
| `/end` | End the session through the flow's exit, then debrief | Interrupt first, then end |

- Other clients (M2) see the same session and can use the same controls.
- For a tool-approval request, the first answer from any connected client wins.
- SOP and task runs don't take steering. The office can **stop** them by killing their
  worker, and **pause** them by killing now and resuming later with `resume_flow`.

### Waiting for answers

- A `human_input` (a new chat turn, an SOP question, or a gate) waits in the live worker
  until someone answers.
- The office stores each question as a PendingQuestion before showing it. Questions from
  `human_input` are keyed by `(run_id, node_id)`; LOOP and MAP occurrences already have
  unique expanded node ids. Model `ask_user` questions have no node id.
- If a `human_input` re-runs after a restart, `ask_user` finds the key. It returns the
  stored answer if there is one; otherwise it shows the same item again.
- When a run is resumed, its open model `ask_user` questions become `stale`, because the
  agent node that asked them re-runs and asks afresh.

### Ending

1. The session ends with `/end`, with `ac end`, after the idle timeout (`idle_end`), or at
   `max_turns`. In each case the office interrupts a busy reply first (answering any
   in-flight `ask_user`), then answers the waiting `human_input` with the flow's exit
   command, so the run **finishes normally**. Closing the terminal doesn't end the
   session.
2. The office runs `shared/flows/debrief.yaml` on the session transcript. It outputs
   `summary`, `status`, `artifacts`, `decisions[]`, `follow_ups[]` (the owner confirms
   these), `open_questions[]`, and `cost`. Summary and cost are metadata, which HQ stores
   from M2.
3. Queued feedback is applied, and later feedback goes through `backward()` on the
   finished run (§3). The next session, in any harness, gets the updated `profile.md`.

### Harness adapters

- **Interface**: `start(profile, cwd, tools_endpoint, policy)`, `send(prompt)`,
  `steer(message)`, `interrupt()`, `events()`, `approve(request)`,
  `resume(harness_session_id)`, and `close()`.
- **Composer**: `steer` and `interrupt` go through the inbox (#327). `close` ends the run
  through the flow's exit.
- **Codex** (M1.5) and **Claude** (M3) are driven through their programmatic interfaces,
  not their TUIs. `steer` falls back to queueing where the harness has no mid-turn input.

## 5. Failures and recovery

Each entity has one owner (§3 table), and that owner's record wins. Offices never ship
content to HQ.

- **HQ unreachable**: local chat, routines, and blocked runs continue.
  - Metadata events go to a SQLite outbox and replay on reconnect. Event ids make the
    replay idempotent.
  - Profile commits stay local and are pushed later.
  - Web access is unavailable meanwhile.
- **Office offline**: HQ marks it offline after missed heartbeats. Its sessions show as
  offline and their content is unavailable. New work for people homed there waits at
  HQ. There is no failover.
- **Office or worker restart mid-run**: the office kills and reaps leftover workers,
  starts a new worker, and calls `resume_flow` from the log under the same run id.
  - Finished nodes are reused.
  - An unfinished `human_input` re-shows its stored question or returns the stored
    answer.
  - An unfinished agent node re-runs, which may repeat model calls and tool effects. That
    is accepted and documented. Its open model `ask_user` questions become `stale`.
  - Codex and Claude sessions resume through their own session ids where supported.
    Otherwise the session becomes `interrupted`, and the debrief runs on what exists.
- **Chat run fails** (a model error, an engine-side tool error, or the loop's backstop
  `max`): `LoopMaxExceeded` ends the session. Any other failure makes the office start a
  new chat run in the same session, as `ac chat` does (`cli/chat/command.py:5-13`).
  `SessionMemory` carries the conversation. The failed run is finished (failed), so it can
  take text feedback once the session has no live run.
- **Killed and never resumed**: the debrief runs on the office's transcript, which may miss
  the last event before the kill. The run can't take feedback. That is accepted.
- **Runaway cost**: every session and routine has a cost cap, from the person's policy or
  the company default. Usage comes from composer's per-call usage events (#331) and a
  per-model price table.
  - In a chat, hitting the cap interrupts the reply, like Esc, and creates a work item
    for the manager. Further turns wait until the cap is raised.
  - In an SOP or task run, it kills the worker (a pause) and creates the same work item.
    Raising the cap resumes the run.
- **Definition changes**: runs pin their repo commit. Resuming a run, or running feedback
  on it, loads the flow from that commit's read-only worktree. Invalid definitions are
  rejected before merge.
- **Concurrent profile edits**: the store's version check plus learner re-apply means
  concurrent edits never clobber each other or conflict in git (§3).
- **Debrief or learning failure**: the session shows `debrief pending`, or the feedback
  shows `learning pending`, and it's retried by the rule in §3. Transcripts and feedback
  are never deleted.
- **Revoked grant mid-run**: the next call to that tool returns a permission error as its
  result, and the run continues.
- **Sync conflict**: HQ keeps its state, and the office's change becomes a comment.
- **Revoked pairing**: HQ drops the office. The office keeps its local data but stops
  syncing.

## 6. Testing

Each milestone's journey runs in CI with no API keys, using fakes at the edges.

- **Composer (in agent-composer)**: each issue ships its own tests.
  - #256: whole-document recall within budget; a learner edit from feedback; a
    stale-version write re-applies to the current text; a human edit between the run and
    the feedback survives; only the outermost frame learns; resume and backward reproduce
    the recorded version.
  - #324: two concurrent runs with different `tools=` and `ask_user` never cross; the
    model schema of `ask_user` shows only `question`; and with the fallback off, a
    globally registered tool is absent.
  - #327: steer messages land only at the top of the tool loop and are recorded. An
    interrupt keeps an arrived reply, records skipped tool calls as interrupted, closes
    the turn as `interrupted`, and the loop continues. An interrupt aimed at a finished
    node is ignored.
  - #328: a second `backward()` succeeds, and both attempts are in the log.
  - #331: token chunks arrive through `on_stream`, in-loop events arrive in order, and
    usage totals match the stub.
  - Kill safety: kill a process mid-run, then `resume_flow` succeeds.
- **Office (pytest)**:
  - **Permissions**: a tool without a grant is absent. A `where` violation comes back as
    a tool result. A revocation applies on the next call. Asset credentials never appear
    in the worker or in model-visible text. The audit log is complete.
  - **Sandbox**: from inside the workspace sandbox and a fake harness, the office socket,
    store, secrets, run logs, `SessionMemory`, and repo clone can't be reached; writes
    outside the workspace fail. An MCP secret from another session is rejected.
  - **Workers**: a worker exits when its channel closes; leftover workers are killed
    before resume.
  - **Chat run**: new turn, steer, and a steer that arrives late becomes the next turn.
    Esc while the agent waits on a model `ask_user` takes effect at once. Interrupt, then
    the next turn sees the prior conversation. Restart while idle re-shows the same
    question. A failed run is restarted in the same session. `max_turns` ends the session.
  - **Learning**: `/end` → the run is finished → feedback → `resume_flow` → `backward` →
    a new `profile.md` version → auto-commit with the source → the next session sees it.
    A second feedback on the same run also works. Feedback while any run of the session is
    live is queued. A profile-manager Apply commits "via profile manager".
  - **Git**: pinned worktrees stay unchanged while profiles are written, and the repo lock
    serializes concurrent writers.
  - **Triage**: a resolution on someone's behalf is rejected unless the routine exists,
    and gate items are rejected outright.
  - **Flows** (chat, debrief, profile manager, triage) run against a scripted LLM stub.
- **Gates**: a model `ask_user` can't answer a gate; a gate answer arriving over the
  local socket alone is rejected; and sandboxed environments contain no secrets.
- **TUI (`bun test`)**: frame snapshots for the picker, chat, steer, interrupt, profile
  view, and debrief, run against a fake office.
- **End-to-end (M1)**: one command starts an office, then scripts this journey:
  1. `ac` → pick @minh → prompt that makes him edit a file in the workspace;
  2. steer mid-reply, then Esc and prompt again;
  3. `/end` → debrief → `ac feedback`;
  4. the next session sees the updated `profile.md`, and a profile commit exists.

  M1.5 adds a fake Codex harness. M2 adds HQ and a web client.
- **Failure tests**:
  - kill a worker mid-run and resume;
  - kill HQ and check the outbox replays without duplicates;
  - two offices edit one profile and both edits survive;
  - two clients answer one question, and the first answer wins.
- **Outside CI**: opt-in live smoke tests with real models, Codex, and Claude, plus a
  small manual eval that feedback actually changes the next session's behavior.

## 7. Build order

**M0: composer prerequisites** (issues in agent-composer, one PR each):
[#256](https://github.com/ngocbh/agent-composer/issues/256) `ProfileMemory` (markdown),
[#324](https://github.com/ngocbh/agent-composer/issues/324) per-run `tools=` with
`ask_user`, [#328](https://github.com/ngocbh/agent-composer/issues/328) multiple
`backward()`, [#330](https://github.com/ngocbh/agent-composer/issues/330) CLI rename, and
[#331](https://github.com/ngocbh/agent-composer/issues/331) streaming and usage.
[#325](https://github.com/ngocbh/agent-composer/issues/325) (toolbox) and
[#327](https://github.com/ngocbh/agent-composer/issues/327) (steer and interrupt) can land
during M1.

**M1: a local employee who learns** (no HQ):

1. **Protocol and company repo**: the JSON Schema protocol, generated into TS and
   pydantic; a repo loader covering people, groups, and assets; schema validation and
   lint; pinned worktrees and the repo lock.
2. **Office**:
   - the daemon, the unix socket, and a SQLite store (work items, sessions, pending
     questions, queued feedback, outbox);
   - run workers over `socketpair`, with pid tracking;
   - the workspace tool sandbox (Seatbelt on macOS first) and the `local_folder` asset;
   - the permission layer and office-side asset tools;
   - the composer chat harness as a live run, with steer and interrupt;
   - the `ProfileStore`, auto-commit, the debrief, feedback via `backward()`, and the
     profile manager;
   - `ac onboard`, which installs the daemon under launchd/systemd, falling back to a
     tmux or login-shell process where user daemons aren't allowed.
3. **TUI fork**:
   - an inventory of OpenCode's `core`, `plugin`, and `ui` dependencies;
   - strip the unneeded features;
   - an SDK-shaped protocol client;
   - then the picker, chat, steer and Esc, the profile view, and the debrief and
     feedback screens.
4. **E2E suite, then dogfooding** with Minh on real repos.

*Milestone: chat with Minh in `ac`, steer and interrupt him, give feedback, and see his
next session change.*

**M1.5: Codex.** Start with a spike on the Codex programmatic interface: instruction
injection, approvals, resume, MCP tools, token usage, mid-turn input, whether its sandbox
can deny the office paths and the socket, and whether it can reach the office MCP
endpoint with network off. Then build the adapter, the authenticated office MCP
endpoint, and `harness_policy`.
*Milestone: `ac codex` with Minh, with the same `profile.md` across both harnesses.*

**M2: from anywhere.** HQ (pairing, org, work-item and session API, WebSocket relay,
outbox sync, the canonical company repo over git with the pre-receive check); the web UI
(org, work items and sessions filtered by subtree or group, live view, prompt and
approve, Profile tab); paired-device gate approvals; definition changes on branches.
*Milestone: watch and steer a laptop session from a phone.*

**M3: team.** The Claude adapter, routines (including Ava's `triage_ceo_queue`),
delegation between employees, escalation chains, and dogfooding with 2–3 people.

Later phases:

1. **Growth**: HR hiring through repo diffs, SOP codification with gates, flow-as-tool,
   `system_prompt:` (#259), and skills (#260).
2. **Distribution**: offices on clusters, an infra department, and an Obsidian knowledge
   base.
3. **High stakes**: finance with gated trading SOPs, a cost department, messaging
   channels, and OpenClaw integration.

## 8. Required agent-composer changes

All are generic. None mentions companies, people, or permissions.

| Issue | Change | Milestone |
|---|---|---|
| [#256](https://github.com/ngocbh/agent-composer/issues/256) | `ProfileMemory` as **one markdown document per instance**: whole-document recall within budget; the learner proposes a new version during `backward()`; host-supplied `ProfileStore` with versioned `read`/`write` and provenance; stale versions re-applied; only the outermost frame of an instance recalls and learns; host `read`/`write` outside a run | M0 |
| [#324](https://github.com/ngocbh/agent-composer/issues/324) | Per-run `tools=` on `run_flow`/`resume_flow`, including `ask_user`. Removes the process-wide `install_ask_user` (`tools/registry.py:168-205`). The engine wraps the host's `ask_user` in the fixed schema, so only `question` is visible to the model. An option turns off the global `TOOL_REGISTRY` fallback. The type of `tools` allows groups (#325) | M0 |
| [#325](https://github.com/ngocbh/agent-composer/issues/325) | Host-supplied tool groups: `tools: [toolbox]`, filled per run. Groups are expanded before the grant check (`tool_calling.py:151`) | M1 |
| [#327](https://github.com/ngocbh/agent-composer/issues/327) | Steer and interrupt through a host inbox. `drain(node_id)` returns steer messages at the top of the tool loop. `interrupted(node_id)` is checked at the loop's safe points. On interrupt, the node keeps any model reply that already arrived, records skipped tool calls as `interrupted`, closes the conversation turn with the existing `interrupted` status (`memory/contracts.py:1766`), and returns its text so far. Once #331 streams, the stream loop becomes a safe point, and the partial text is what the user saw. `steerable: true` is valid only on `tool_calling` agents with `str` output. The conversation-recording details may change with the owner's memory unification work | M1 |
| [#328](https://github.com/ngocbh/agent-composer/issues/328) | Multiple `backward()` attempts per run (today one, `runtime/backward.py:221-223`) | M0 |
| [#330](https://github.com/ngocbh/agent-composer/issues/330) | Rename CLI `ac` → `composer` | M0 |
| [#331](https://github.com/ngocbh/agent-composer/issues/331) | AGENT token streaming through `on_stream`; observer events for in-loop model and tool calls; per-call token usage in events | M0 |

Closed: [#326](https://github.com/ngocbh/agent-composer/issues/326) (public cancel;
stopping is host-side by killing the worker) and
[#329](https://github.com/ngocbh/agent-composer/issues/329) (`NotebookMemory`;
superseded by #256).

Deferred: `system_prompt:` (#259), flow-as-tool, skills (#260), and
`backward(at=<occurrence>)` for feedback on one node.

Not needed: context propagation into pool workers, and a `context=` parameter, because
identity travels in the per-run tools. `backward()` on a persisted run and stacked
memory frames already exist.

## 9. Open questions

- **Self-notes**: should an employee record discoveries mid-run? Current lean: no. The
  profile changes through `backward()` only, world facts go to shared knowledge, and
  memory poisoning is a risk to guard against.
- **ACP** as the harness adapter protocol for Codex and Claude. The M1.5 spike decides.
- **Codex's programmatic interface and sandbox**: approvals, mid-turn input, resume,
  cost reporting, whether its sandbox can deny the office paths, and MCP access with
  network off (M1.5 spike).
- **Should grants absorb "the routine is the permission"?** For example, an
  `assets/queue-ngocbh.yaml` grant giving Ava `resolve_on_behalf`, instead of HQ
  checking that the routine exists.
- **Engine-side tool errors**: an unknown tool name or invalid arguments raise before the
  host tool runs (`tool_calling.py:151-155`, `tools/registry.py:136-143`) and fail the node.
  Chats restart, but SOPs fail. A #324 option could return these as tool results instead.
- **Per-node feedback**: if whole-run feedback that names a turn proves too coarse, add
  `backward(at=<occurrence>)` to composer.
- **`SessionMemory` write cost**: every write rewrites the whole session state
  (`memory/session.py:916-922`, `memory/storage.py:275-300`), so long live sessions cost
  O(n²). Measure during dogfooding. This may be settled by the memory unification work.
- **Worker start cost**: about a second per run. If that hurts, keep a small pool of
  warm workers.
- **Clusters**: compute nodes may lack outbound access. Confirm the login-node office
  pattern.

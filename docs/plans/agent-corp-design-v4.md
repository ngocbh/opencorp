# agent-corp design (v4)

- Date: 2026-09-28
- Status: final review round done ([review 2](agent-corp-design-review-2.md)); v4 applies
  its fixes plus the owner's follow-up decisions
- Previous versions: [v3](agent-corp-design-v3.md), [v2](agent-corp-design-v2.md)
  (after [review 1](agent-corp-design-review-1.md)), [v1](2026-09-27-agent-corp-design.md)
- Decision record: [issue #1](https://github.com/ngocbh/agent-corp/issues/1)
- Engine issues: agent-composer #324, #325, #327–#330 (open), #326 (closed, not needed),
  plus one new issue for streaming and usage (§8)

Paths are relative to `agent-composer/` unless they start with `packages/` (OpenCode,
`~/workspace/opencode/`) or name an agent-corp directory.

## Changes from v3

Review 2 found two critical issues (K1, K2) and nine important ones (I1–I9). The owner
decided the K1 fix directly. Where v4 and v3 disagree, v4 wins.

- **K1 (stopping vs feedback).** v3's Esc cancelled the whole run, which left it
  unfinished, so it could never take feedback. The owner simplified:
  - **Esc interrupts the current reply only.** The steerable agent node returns the text
    it has so far, and the chat loop continues. This is a small addition to #327.
  - **`/end` and the idle timeout** leave through the chat flow's own exit, so the run
    finishes normally and can take feedback.
  - **Stopping a whole run is agent-corp's job.** Each run executes in its own worker
    process, and the office kills that process. `resume_flow` continues it later
    (composer already survives a killed process: the log lock is `flock`,
    `runtime/log.py:843`, and resume repairs a partial last line, `run.py:479`).
  - Composer gets **no cancel API**: #326 is closed. Hard stop, "finalize", and
    feedback on unfinished runs were considered and dropped as too complicated.
  - A run that is killed and never resumed gets a debrief from the transcript but no
    feedback. That is accepted.
- **K2 (local trust boundary).** Every agent process runs in an OS sandbox, including
  composer's run workers. Workers cannot reach the office socket, database, secrets, logs,
  or repo clone. Privileged tools run inside the office, which is the reference monitor;
  workers call them over a per-run authenticated channel. The per-session MCP endpoint
  for external harnesses gets a per-session secret (§2, §3 "Permissions", "Gates").
- **I1 (git layout).** Pinned definitions come from read-only worktrees cached per commit.
  Notebooks are always written in the main working tree. One repo lock serializes
  appends, commits, pulls, and pushes. In M1 there is no remote, and changes the owner
  starts from `ac` count as approved (§3 "Distribution").
- **I2 (notebook op ids).** A snapshot is the set of op ids visible at open, not a line
  offset. Op ids are minted monotonically above the largest id seen. A malformed
  trailing line is ignored (§3, #329).
- **I3 (tool errors).** Wrappers return permission and constraint errors as tool
  results and never raise. If a chat run fails anyway, the office starts a new run in
  the same session, as `ac chat` does. A session therefore has a list of runs (§3, §5).
- **I4 (feedback preconditions).** Runs start with `learnable=True`. Each session's
  `SessionMemory` is a durable SQLite store kept as long as its run logs. Feedback on
  a live run is queued until the run finishes (§3).
- **I5 (streaming and usage).** New composer issue: AGENT token streaming through
  `on_stream`, observer events for in-loop model and tool calls, and per-call token
  usage. M1 needs all three (§8).
- **I6 (issue spec gaps).**
  - #324: the engine wraps the host's `ask_user` with the fixed schema, so only
    `question` is visible to the model. Hosts can turn off the global registry fallback.
  - #327: undelivered steers move to the next turn. Enter while the agent waits in a model
    `ask_user` answers that question.
  - The #326 gaps are moot now that it is closed.
- **I7 (one notebook, two frames).** agent-corp lint allows exactly one frame per run
  to declare `notebook`. #329 also specifies that only the outermost frame of an
  instance recalls and learns.
- **I8 (TUI fork scope).** The fork plan now budgets for vendoring or stubbing
  OpenCode's `core`, `plugin`, and `ui` packages and rewriting ~40 call sites. It keeps
  an SDK-shaped client to limit the rewrite (§2).
- **I9 (HQ push check, M2).** HQ accepts office pushes to main only if they append lines
  to `people/*/notebook.jsonl` and change nothing else (§3).
- **Suggestions adopted:**
  - toolbox names are namespaced by asset (`cluster_a__submit_job`);
  - learning retries only attempts that failed before committing;
  - `risk: gated` per tool in assets;
  - only human managers edit notebooks directly;
  - orphaned model `ask_user` questions are marked stale;
  - the chat loop has an explicit iteration limit, and reaching it ends the session
    normally;
  - #324's occurrence path is dropped if LOOP/MAP expanded node ids are already
    occurrence-unique. That gets verified in the PR.

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
   notebook manager. Flows bracket external harness sessions (Codex, Claude): a debrief
   runs after each one, and feedback applies to it.
4. **Company as code**: definitions and notebooks live in a git repo, and every change
   is a diff.
5. **Hard guarantees come from structure, not prompts**: sandboxed agent processes,
   gated composer SOPs, credentials held only by the office, and per-call permission
   checks.
6. **Cautious by default**. Autonomy grows through the owner's instructions and grants.
7. **Work items** are the only way people communicate, humans and agents alike.
8. **Server-first sessions**: the office owns sessions, and every UI is an equal client.
9. Data stays on the owner's machines. HQ holds metadata, summaries, and the canonical
   company repo. Transcripts and run logs stay on the office that produced them.

Non-goals for now: hosted multi-tenant SaaS, Windows offices, employees rewriting their
own flows mid-run, and real-money trading before gated SOPs exist.

## 2. Architecture

```
Terminal (ac)  ──unix socket──►  Office (per machine, Python)  ──►  run workers (sandboxed): composer runs
                                   │                           ──►  harness processes (sandboxed): codex | claude
                                   │ outbound WebSocket + git (M2)
                                   ▼
Browser/phone  ────────────────►  HQ (TypeScript)  ──relay──►  same office
```

| Component | Tech | Role |
|---|---|---|
| `ac` | TypeScript/Bun, one binary | CLI and TUI. From M2 it also contains the HQ server and embedded web UI |
| TUI (`packages/tui`) | Fork of OpenCode's TUI (OpenTUI + Solid) | person picker, chat, steer and interrupt, work-item context, notebook view, debrief and feedback |
| HQ (M2) | Hono, SSE, Drizzle + SQLite | registry, org, work items, session index, relay, pairing, canonical company repo (git over the tailnet) |
| Web UI (M2) | Solid.js with OpenCode `session-ui`/`ui` components | org, work items, sessions, live view, prompt and approve, Notebook tab |
| Office | Python daemon, installed by `ac onboard` via uv; runs under launchd/systemd | hosts employees and sessions; holds secrets, grants, and the repo; executes privileged tools; starts and kills run workers and harness processes |
| Run worker | Python process per composer run, sandboxed | runs one `run_flow`/`resume_flow` with composer in-process |
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
  - a notebook view with a notebook-manager chat;
  - debrief and feedback screens.
- The aim is OpenCode-level polish, so only change what our purpose needs.

### Protocol

- It keeps OpenCode's shapes: Session, Message, Part, Permission, and Question. A Part
  is text, file, or a stateful `ToolPart` (pending, running, completed, or error).
  Permission and Question are separate entities. We add our own entities: WorkItem,
  Comment, Person, Note, and Debrief.
- It is defined once, in JSON Schema, and generated into TypeScript and pydantic.
- It has two channels:
  - **Metadata events**: work items, comments, session status, summaries, and cost.
    These are durable, carry ULID event ids, go through an outbox, and replay
    idempotently.
  - **Live content**: messages, parts, and streams. These go only to subscribed clients.
    They are never sent through the outbox or stored at HQ. Clients fetch history from
    the office that owns the session.
- The worker forwards composer's `on_event` (observer events, including in-loop model
  and tool events) and `on_stream` (token chunks) to the office, which maps them onto
  Parts. Harness events are mapped the same way.

### Composer runs

- The office starts one **run worker** process per `run_flow` or `resume_flow`. The worker
  runs inside the sandbox (§3 "Gates") and talks to the office over a per-run
  authenticated channel. It exists only for as long as that run is active.
- The worker builds that run's tools and passes them with `tools=` (#324). Each tool is a
  small stub bound to `(person id, session, run)` that forwards the call to the office.
  The office checks the grant, executes, and returns the result.
  - The tools include `ask_user`, the company tools, and the person's permitted asset
    tools through the `toolbox` group (#325).
  - The worker also turns off the global tool registry fallback (#324), so only these
    tools exist in the run.
- The worker passes an inbox with `steering=` (#327). The inbox forwards steer messages
  and interrupts from the office.
- **Stopping a run**: the office kills the worker. Composer's log survives this: the lock
  is released by the OS, and `resume_flow` repairs a partial last line. Pause is
  "kill now, resume later". Composer has no cancel API, and nothing in the engine knows
  who is running.

### Networking and data (M2)

- HQ binds to loopback and is exposed with `tailscale serve`. Every client device must
  be on the tailnet. Alternatives (a VPS, Cloudflare Tunnel) are documented and opt-in.
- Offices connect **outbound**, so clusters need no inbound ports.
- **Pairing**: offices and client devices join with a token the owner approves. Each
  client gets its own key.
- **Data residency**:
  - HQ stores metadata, summaries, and cost. It also hosts the canonical company repo,
    which includes notebooks.
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
office/                # Python office daemon, run worker, permission layer, harness adapters
docs/plans/
```

## 3. Data model

### Company repo (one git repo per company)

```
company.yaml
people/<id>/person.yaml      # plus persona.md, main.yaml, sops/ for agents
people/<id>/notebook.jsonl   # notebook op log (agents; humans may have one too)
groups/<id>.yaml
assets/<id>.yaml             # things that can be used, with grants
shared/flows/                # chat.yaml, debrief.yaml, notebook_manager.yaml, triage.yaml
.gitattributes               # people/*/notebook.jsonl merge=union
```

**Identity**: people are identified the way users are in an OS:

- **`id`**: permanent and never reused, like a uid. Directories, references,
  permissions, notebooks, and logs all use it. It's minted at creation, as a ULID by
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
defaults: { provider_policy: default, cost_cap_usd: 5, idle_end: 2h }
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
persona: persona.md
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

Organizations grow by adding people. You can start flat, with everyone reporting to
the CEO, then add a CTO with reports, a CFO, or more assistants. The app filters by
**reporting subtree** ("everything under @kai") or by **group**.

### Distribution

- Each office keeps one clone of the company repo, owned by the office and outside every
  sandbox.
  - **Main working tree**: the notebook backend writes here.
  - **Pinned definitions**: a session or run reads definitions from a **read-only
    worktree** for its pinned commit, cached by commit. So relative flow references
    resolve, and the notebook files in the main tree never go back in time.
- **One repo lock** serializes notebook appends, commits, pulls (merges), and pushes.
- The office pulls on start, before each session, and when HQ sends `repo.updated` (M2).
- **Definition changes** (hiring, SOPs, grants):
  - M1: changes the owner starts from `ac`, such as "hire new…", show the diff and
    commit when the owner confirms.
  - M2: they are written on a branch, and the owner approves the diff to merge.
- **Notebook ops** are committed automatically; see "Notebook memory".
- **M1 has no remote.** From M2 the office pushes to HQ. HQ's pre-receive check accepts
  office pushes to main only if they append lines to `people/*/notebook.jsonl` and change
  nothing else.
- Which folders belong to which person is machine-specific, so it lives in the office
  store, not the repo.
- Schema validation and lint run in Python, in pre-merge CI and in the office on load.
  HQ trusts the office's lint result.

### Permissions

The office is an OS-style reference monitor, and it's the only process holding
credentials:

- **Subjects** are people, identified by `id`. Groups are how grants are shared.
- **Objects** are assets (`assets/*.yaml`) and people's notebooks.
- **Grants** list who can do what. `can` names tools or `admin`, and an optional
  `where` constrains the tool's arguments.
- **Enforcement**:
  - At run start, the office tells the worker which tools the person holds grants for.
  - The worker exposes them through the `toolbox` group (#325), with names namespaced by
    asset (`cluster_a__submit_job`, within `[a-zA-Z0-9_-]{1,64}`).
  - Every call goes to the office, which:
    1. re-checks the grant against the repo state it currently has, including the
       arguments;
    2. executes the tool with credentials from its secret store;
    3. records an audit entry: person, run, tool, arguments, and result;
    4. returns the result, or a **denial or error as a tool result**, never as an
       exception. The model sees "permission denied: …" and the run continues.

  The model and the worker never see credentials. A tool the person has no grant for
  doesn't exist in their run.
- **Changes**: revoking a grant takes effect on the next call. A new grant on a tool the
  run already has also works immediately. A tool that wasn't in the run's toolbox
  appears in the next run.
- **Company tools** every person has: `ask_manager`, `create_work_item`, `comment`, and
  `ask_user`. Each is bound to the caller's id.
- **Notebook access**: by default the person's **human** managers can read and edit
  their notebook directly, and the person can read it. Agents never edit notebooks
  directly (see "Who writes notes"). A grant file can change the defaults.
- **Owner-only operations** (approving diffs, editing grants, editing notebooks,
  answering on someone's behalf) go through the office socket. Only unsandboxed
  processes can reach it, so no agent can.

### Runtime entities and ownership

| Entity | Owner | Others hold |
|---|---|---|
| Person, Group, Asset, routines, **notebooks** | company repo (canonical copy at HQ from M2) | offices: clones |
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
  new run is added only when a failed or killed chat run is restarted.
- **PendingQuestion**: id, session_id, run_id, node_id, payload, gate, answer,
  answered_by, status (`open` | `answered` | `consumed` | `stale`). A question from a
  model `ask_user` call becomes `stale` if its agent node re-runs after a restart.
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
  - The loop sets an explicit `max`. Reaching it ends the session normally.
  - Conversation continuity comes from `long_term_memory: session`, with one **durable**
    `SessionMemory` (SQLite) per session. It's kept as long as the session's run logs,
    because resume and backward reopen it at its recorded snapshot.
  - The notebook comes from `long_term_memory: notebook` on the flow. agent-corp lint
    allows **exactly one frame per run** to declare `notebook`.
  - The main flow can evolve per role.
- **SOPs** are fixed flows for recurring work, later exposed as tools. Work evolves from
  improvising, to an SOP the owner approves as a diff, to improvements from feedback.
  An SOP called from a chat doesn't declare `notebook` itself; it inherits the chat's.
- **All runs start with `learnable=True`** (chat, SOP, debrief, triage, notebook manager),
  so any finished run can take feedback.
- **Notebook memory** (`NotebookMemory`, composer #329):
  - **Scope**: one notebook per instance, and agent-corp creates one instance per person.
    Only the outermost frame of an instance in a run recalls and learns. The frame ref
    is ignored, so renaming flows orphans nothing.
  - **Storage**: an append-only op log with one JSON op per line: `add`, `edit`, or
    `delete`. Each op has an op id, the note id, text, and provenance: author id, via
    (for example `backward on run 01J…` or `notebook manager`), the feedback source, and
    a timestamp. agent-corp uses the JSONL file backend at `people/<id>/notebook.jsonl`.
  - **Op ids** are ULIDs minted monotonically: `max(now, largest op id in the file + 1)`.
    So an edit always sorts after the note it edits, even with clock skew between
    offices.
  - **Folding**: ops are applied in op-id order, and duplicate op ids are ignored. An op
    on a deleted note has no effect. A malformed trailing line is ignored. Line order
    doesn't matter, which is what makes `merge=union` safe.
  - **Snapshots**: the snapshot a run records is the set of op ids visible when it
    opened, not a line offset. Resume and backward rebuild it by filtering.
  - **Writes from a stale snapshot are valid**. They just append ops.
  - **Compaction** happens at recall time into a derived cache. It isn't a write, and
    raw ops are kept.
  - **Host methods**: `render`, `list`, `add`, `edit`, and `delete`, for use outside a
    run. Learner material is bounded.
- **Who writes notes**:
  - **Agents' notes come only from `backward()`.**
  - **Humans may edit directly**, subject to notebook access. That can be by hand or
    through the notebook manager.
- **Recall**:
  - Composer runs recall through the memory frame when the run opens it, so a live chat
    sees the notebook as it was at session start. The next session picks up new notes
    and new tools.
  - External harnesses get `render()` output injected at session start.
- **Auto-commit**: every notebook write is committed automatically, under the repo lock
  and with no approval, for example
  `notebook(@minh): +1 note, from backward on run 01J… (ngocbh)`. From M2 the office then
  pushes; while offline, commits stay local and are pushed later.

### Learning and feedback

- **Feedback on a run** (a chat session, an SOP run, a debrief, or a reopened
  on-behalf-of decision) targets a **finished** run. Feedback on a live run is saved and
  queued until the run finishes. Then the office:
  1. starts a worker with the flow from the pinned read-only worktree, because
     `resume_flow` verifies the fingerprint (`docs/api.md:757`);
  2. calls `resume_flow` on the log, which reuses every finished node, so nothing
     re-runs;
  3. calls `result.backward(feedback)`. The notebook learner turns the feedback into
     `add`/`edit`/`delete` ops.

  #328 allows more than one backward attempt per run, so anyone with notebook access can
  add feedback to an old run later. Each attempt is recorded in the run log.
- **Feedback on one turn**: the feedback is text on the whole run that names the turn.
  The TUI pre-fills "About turn 3: …" when you pick a turn. The learner sees the whole
  run, so it can tell which turn you mean.
- **Where**: `ac feedback <session|run>` or the TUI debrief screen (M1), and the app (M2).
- **Retries**: a failed attempt is retried only if it failed before committing any ops.
  Otherwise the feedback shows `learning failed` for a human to look at.
- **Feedback not tied to a run**: open the person's notebook (the TUI notebook view in
  M1, the HQ web Notebook tab in M2). There you can list, add, edit, and delete rows,
  and the history is kept.
- **Notebook manager** (`shared/flows/notebook_manager.yaml`):
  - It's a built-in forward flow, not a person in the org chart.
  - You chat with it from the notebook view: "merge the duplicate Python notes",
    "rewrite these as rules".
  - It gets read access plus `propose_edits` for that notebook through the toolbox. It
    returns a diff, and you click Apply. Applied ops are labelled `ngocbh via notebook
    manager`.
  - It only runs when a human asks, so its changes count as that human's direct edits.

### Gates and sandboxing

Decision 7 = A: external harnesses are fenced rather than forbidden. Review 2 (K2)
extended the fence to composer's own workers.

- **Trust boundary**: anything running as the owner's OS user without a sandbox is
  trusted. That's the office, `ac`, and the owner's shell. Every **agent process** runs
  inside an OS sandbox: composer run workers, Codex, and Claude (macOS Seatbelt, Linux
  bubblewrap/Landlock).
  - The sandbox allows the session's workspace (write), the worker's own run directory,
    and the network only when a grant allows it.
  - It denies the office socket, the office store, secrets, run logs, `SessionMemory`
    files, and the repo clone.
- **Channels into the office**:
  - A worker reaches the office only through its per-run channel.
  - Codex and Claude reach company tools only through the per-session MCP endpoint.
  - Both are authenticated with a secret that is created for that run or session and
    handed to the process at start. Each secret is valid only for its own person and
    run.
- **Credential isolation**: secrets live in the office secret store, and only the office
  uses them, inside tool execution. Agent processes get a scrubbed environment.
- **Flow-structure guarantees cover composer SOPs.**
  - Tools marked `risk: gated` can be reached only through SOPs marked `gate: true`,
    which contain authored approval nodes (`case` + `human_input`).
  - Lint rejects definitions that break this, and rejects `ask_user` inside gate SOPs.
  - Codex and Claude can *call* a gated SOP as a company tool, but the gate still applies.
- **Per-person harness policy**: `harness_policy` sets the sandbox (workspace writes,
  network by grant) for every agent process of that person. Codex's and Claude's own
  tool approvals are ordinary permissions, not gates.
- **Authored-only answers**: a question counts as a gate only if it comes from a gate
  SOP's `human_input`. The engine hides trusted `ask_user` fields from the model (#324),
  so a model `ask_user` call can never pose as one.
- **Paired-device approval**: a gate answer is accepted only from a paired client device
  with its own login, such as the web app on a phone. The local socket is not enough on
  its own, as defense in depth. Terminal approval may come later, with a passphrase that
  isn't stored or with Touch ID.
- **Consequence**: gated SOPs need M2 (pairing). M1 has no gated SOPs, but it already has
  the sandbox and the office-side tool execution.

## 4. Sessions

### Starting (M1, local)

1. **Start**: run `ac` (composer harness) or `ac codex` (M1.5) in `~/workspace/longhstu`.
   The picker lists people associated with the folder first, then recent people, then
   "hire new…". The owner picks @minh.
2. **Register**: the office creates a WorkItem (assignee Minh, requester the owner) and a
   Session with ULIDs. The session runs on the **office where the folder lives**: the
   identity travels, and the work stays next to the code.
3. **Boot**: the office pins the repo commit and starts a sandboxed worker running the
   main flow as **one live run**. For Codex it starts the adapter instead, with the
   persona and the rendered notebook injected, under his `harness_policy`.
4. **Connect**: `ac` talks to the local office directly over a unix socket. It never
   goes through HQ. Browsers and phones (M2) reach the office through HQ's relay. The
   office owns the session.

### Keys (composer chat)

| Input | Employee idle (waiting for your message) | Employee busy (replying or using tools) |
|---|---|---|
| Enter | New turn | **Steer**: the message goes to the run's inbox (#327) and is added at the top of the next tool-loop iteration. If the reply finishes before the message is delivered, it becomes your next turn. If the agent is waiting on a model `ask_user`, Enter answers that question |
| Esc | — | **Interrupt**: the reply stops at the next safe point and returns the text it has so far (#327). The chat continues and waits for your next message. The TUI stops showing the stream immediately |
| Ctrl+C twice | Leave the view. The session keeps running on the office | — |
| `/end` | End the session through the flow's exit, then debrief | Interrupt first, then end |

- Other clients (M2) see the same session and can use the same controls.
- For a tool-approval request, the first answer from any connected client wins.
- SOP and task runs don't take steering. The office can **stop** them by killing their
  worker, and **pause** them by killing now and resuming later with `resume_flow`.

### Waiting for answers

- A `human_input` (a new chat turn, an SOP question, or a gate) waits in the live worker
  until someone answers.
- The office stores each question as a PendingQuestion before showing it, keyed by
  `(run_id, node_id)`. LOOP and MAP occurrences already have unique expanded node ids.
- If the node re-runs after a restart, `ask_user` finds the key. It returns the stored
  answer if there is one; otherwise it shows the same item again. The question is never
  duplicated.

### Ending

1. The session ends with `/end`, with `ac end`, after the idle timeout (`idle_end`), or
   when the loop reaches its `max`. In each case the office answers the waiting
   `human_input` with the flow's exit command (interrupting a busy reply first), so the
   run **finishes normally**. Closing the terminal doesn't end the session.
2. The office runs `shared/flows/debrief.yaml`. It outputs `summary`, `status`,
   `artifacts`, `decisions[]`, `follow_ups[]` (the owner confirms these),
   `open_questions[]`, and `cost`. Summary and cost are metadata, which HQ stores from M2.
3. Queued feedback is applied, and later feedback goes through `backward()` on the
   finished run (§3). The next session, in any harness, renders the updated notebook.

### Harness adapters

- **Interface**: `start(persona, notebook, cwd, tools_endpoint, policy)`, `send(prompt)`,
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
  - Notebook commits stay local and are pushed later.
  - Web access is unavailable meanwhile.
- **Office offline**: HQ marks it offline after missed heartbeats. Its sessions show as
  offline and their content is unavailable. New work for people homed there waits at
  HQ. There is no failover.
- **Office or worker restart mid-run**: the office starts a new worker and calls
  `resume_flow` from the log.
  - Finished nodes are reused.
  - An unfinished `human_input` re-shows its stored question or returns the stored
    answer.
  - An unfinished agent node re-runs, which may repeat model calls and tool effects. That
    is accepted and documented. Its orphaned model `ask_user` questions become `stale`.
  - Codex and Claude sessions resume through their own session ids where supported.
    Otherwise the session becomes `interrupted`, and the debrief runs on what exists.
- **Chat run fails** (for example, the tool-iteration cap or a model error): the office
  starts a new chat run in the same session, as `ac chat` does
  (`cli/chat/command.py:5-13`). `SessionMemory` carries the conversation. The failed run
  is finished (failed), so it can still take text feedback. Tool permission errors don't
  cause this, because they come back as tool results.
- **Killed and never resumed**: the debrief runs on the transcript. The run can't take
  feedback. That is accepted.
- **Runaway cost**: every session and routine has a cost cap, from the person's policy or
  the company default. Usage comes from composer's per-call usage events (§8) and a
  per-model price table.
  - In a chat, hitting the cap interrupts the reply, like Esc, and creates a work item
    for the manager.
  - In an SOP or task run, it kills the worker (a pause) and creates the same work item.
    Raising the cap resumes the run.
- **Definition changes**: runs pin their repo commit. Resuming a run, or running feedback
  on it, loads the flow from that commit's read-only worktree. Invalid definitions are
  rejected before merge.
- **Notebook merge**: union merge, monotonic op ids, and op-id-set snapshots mean
  concurrent writes never conflict. A push that loses a race pulls and retries under the
  repo lock.
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
  - #324: two concurrent runs with different `tools=` and `ask_user` never cross; the
    model schema of `ask_user` shows only `question`; and with the fallback off, a
    globally registered tool is absent.
  - #327: steer messages land only at the top of the tool loop and are recorded in
    `new_messages`. An interrupt returns partial text and marks the node interrupted, and
    the loop continues. An interrupt aimed at a finished node is ignored.
  - #328: a second `backward()` succeeds, and both attempts are in the log.
  - #329: op folding, dedup, monotonic ids under a skewed clock, op-id-set snapshots,
    stale writes, a malformed trailing line, compaction, the JSONL backend, and two
    union-merged files folding to the same result.
  - Streaming and usage: token chunks arrive through `on_stream`, in-loop events arrive
    in order, and usage totals match the stub.
  - Kill safety: kill a process mid-run, then `resume_flow` succeeds.
- **Office (pytest)**:
  - **Permissions**: a tool without a grant is absent. A `where` violation comes back as
    a tool result. A revocation applies on the next call. Credentials never appear in
    worker memory or model-visible text. The audit log is complete.
  - **Sandbox**: from inside a worker and a fake harness, the office socket, store,
    secrets, run logs, and repo clone can't be reached. A channel secret from another
    run is rejected.
  - **Chat run**: new turn, steer, and a steer that arrives late becomes the next turn.
    Interrupt, then the next turn sees the prior conversation. Restart while idle
    re-shows the same question without duplicating it. A failed run is restarted in the
    same session.
  - **Learning**: `/end` → the run is finished → feedback → `resume_flow` → `backward` →
    notebook op with provenance → auto-commit → `render()` in the next session. A second
    feedback on the same run also works. Feedback on a live run is queued. A
    notebook-manager Apply writes ops labelled "via notebook manager".
  - **Git**: pinned worktrees stay unchanged while notebooks are appended, and the repo
    lock serializes concurrent writers.
  - **Triage**: a resolution on someone's behalf is rejected unless the routine exists,
    and gate items are rejected outright.
  - **Flows** (chat, debrief, notebook manager, triage) run against a scripted LLM stub.
- **Gates**: a model `ask_user` can't answer a gate; a gate answer arriving over the
  local socket alone is rejected; and harness environments contain no secrets.
- **TUI (`bun test`)**: frame snapshots for the picker, chat, steer, interrupt, notebook
  view, and debrief, run against a fake office.
- **End-to-end (M1)**: one command starts an office, then scripts this journey:
  1. `ac` → pick @minh → prompt;
  2. steer mid-reply, then Esc and prompt again;
  3. `/end` → debrief → `ac feedback`;
  4. the next session renders the note, and a notebook commit exists.

  M1.5 adds a fake Codex harness. M2 adds HQ and a web client.
- **Failure tests**:
  - kill a worker mid-run and resume;
  - kill HQ and check the outbox replays without duplicates;
  - two offices append to one notebook and merge cleanly;
  - two clients answer one question, and the first answer wins.
- **Outside CI**: opt-in live smoke tests with real models, Codex, and Claude, plus a
  small manual eval that feedback actually changes the next session's behavior.

## 7. Build order

**M0: composer prerequisites** (issues in agent-composer, one PR each):
[#324](https://github.com/ngocbh/agent-composer/issues/324) per-run `tools=` with
`ask_user`, [#328](https://github.com/ngocbh/agent-composer/issues/328) multiple
`backward()`, [#329](https://github.com/ngocbh/agent-composer/issues/329)
`NotebookMemory` with the JSONL backend,
[#330](https://github.com/ngocbh/agent-composer/issues/330) CLI rename, and the new
streaming and usage issue. [#325](https://github.com/ngocbh/agent-composer/issues/325)
(toolbox) and [#327](https://github.com/ngocbh/agent-composer/issues/327) (steer and
interrupt) can land during M1.

**M1: a local employee who learns** (no HQ):

1. **Protocol and company repo**: the JSON Schema protocol, generated into TS and
   pydantic; a repo loader covering people, groups, and assets; schema validation and
   lint; pinned worktrees and the repo lock.
2. **Office**:
   - the daemon, the unix socket, and a SQLite store (work items, sessions, pending
     questions, queued feedback, outbox);
   - the run worker, the sandbox (Seatbelt on macOS first), and the per-run channel;
   - the permission layer and office-side tool execution;
   - the composer chat harness as a live run, with steer and interrupt;
   - the notebook with auto-commit, the debrief, feedback via `backward()`, and the
     notebook manager;
   - `ac onboard`, which installs the daemon under launchd/systemd, falling back to a
     tmux or login-shell process where user daemons aren't allowed.
3. **TUI fork**:
   - an inventory of OpenCode's `core`, `plugin`, and `ui` dependencies;
   - strip the unneeded features;
   - an SDK-shaped protocol client;
   - then the picker, chat, steer and Esc, the notebook view, and the debrief and
     feedback screens.
4. **E2E suite, then dogfooding** with Minh on real repos.

*Milestone: chat with Minh in `ac`, steer and interrupt him, give feedback, and see his
next session change.*

**M1.5: Codex.** Start with a spike on the Codex programmatic interface: instruction
injection, approvals, resume, MCP tools, token usage, mid-turn input, and whether its
sandbox can deny reads of the office paths and the socket. Then build the adapter, the
authenticated office MCP endpoint, and `harness_policy`.
*Milestone: `ac codex` with Minh, with the notebook shared across both harnesses.*

**M2: from anywhere.** HQ (pairing, org, work-item and session API, WebSocket relay,
outbox sync, the canonical company repo over git with the pre-receive check); the web UI
(org, work items and sessions filtered by subtree or group, live view, prompt and
approve, Notebook tab); paired-device gate approvals; definition changes on branches.
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
| [#324](https://github.com/ngocbh/agent-composer/issues/324) | Per-run `tools=` on `run_flow`/`resume_flow`, including `ask_user`. Removes the process-wide `install_ask_user` (`tools/registry.py:168-205`). **Adds:** the engine wraps the host's `ask_user` in the fixed schema, so only `question` is visible to the model and trusted fields stay injected. An option turns off the global `TOOL_REGISTRY` fallback. The type of `tools` allows groups (#325). Drop the extra occurrence path if expanded node ids are already occurrence-unique (`nodes/ids.py:4-12`) | M0 |
| [#325](https://github.com/ngocbh/agent-composer/issues/325) | Host-supplied tool groups: `tools: [toolbox]`, filled per run. Groups are expanded before the grant check (`tool_calling.py:151`) | M1 |
| [#327](https://github.com/ngocbh/agent-composer/issues/327) | Steer and interrupt through a host inbox. `drain(node_id)` returns steer messages at the top of the tool loop, into `messages` and `new_messages`. **Adds** `interrupted(node_id)`, checked at the loop's safe points: the node returns the text it has so far, and its finished record is marked `interrupted`. A model reply that arrives after the interrupt is dropped, and a running tool finishes. The saved conversation ends with an `[interrupted by the user]` note. `steerable: true` is valid only on `tool_calling` agents with `str` output | M1 |
| [#328](https://github.com/ngocbh/agent-composer/issues/328) | Multiple `backward()` attempts per run (today one, `runtime/backward.py:221-223`) | M0 |
| [#329](https://github.com/ngocbh/agent-composer/issues/329) | `NotebookMemory`: instance-scoped op log, provenance, recall-time compaction, host `render`/`list`/`add`/`edit`/`delete`, JSONL file backend. **Adds:** snapshots are op-id sets; op ids are minted monotonically; a malformed trailing line is ignored; only the outermost frame of an instance recalls and learns | M0 |
| [#330](https://github.com/ngocbh/agent-composer/issues/330) | Rename CLI `ac` → `composer` | M0 |
| new | AGENT token streaming through `on_stream` (no node streams today, `nodes/base.py:1005-1007`); observer events for in-loop model and tool calls; per-call token usage in events | M0 |

Closed: [#326](https://github.com/ngocbh/agent-composer/issues/326) (public cancel).
Stopping a run is host-side: kill the worker process, then `resume_flow`.

Deferred: `system_prompt:` (#259), flow-as-tool, skills (#260), and
`backward(at=<occurrence>)` for feedback on one node.

Not needed: context propagation into pool workers, and a `context=` parameter, because
identity travels in the per-run tools. `backward()` on a persisted run and stacked
memory frames already exist.

## 9. Open questions

- **Self-notes**: should an employee record discoveries mid-run? Current lean: no. Notes
  come from `backward()` only, world facts go to shared knowledge, and memory poisoning
  is a risk to guard against.
- **ACP** as the harness adapter protocol for Codex and Claude. The M1.5 spike decides.
- **Codex's programmatic interface and sandbox**: approvals, mid-turn input, resume,
  cost reporting, and whether its sandbox can deny the office paths (M1.5 spike).
- **Should grants absorb "the routine is the permission"?** For example, an
  `assets/queue-ngocbh.yaml` grant giving Ava `resolve_on_behalf`, instead of HQ
  checking that the routine exists.
- **Per-node feedback**: if whole-run feedback that names a turn proves too coarse, add
  `backward(at=<occurrence>)` to composer.
- **Worker start cost**: about a second per run. If that hurts, keep a small pool of
  warm workers.
- **Clusters**: compute nodes may lack outbound access. Confirm the login-node office
  pattern.

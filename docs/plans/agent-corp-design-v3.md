# agent-corp design (v3)

- Date: 2026-09-28
- Status: all owner decisions closed; awaiting review round 2 (final)
- Previous versions: [v2](agent-corp-design-v2.md) (after [review 1](agent-corp-design-review-1.md)),
  [v1](2026-09-27-agent-corp-design.md)
- Decision record: [issue #1](https://github.com/ngocbh/agent-corp/issues/1)
- Engine issues: agent-composer [#324](https://github.com/ngocbh/agent-composer/issues/324)–[#330](https://github.com/ngocbh/agent-composer/issues/330)

Paths are relative to `agent-composer/` unless they start with `packages/` (OpenCode,
`~/workspace/opencode/`) or name an agent-corp directory.

## Changes from v2

v2 proposed seven decisions. The owner decided them as follows. Where v3 and v2
disagree, v3 wins.

| # | v2 proposal | Decision in v3 |
|---|---|---|
| 1 | M1 = local employee that learns, Codex first | **Accepted, with a new order.** M0 lands composer changes. M1 is local with the **composer chat harness first**. M1.5 adds Codex, M2 adds HQ and web, M3 adds Claude, routines, and triage (§7) |
| 2 | Unmodified OpenCode TUI over a shim | **Rejected.** Fork OpenCode's `packages/tui`, aim for its polish, remove what we don't need, and replace its data layer with our protocol (§2) |
| 3 | Composer feature list | **Replaced** by issues #324–#330. The host passes tools per run, so there is no `contextvars` binding and no context propagation (§8) |
| 4 | Composer main flow = one run per turn | **Rejected.** A chat session is **one live run** (a loop like `chat.yaml`), with steering and interrupt (§4) |
| 5 | One `learn.yaml` run per feedback event | **Rejected.** Feedback on a run calls `backward()` on that run's log, with multiple attempts allowed (#328). Feedback not tied to a run goes through direct notebook editing and the notebook manager (§3) |
| 6 | Notebook on the person's home office | **Rejected.** Notebooks live in the **company repo** as append-only JSONL op logs (§3) |
| 7 | Hard guarantees scoped to composer SOPs | **Accepted.** External harnesses are fenced: credentials stay only in gated composer SOP tools, each person has a sandbox and approval policy, and gate approvals come only from a paired device (§3 "Gates") |

New since v2, from the same discussion:

- **Identity**: every person has a permanent `id`, a unique, changeable `@handle`, and
  a display `name`.
- **No gatekeeper role.** A question to the CEO is a work item assigned to the CEO. The
  assistant triages that queue through a routine.
- **Permissions** follow an OS model. Assets carry grants, and per-run tool wrappers
  act as reference monitors: they check the grant on every call and hold the
  credentials. Composer knows nothing about identity.
- **Pending questions** are stored by the office. A re-run `human_input` either shows
  the same item again or returns the stored answer.
- **Notebook manager**: a built-in forward flow you chat with from a notebook view. It
  proposes edits, and the owner applies them.

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
5. **Hard guarantees come from structure, not prompts**: gated composer SOPs, credential
   isolation, and per-call permission checks.
6. **Cautious by default**. Autonomy grows through the owner's instructions and grants.
7. **Work items** are the only way people communicate, humans and agents alike.
8. **Server-first sessions**: the office owns sessions, and every UI is an equal client.
9. Data stays on the owner's machines. HQ holds metadata, summaries, and the canonical
   company repo. Transcripts and run logs stay on the office that produced them.

Non-goals for now: hosted multi-tenant SaaS, Windows offices, employees rewriting their
own flows mid-run, and real-money trading before gated SOPs exist.

## 2. Architecture

```
Terminal (ac)  ──unix socket──►  Office (per machine, Python)  ──►  harness: composer | codex | claude
                                   │ outbound WebSocket + git (M2)
                                   ▼
Browser/phone  ────────────────►  HQ (TypeScript)  ──relay──►  same office
```

| Component | Tech | Role |
|---|---|---|
| `ac` | TypeScript/Bun, one binary | CLI and TUI. From M2 it also contains the HQ server and embedded web UI |
| TUI (`packages/tui`) | Fork of OpenCode's TUI (OpenTUI + Solid) | person picker, chat, steering and interrupt, work-item context, notebook view, debrief and feedback |
| HQ (M2) | Hono, SSE, Drizzle + SQLite | registry, org, work items, session index, relay, pairing, canonical company repo (git over the tailnet) |
| Web UI (M2) | Solid.js with OpenCode `session-ui`/`ui` components | org, work items, sessions, live view, prompt and approve, Notebook tab |
| Office | Python daemon, installed by `ac onboard` via uv; runs under launchd/systemd | hosts employees and sessions, runs composer in-process, runs harness adapters, builds per-run tools |
| Engine | agent-composer (submodule, used as a library) | flows, memory, learning, run logs |

### TUI: forked from OpenCode

- Copy `packages/tui` into this repo at a recorded upstream commit, and keep the MIT
  notice. We don't sync with upstream; we cherry-pick fixes when they're worth it.
- **Replace** `context/sdk.tsx` and `sync.tsx` with a client for our protocol.
- **Remove**: LSP, MCP management, provider login and OAuth, git and workspace
  features, the formatter, and anything else our flows don't need.
- **Add**:
  - the person picker and "hire new…";
  - the work-item context header;
  - steering (Enter while busy) and interrupt (Esc);
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
- The office maps composer's `on_event` (observer events) and `on_stream` (token chunks)
  onto Parts. It maps harness events the same way.

### Composer in-process

For every `run_flow` or `resume_flow`, the office builds that run's tools and passes them
with `tools=` (#324). They include `ask_user` and the company tools, each a closure
bound to `(person id, session, run)`, plus the person's permitted asset tools through
the `toolbox` group (#325). The office passes the same closures when it resumes the run.
It stops a run with `cancel=` (#326) and steers it with `steering=` (#327). Composer has
no process-wide handler, and nothing in the engine knows who is running.

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
office/                # Python office daemon, permission layer, harness adapters
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
harness_policy: { sandbox: workspace-write, approval: on-request, network: false }
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
tools: [submit_job, read_logs, cancel_job]
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

**Distribution**: each office keeps a clone of the company repo.

- It pulls on start, before each session, and when HQ sends `repo.updated`.
- A session reads definitions at the commit it pinned.
- **Definition changes** (hiring, SOPs, grants) are written on a branch, and the owner
  approves the diff to merge.
- **Notebook ops** are committed automatically; see "Notebook memory".
- Which folders belong to which person is machine-specific, so it lives in the office
  store, not the repo.
- Schema validation and gate lint run in Python, in pre-merge CI and in the office on
  load. HQ trusts the office's lint result.

### Permissions

The office works like an OS reference monitor:

- **Subjects** are people, identified by `id`. Groups are how grants are shared.
- **Objects** are assets (`assets/*.yaml`) and people's notebooks.
- **Grants** list who can do what. `can` names tools or `admin`, and an optional
  `where` constrains the tool's arguments.
- **Enforcement**: for each run, the office builds a wrapper for every tool the person
  holds a grant for, and passes them through the `toolbox` group (#325). On every call
  the wrapper:
  1. re-checks the grant against the repo state the office currently has, including
     the arguments;
  2. injects credentials from the office secret store;
  3. records an audit entry: person, run, tool, arguments, and result.

  The model never sees credentials. A tool the person has no grant for doesn't exist
  in their run.
- **Changes**: revoking a grant takes effect on the next call, because every call checks
  it. A new grant on a tool the run already has also works immediately. A tool that
  wasn't in the run's toolbox appears in the next run.
- **Company tools** every person has: `ask_manager`, `create_work_item`, `comment`, and
  `ask_user`. Each is bound to the caller's id.
- **Notebook access**: by default a person's manager chain can read and edit their
  notebook, and the person can read it. An `assets/`-style grant file can change that.
- The number of wrappers grows with (people in active runs × their tools). They are
  cheap closures built at run start, not registered globally.

### Runtime entities and ownership

| Entity | Owner | Others hold |
|---|---|---|
| Person, Group, Asset, routines, **notebooks** | company repo (canonical copy at HQ from M2) | offices: clones |
| Office, pairing, client keys | HQ | office: its own credentials |
| WorkItem, Comment | HQ (office store before pairing or while HQ is unreachable) | offices: cache |
| Session (metadata) | office running it | HQ: index (status, summary, cost) |
| Message, Part, run logs, secrets | office running the session | nobody; live relay only |
| PendingQuestion | office running the run | HQ: metadata (a gate question is also a work item) |

Fields:

- **WorkItem**: id (ULID), title, kind (`task` | `question`), status, assignee,
  requester, parent_id, groups, `gate` (bool), resolved_by, on_behalf_of, summary, cost,
  version, timestamps.
- **Comment**: id, work_item_id, author, body, on_behalf_of.
- **Session**: id, person, harness, harness_session_id, office, work_item_id, cwd,
  repo_commit, run_id (composer), status, cost, timestamps.
- **PendingQuestion**: id, session_id, run_id, key, payload, gate, answer, answered_by,
  consumed. The key is the `human_input` occurrence path from #324. A model `ask_user`
  call has no occurrence path, so it gets a fresh key.
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
  (`src/agent_composer/cli/chat/chat.yaml`). `human_input` asks for the next message,
  and a tool-calling agent replies with the person's toolbox. The reply agent is
  `steerable: true` (#327).
  - Conversation continuity comes from `long_term_memory: session`, with one
    `SessionMemory` per session.
  - The notebook comes from `long_term_memory: notebook` on the flow. Flow-level and
    agent-level frames stack.
  - The main flow can evolve per role.
- **SOPs** are fixed flows for recurring work, later exposed as tools. Work evolves from
  improvising, to an SOP the owner approves as a diff, to improvements from feedback.
- **Notebook memory** (`NotebookMemory`, composer #329):
  - **Scope**: one notebook per instance, and agent-corp creates one instance per person.
    Every frame that declares `notebook` recalls the whole notebook. The frame ref is
    ignored, so renaming flows orphans nothing.
  - **Storage**: an append-only op log with one JSON op per line: `add`, `edit`, or
    `delete`. Each op has an op id (ULID), the note id, text, and provenance: author id,
    via (for example `backward on run 01J…` or `notebook manager`), the feedback source,
    and a timestamp. agent-corp uses the JSONL file backend at
    `people/<id>/notebook.jsonl`.
  - **Folding**: ops are applied in op-id order, and duplicate op ids are ignored. An
    op on a deleted note is kept but has no effect. Line order therefore doesn't
    matter, which is what makes `merge=union` safe.
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
- **Auto-commit**: every notebook write is committed automatically, with no approval, for
  example `notebook(@minh): +1 note, from backward on run 01J… (ngocbh)`. The office
  then pushes; while offline, commits stay local and are pushed later. Union merge
  resolves concurrent appends from different offices.

### Learning and feedback

- **Feedback on a run** (a chat session, an SOP run, a debrief, or a reopened
  on-behalf-of decision):
  1. The office that holds the run log checks out the flow at the run's pinned
     `repo_commit`, because `resume_flow` verifies the fingerprint (`docs/api.md:757`).
  2. It calls `resume_flow` on the log. Finished nodes are reused, so nothing re-runs.
  3. It calls `result.backward(feedback)`. The notebook learner turns the feedback into
     `add`/`edit`/`delete` ops.

  #328 allows more than one backward attempt per run, so anyone with notebook access
  can add feedback to an old run later. Each attempt is recorded in the run log. From
  `ac feedback <run>` (M1) or the app (M2).
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

### Gates

Decision 7 = A: external harnesses are fenced rather than forbidden.

- **Flow-structure guarantees cover composer SOPs.** Dangerous tools can be reached only
  through SOPs marked `gate: true`, which contain authored approval nodes (`case` +
  `human_input`). Lint rejects definitions that break this, and rejects `ask_user` inside
  gate SOPs.
- **Credential isolation**: secrets for risky APIs live in the office secret store, and
  only the tool wrappers inside gated SOPs can read them. Codex and Claude processes get
  a scrubbed environment and no access to the secret store. They can *call* a gated SOP
  as a company tool, but the gate still applies.
- **Per-person harness policy**: Codex and Claude run under the person's
  `harness_policy`. By default they can write only inside the workspace, and network
  access requires a grant. Their tool approvals are ordinary permissions, not gates.
- **Authored-only answers**: a question counts as a gate only if it has an occurrence
  path from a gate SOP's `human_input`. A model `ask_user` call can never answer a gate.
- **Paired-device approval**: a gate answer is accepted only from a paired client device
  with its own login, such as the web app on a phone, and never through the office's
  local socket. Anything the owner's OS user can read is assumed readable by local
  agents. Terminal approval may come later, with a passphrase that isn't stored or with
  Touch ID.
- **Consequence**: gated SOPs need M2 (pairing). M1 has no gated SOPs.

## 4. Sessions

### Starting (M1, local)

1. **Start**: run `ac` (composer harness) or `ac codex` (M1.5) in `~/workspace/longhstu`.
   The picker lists people associated with the folder first, then recent people, then
   "hire new…". The owner picks @minh.
2. **Register**: the office creates a WorkItem (assignee Minh, requester the owner) and a
   Session with ULIDs. The session runs on the **office where the folder lives**: the
   identity travels, and the work stays next to the code.
3. **Boot**: the office pins the repo commit, builds Minh's per-run tools, and starts the
   main flow as **one live run**. For Codex it starts the adapter instead, with the
   persona and the rendered notebook injected, under his `harness_policy`. External
   harnesses reach the same tool wrappers through a per-session office MCP endpoint.
4. **Connect**: `ac` talks to the local office directly over a unix socket. It never
   goes through HQ. Browsers and phones (M2) reach the office through HQ's relay. The
   office owns the session.

### Keys and control (composer chat)

| Input | Employee idle (waiting at `human_input`) | Employee busy (replying or using tools) |
|---|---|---|
| Enter | New turn: answers the pending `human_input` | **Steer**: the message goes to the run's inbox (#327) and is added at the top of the next tool-loop iteration, never between tool results. If the current node isn't steerable, it's queued as the next turn |
| Esc (or Ctrl+C while busy) | — | **Interrupt**: cancel the run (#326) and immediately start a new chat run for the same session. `SessionMemory` carries the conversation. The interrupted turn's visible output stays in the transcript |
| Ctrl+C twice while idle | Leave the view. The session keeps running on the office | — |
| `/end` | End the session, then debrief | — |

- Other clients (M2) see the same session and can use the same controls.
- For a tool-approval request, the first answer from any connected client wins.
- SOP and task runs don't take steering. They support cancel, and **pause**, which is
  cancel now and resume later (§5).

### Waiting for answers

- A `human_input` (a new chat turn, an SOP question, or a gate) blocks one worker thread
  in the live run until someone answers. That's cheap, but not free.
- The office stores each question as a PendingQuestion before showing it, keyed by
  `(run_id, occurrence path)`.
- If the node re-runs after a restart, `ask_user` finds the key. It returns the stored
  answer if there is one; otherwise it shows the same item again. The question is never
  duplicated.

### Ending

1. The session ends with an explicit `/end`, with `ac end`, or after the idle timeout
   (`idle_end`). Closing the terminal doesn't end it.
2. The office runs `shared/flows/debrief.yaml`. It outputs `summary`, `status`,
   `artifacts`, `decisions[]`, `follow_ups[]` (the owner confirms these),
   `open_questions[]`, and `cost`. Summary and cost are metadata, which HQ stores from M2.
3. Feedback on the session or its debrief goes through `backward()` on the matching run
   (§3). The next session, in any harness, renders the updated notebook.

### Harness adapters

- **Interface**: `start(persona, notebook, cwd, tools_endpoint, policy)`, `send(prompt)`,
  `steer(message)`, `events()`, `approve(request)`, `interrupt()`,
  `resume(harness_session_id)`, and `close()`.
- **Composer** is in-process. `steer` uses the inbox and `interrupt` uses `cancel=`.
- **Codex** (M1.5) and **Claude** (M3) are driven through their programmatic
  interfaces, not their TUIs. `steer` falls back to queueing where the harness has no
  mid-turn input.

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
- **Office restart mid-session**: each live run is resumed with `resume_flow` from its
  log, with the same per-run tools rebuilt.
  - Finished nodes are reused.
  - An unfinished `human_input` re-shows its stored question or returns the stored
    answer.
  - An unfinished agent node re-runs, which may repeat model calls and tool effects. That
    is accepted and documented.
  - Codex and Claude sessions resume through their own session ids where supported.
    Otherwise the session becomes `interrupted`, and the debrief runs on what exists.
- **Pause**: cancel the run (#326), which marks the session `paused`. Resuming later uses
  `resume_flow`, so pause needs no engine feature beyond cancel and resume.
- **Runaway cost**: every session and routine has a cost cap, from the person's policy or
  the company default. Hitting it cancels the run, marks the session `stopped: cost cap`,
  and creates a work item for the manager. To continue, raise the cap and resume. The
  office keeps a per-model price table for harnesses that report only tokens.
- **Definition changes**: runs pin their repo commit. Resuming a run, or running feedback
  on it, loads the flow at that commit. Invalid definitions are rejected before merge.
- **Notebook merge**: union merge plus op-id folding means concurrent writes never
  conflict. A push that loses a race pulls and retries.
- **Debrief or backward failure**: the session shows `debrief pending`, or the feedback
  shows `learning pending`, and it's retried. Transcripts and feedback are never deleted.
- **Revoked grant mid-run**: the next call to that tool fails with a permission error
  that the model sees.
- **Sync conflict**: HQ keeps its state, and the office's change becomes a comment.
- **Revoked pairing**: HQ drops the office. The office keeps its local data but stops
  syncing.

## 6. Testing

Each milestone's journey runs in CI with no API keys, using fakes at the edges.

- **Composer (in agent-composer)**: each issue ships its own tests.
  - #324: two concurrent runs with different `tools=` and `ask_user` never cross, and a
    re-run `human_input` passes the same occurrence path.
  - #326: cancel stops a run, and resume continues it.
  - #327: steering messages land only at the top of the tool loop, and they're recorded
    in `new_messages`.
  - #328: a second `backward()` succeeds, and both attempts are in the log.
  - #329: op folding, dedup, stale writes, compaction, and the JSONL backend. Two
    union-merged files must fold to the same result.
- **Office (pytest)**:
  - **Permissions**: a tool without a grant is absent; a `where` constraint rejects
    arguments that violate it; a revocation applies on the next call; credentials never
    appear in model-visible text; and the audit log is complete.
  - **Chat run**: new turn, steer, and queue-when-not-steerable. Interrupt, then the new
    run still sees the prior conversation. Restart while idle re-shows the same question
    and doesn't duplicate it.
  - **Learning**: feedback → `resume_flow` → `backward` → notebook op with provenance →
    auto-commit → `render()` in the next session. A second feedback on the same run
    also works. A notebook-manager Apply writes ops labelled "via notebook manager".
  - **Triage**: a resolution on someone's behalf is rejected unless the routine exists,
    and gate items are rejected outright.
  - **Flows** (chat, debrief, notebook manager, triage) run against a scripted LLM stub.
- **Gates**: a model `ask_user` can't answer a gate; an answer arriving over the local
  socket is rejected; and harness environments contain no secrets.
- **TUI (`bun test`)**: frame snapshots for the picker, chat, steering, interrupt,
  notebook view, and debrief, run against a fake office.
- **End-to-end (M1)**: one command starts an office, then scripts this journey:
  1. `ac` → pick @minh → prompt;
  2. steer mid-reply, then Esc and prompt again;
  3. `/end` → debrief → `ac feedback`;
  4. the next session renders the note, and a notebook commit exists.

  M1.5 adds a fake Codex harness. M2 adds HQ and a web client.
- **Failure tests**:
  - kill the office mid-run and resume;
  - kill HQ and check the outbox replays without duplicates;
  - two offices append to one notebook and merge cleanly;
  - two clients answer one question, and the first answer wins.
- **Outside CI**: opt-in live smoke tests with real models, Codex, and Claude, plus a
  small manual eval that feedback actually changes the next session's behavior.

## 7. Build order

**M0: composer prerequisites** (issues in agent-composer, one PR each):
[#324](https://github.com/ngocbh/agent-composer/issues/324) per-run `tools=` including
`ask_user`, [#326](https://github.com/ngocbh/agent-composer/issues/326) cancel token,
[#328](https://github.com/ngocbh/agent-composer/issues/328) multiple `backward()`,
[#329](https://github.com/ngocbh/agent-composer/issues/329) `NotebookMemory` with the
JSONL backend, and [#330](https://github.com/ngocbh/agent-composer/issues/330) CLI rename.
[#325](https://github.com/ngocbh/agent-composer/issues/325) (toolbox) and
[#327](https://github.com/ngocbh/agent-composer/issues/327) (steering) can land during M1.

**M1: a local employee who learns** (no HQ):

1. **Protocol and company repo**: the JSON Schema protocol, generated into TS and
   pydantic; a repo loader covering people, groups, and assets; schema validation and
   lint.
2. **Office**:
   - the daemon, the unix socket, and a SQLite store (work items, sessions, pending
     questions, outbox);
   - the permission layer and per-run tools;
   - the composer chat harness as a live run, with steer and interrupt;
   - the notebook with auto-commit, the debrief, feedback via `backward()`, and the
     notebook manager;
   - `ac onboard`, which installs the daemon under launchd/systemd, falling back to a
     tmux or login-shell process where user daemons aren't allowed.
3. **TUI fork**: strip the unneeded features, add our protocol client, then the picker,
   chat, steering and Esc, the notebook view, and the debrief and feedback screens.
4. **E2E suite, then dogfooding** with Minh on real repos.

*Milestone: chat with Minh in `ac`, steer and interrupt him, give feedback, and see his
next session change.*

**M1.5: Codex.** Start with a spike on the Codex programmatic interface: instruction
injection, approvals, resume, MCP tools, token usage, and mid-turn input. Then build
the adapter, the office MCP endpoint, and `harness_policy`.
*Milestone: `ac codex` with Minh, with the notebook shared across both harnesses.*

**M2: from anywhere.** HQ (pairing, org, work-item and session API, WebSocket relay,
outbox sync, the canonical company repo over git); the web UI (org, work items and
sessions filtered by subtree or group, live view, prompt and approve, Notebook tab);
paired-device gate approvals.
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
| [#324](https://github.com/ngocbh/agent-composer/issues/324) | Per-run `tools=` on `run_flow`/`resume_flow`, including `ask_user`. Removes the process-wide `install_ask_user` (`tools/registry.py:168-205`). `human_input` passes its occurrence path | M0 |
| [#325](https://github.com/ngocbh/agent-composer/issues/325) | Host-supplied tool groups: `tools: [toolbox]`, filled per run | M1 |
| [#326](https://github.com/ngocbh/agent-composer/issues/326) | Public cancel token (`cancel=`). Cancel plus resume doubles as pause | M0 |
| [#327](https://github.com/ngocbh/agent-composer/issues/327) | Steering: `steering=inbox`, `inbox.drain(node_id, occurrence)`, `steerable: true`. Messages are drained at the top of the tool loop into `messages` and `new_messages` | M1 |
| [#328](https://github.com/ngocbh/agent-composer/issues/328) | Multiple `backward()` attempts per run (today one, `runtime/backward.py:221-223`) | M0 |
| [#329](https://github.com/ngocbh/agent-composer/issues/329) | `NotebookMemory`: instance-scoped op log, provenance, recall-time compaction, host `render`/`list`/`add`/`edit`/`delete`, JSONL file backend | M0 |
| [#330](https://github.com/ngocbh/agent-composer/issues/330) | Rename CLI `ac` → `composer` | M0 |

Deferred: `system_prompt:` (#259), flow-as-tool, skills (#260).

No longer needed: context propagation into pool workers, because identity travels in the
per-run closures. No `context=` parameter is added either. `backward()` on a persisted
run and stacked memory frames already exist.

## 9. Open questions

- **Self-notes**: should an employee record discoveries mid-run? Current lean: no. Notes
  come from `backward()` only, world facts go to shared knowledge, and memory poisoning
  is a risk to guard against.
- **ACP** as the harness adapter protocol for Codex and Claude. The M1.5 spike decides.
- **Codex's programmatic interface**: approvals, mid-turn input, resume, and cost
  reporting (M1.5 spike).
- **Should grants absorb "the routine is the permission"?** For example, an
  `assets/queue-ngocbh.yaml` grant giving Ava `resolve_on_behalf`, instead of HQ
  checking that the routine exists.
- **Interrupted turns**: exactly what `SessionMemory` keeps from a cancelled reply agent,
  to be verified while building #326 and the chat harness.
- **Clusters**: compute nodes may lack outbound access. Confirm the login-node office
  pattern.

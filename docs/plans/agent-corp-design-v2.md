# agent-corp design (v2)

- Date: 2026-09-27
- Status: revised after [review 1](agent-corp-design-review-1.md); items in
  "Decisions needing owner confirmation" must be confirmed before implementation planning
- Previous version: [2026-09-27-agent-corp-design.md](2026-09-27-agent-corp-design.md)
- Decision record: [issue #1](https://github.com/ngocbh/agent-corp/issues/1)

## Changes from previous version

Every review claim was checked against the code. Paths below are relative to
`agent-composer/`, or to `~/workspace/opencode/` for `packages/...`.

- **C1 (waits and suspension).** Removed "waiting runs stay suspended on disk at no cost".
  Composer deleted pause and suspension on purpose (`docs/plans/2026-08-12-run-log-runtime-cleanup-design-v2.md:314-328`).
  `human_input` blocks a worker until the handler returns (`nodes/human_input/node.py:1-5,83-92`).
  After a restart, `resume_flow` retries unfinished nodes instead of resuming them (`docs/api.md:772-785`).
  The composer harness now runs **one run per chat turn**, so idle sessions hold no run.
  The office persists pending questions, and after a restart the broker returns the stored
  answer. "Suspend/pause" is dropped from the composer wishlist. Cost caps and redirects now
  **stop** work through a public cancel handle instead of pausing it. (§3, §4, §5, §8)
- **C2 (process-global broker, tool identity, stop).** Confirmed:
  - one `ask_user` owner per process, with no run id (`tools/registry.py:168-205`);
  - tools get only model arguments (`nodes/agent/modes/tool_calling.py:157`);
  - public `run_flow` hides its stop event (`run.py:315-329`); `ac chat` uses the private
    `_run_flow_controlled` (`cli/chat/command.py:45,221`).

  **Not re-adding** a per-run handler: composer's owner explicitly accepted a process-global
  handler (`docs/plans/2026-08-12-run-log-runtime-cleanup-design-v2.md:306`). The office
  instead installs one handler and binds session and run identity in `contextvars`. In serial
  mode (`num_workers=0`, the default) that already works, because nodes run on the caller's
  thread (`runtime/engine.py:139-141,164`). Two small generic composer features cover the
  rest: context propagation into pool workers (`runtime/engine.py:217` submits without
  `copy_context`) and a public cancel handle. (§2, §4, §8)
- **C3 (notebook contracts).** `NotebookMemory` is now specified with:
  - **instance scope**: one notebook per instance, one instance per person, and the frame ref
    is ignored;
  - **append-only commits** that are valid against a stale snapshot;
  - **one small learn run per feedback event**;
  - **one home office** per notebook;
  - a public **`render()`** for recall outside a run;
  - **recall-time compaction** into a derived cache, with bounded learner material.

  Harnesses now receive the rendered notebook as an input (including composer's main flow),
  so only the learn flow opens the notebook store. (§3, §4, §8)
- **C4 (hard gates).** The hard guarantee now covers only composer SOPs. Added:
  - credential isolation;
  - a per-person harness sandbox and approval policy;
  - authored-only gate answers (`node_id` present; model `ask_user` is rejected);
  - human-key authentication for gate answers.

  Principles 3 and 5 are narrowed to match. (§1, §3, §4)
- **C5 (source of truth and sync).** Replaced "the office's local record is the source of
  truth" with an ownership table per entity. IDs are ULIDs. The protocol now has two parts:
  outboxed metadata events, and live content that is only relayed and never outboxed or
  stored at HQ. Conflict rule: HQ wins, and a rejected office change is kept as a comment. (§2, §3, §5)
- **C6 (OpenCode reuse).** Confirmed:
  - the TUI is about 27k lines, calls about 51 distinct `sdk.client.*` endpoints, and
    consumes 19 event types;
  - `session-ui` and `ui` are DOM components;
  - OpenCode's Part, Permission, and Question model differs from ours.

  Proposed: adopt OpenCode's schema subset as the protocol, and run the unmodified TUI
  against an `ac`-side shim through its injected `fetch`/`events` hooks
  (`packages/tui/src/context/sdk.tsx:12-19`). A time-boxed spike comes first. **Needs owner
  confirmation.** (§2, §7)
- **C7 (M1 scope and prerequisites).**
  - Re-cut into M1, a local employee that learns; M2, "from anywhere" (HQ and web); and M3,
    the second harness and composer chat.
  - Prerequisites fixed: removed `backward()` on a persisted run, which exists
    (`docs/learning.md:204-223`); removed multiple policies per frame, since frames already
    stack (`docs/syntax.md:257-266`); deferred `system_prompt:`; added the C2 and C3 features.

  **Needs owner confirmation.** (§7, §8)
- **Suggestions adopted:**
  - lint runs in Python only, and HQ trusts it;
  - company-repo distribution and pinning;
  - an explicit session end plus an idle timeout;
  - one `SessionMemory` per session;
  - structured debrief fields as feedback targets;
  - a price table for Codex cost caps;
  - a cluster daemon fallback;
  - a Tailscale note for clients;
  - lint rejects `ask_user` in gate SOPs.
- **Suggestions not adopted:**
  - *Extend `ReflectiveMemory` instead of adding the notebook.* The owner decided on a new
    built-in, and Reflective differs on three defining properties: it is frame-keyed
    (`memory/reflective.py:270`), rejects stale revisions (`reflective.py:1174-1183`), and
    recalls a limited top-k.
  - *A single Python stack.* This is an owner decision; §9 revisits it after the spike.
- **Review claims found incorrect or overstated:**
  - C2: "a host cannot even work around this with a context variable". That is true only for
    `num_workers > 0`; serial runs execute on the caller's thread (`runtime/engine.py:139-141,164`).
  - C3(a): "conflicts with composer's memory contract". Frame-keyed state is how the built-in
    policies behave, not a protocol rule. `Memory.open_run` and `MemorySession.open_frame`
    let a host policy key state any way it likes (`memory/contracts.py:1587-1608`). It needs
    specifying, not an engine change.
  - C3(b): the check at `runtime/backward.py:237-238` only requires the reopened runtime to
    reproduce the *recorded* snapshot. Rejecting stale commits is a `ReflectiveMemory` policy
    choice (`reflective.py:1174-1183`), not an engine rule. The conclusion still holds.
  - Minor details: `_MAX_EPISODE_MATERIAL_CHARS` is at `reflective.py:53`, not `:50`, and the
    TUI also depends on `@opencode-ai/sdk` and `@opencode-ai/ui` (`packages/tui/package.json`).

## Decisions needing owner confirmation

1. **Milestone 1 scope and order** (§7)
   - *Original:* M1 = composer prerequisites, protocol, office, `ac`, HQ, web, both
     harnesses, learning, and E2E, with learning at step 7 of 8.
   - *Proposed:* M1 = a persistent employee that learns, **locally**: office, the Codex
     harness, notebook, debrief, `ac feedback`, and recall in the next session. M2 adds HQ,
     pairing, relay, and web. M3 adds the composer chat harness, Claude, and dogfooding.
   - *Why:* the differentiator lands first; M1 has no network surface, sync, or pairing; and
     the plan follows the headline journey (`ac codex`).
   - *If the original is kept:* keep the old order, but move "learning loop" to right after
     step 3 and treat HQ and web as M1b.
2. **OpenCode TUI reuse strategy and protocol** (§2)
   - *Original:* reuse OpenCode's TUI plus the `session-ui`/`ui` components over "our own
     small protocol shaped like OpenCode's".
   - *Proposed:* run the **unmodified** OpenCode TUI in `ac` against an in-process shim that
     implements the endpoint subset it needs and stubs the rest (lsp, mcp, vcs, provider
     OAuth). The shim is wired through the TUI's `fetch`/`events` injection
     (`packages/tui/src/context/sdk.tsx:12-19`). Adopt **OpenCode's own Session / Message /
     Part (stateful `ToolPart`) / Permission / Question schemas** as the protocol, generated
     from `packages/sdk/openapi.json`. `session-ui`/`ui` are used only by the web UI. ACP is
     not adopted as the client protocol; it stays open for harness adapters (§9).
   - *Why:* the design's Part union does not match OpenCode's model
     (`packages/sdk/js/src/gen/types.gen.ts:292-298,384-423`), and rewriting a 27k-line TUI's
     data layer means owning upstream churn.
   - *If the original is kept:* fork the TUI and rewrite `context/sdk.tsx` and `sync.tsx`
     against our protocol, or build a minimal OpenTUI picker and chat that borrows components.
     Both need the spike too.
3. **Required composer feature list** (§8)
   - *Original:* rename CLI; `NotebookMemory`; multiple policies per frame; `backward()` on a
     persisted run; `system_prompt:`; verify the broker; flow-as-tool; skills;
     suspend-on-request.
   - *Proposed:*
     - **Keep:** the rename and `NotebookMemory` (with an expanded spec).
     - **Add:** a public cancel handle; context propagation into pool workers.
     - **Remove:** multiple policies per frame (stacking already works); `backward()` on a
       persisted run (it exists); broker verification (replaced by the additions); suspend
       and pause (composer removed them deliberately).
     - **Defer:** `system_prompt:` past M1.
   - *Why:* see C1, C2, and C7 in "Changes".
   - *If the original is kept:* the removed items still add no capability. Multiple policies
     per frame would change frame identity, which is not a small feature.
4. **Composer main flow is one run per turn** (§3)
   - *Original:* the main flow is "the generalist loop (like composer's `chat.yaml`)", which
     is one long run.
   - *Proposed:* the main flow handles one turn. The office owns the session loop, and
     conversation continuity comes from a per-session `SessionMemory`.
   - *Why:* idle sessions hold no thread, run, or lock. Each turn sees fresh notebook recall.
     Restart retries at most one turn.
   - *If the original is kept:* long runs hold one blocked thread and an exclusive log lock
     per idle session, see a notebook frozen at session start, and re-ask the current
     question after a restart.
5. **Learning mechanism: one learn run per feedback event** (§3)
   - *Original:* feedback triggers `backward()` on the persisted debrief run.
   - *Proposed:* each feedback event (debrief feedback, a reopened item, an answered
     escalation) starts a fresh `shared/flows/learn.yaml` run with the notebook, followed
     immediately by `backward(feedback)`. The principle "written only via `backward()`" is
     unchanged.
   - *Why:* composer allows one backward per run (`runtime/backward.py:221-223`), and
     `resume_flow` needs the debrief loaded at the exact pinned commit (fingerprint,
     `docs/api.md:757`).
   - *If the original is kept:* only the first feedback on a session can learn. Later
     feedback needs batching, or is lost.
6. **Notebook home** (§3)
   - *Original:* "memory stays on the office where it was produced", which is ambiguous when
     one person works on several offices.
   - *Proposed:* each person's notebook lives on their `home_office`, the only process that
     opens it. Other offices get `render()` output through HQ at session start, and learn
     runs execute on the home office. Data residency is unchanged.
   - *Why:* this gives one notebook per person and a single SQLite owner (`docs/api.md:316-319`).
   - *Alternative:* store the notebook in the company repo (`people/<id>/notebook.md`). That
     makes notes reviewable diffs available on every office, but moves learned content into a
     repo that may have a remote, which changes residency.
7. **Scope of hard guarantees** (§1)
   - *Original:* principle 5, "hard guarantees come from flow structure", and principle 3,
     "everything an employee does is a flow".
   - *Proposed:* flow-structure guarantees cover composer SOPs only. External harnesses are
     bracketed by flows (debrief, learn) and constrained by credential isolation, a sandbox,
     and approval policy. Gate answers require a human key an agent process cannot read
     (§3 "Gates").
   - *Why:* a Codex session has its own shell and network (review C4).
   - *If the original is kept:* dangerous work must be forbidden in external harnesses
     entirely (no network, no secrets), which limits `ac codex`.

## 1. Overview and principles

agent-corp lets anyone build a **company of AI employees** that works for them and
evolves with them. It is the application layer; [agent-composer](https://github.com/ngocbh/agent-composer)
(vendored here as the `agent-composer/` submodule) is the engine. Both are ours: any
engine capability agent-corp needs becomes a **generic** agent-composer feature, never a
company-specific one.

Principles:

1. Simplicity, generality, flexibility, in both projects.
2. agent-corp uses only agent-composer's public API.
3. Everything an employee does **in composer** is a composer **flow** (turns, SOPs, debriefs,
   learning). External harness sessions (Codex, Claude) are bracketed by flows.
4. **Company as code**: definitions live in a git repo; changes are reviewable diffs.
5. **Hard guarantees come from flow structure** (gates in composer SOPs), backed by credential
   isolation, not prompts.
6. **Cautious by default**; autonomy grows through the owner's instructions.
7. **Work items** are the single communication primitive.
8. **Server-first sessions**: the office owns sessions; every UI is an equal client.
9. Data stays on the owner's machines; HQ keeps metadata and summaries only.

Non-goals for now: hosted multi-tenant SaaS, Windows offices, employees rewriting their
own flows mid-run, real-money trading before gated SOPs exist.

## 2. Architecture

```
Terminal (ac)  ──unix socket──►  Office (per machine, Python)  ──►  harness: codex | claude | composer
                                   │ outbound WebSocket (M2)
                                   ▼
Browser/phone  ────────────────►  HQ (TypeScript)  ──relay──►  same office
```

| Component | Tech | Role |
|---|---|---|
| `ac` binary | TypeScript/Bun | CLI + TUI + HQ server + embedded web UI in one binary |
| TUI | OpenCode's TUI (OpenTUI + Solid), unmodified, over an `ac`-side shim* | person picker, chat, live session view |
| HQ | Hono/Effect, SSE, Drizzle + SQLite (OpenCode server plumbing) | registry, org, work items, session index, relay |
| Web UI | Solid.js plus OpenCode `session-ui`/`ui` (DOM) components, served by HQ | org, work items, sessions, live view, prompt/approve |
| Office | Python, installed by `ac onboard` via uv; launchd/systemd | hosts employees, owns sessions, runs composer in-process and harness adapters |
| Engine | agent-composer (submodule, Python library) | flows, memory, learning, run logs |

\* Pending the spike and owner decision 2.

- **Protocol**: a subset of OpenCode's schemas: Session, Message, Part (text, file, and a
  stateful `ToolPart`), Permission, and Question as separate entities. It is generated from
  `packages/sdk/openapi.json` into TypeScript and pydantic. It has two channels:
  - **Metadata events**: work item, comment, session status, summary, cost. These are
    durable, carry a ULID event id, are outboxed, and replay idempotently.
  - **Live content**: messages, parts, streams. These go only to subscribed clients through
    the relay, and are never outboxed or stored at HQ. Clients fetch history on demand from
    the owning office.
- **TUI shim**: `ac` hands the TUI a `fetch`/`events` pair
  (`packages/tui/src/context/sdk.tsx:12-19`). Session and question endpoints map to office
  calls: create, list, get, messages, abort, status, `permission.reply`, `question.reply`,
  and `question.reject`. People map to OpenCode "agents". Unrelated endpoints (lsp, mcp,
  vcs, formatter, provider OAuth) return empty results.
- **Composer in-process**: the office installs one process-wide `ask_user` handler and binds
  `(person, session, run_id)` in `contextvars` around every `run_flow`/`resume_flow`. The
  broker and company tools read that binding. Serial runs already propagate it; pooled runs
  need composer feature "context propagation" (§8). Stopping uses the public cancel handle (§8).
- **Networking** (M2): HQ binds loopback and is exposed through `tailscale serve` by default
  (free). Every client device (phone, browser) must then be on the tailnet; onboarding says
  so. VPS, Cloudflare Tunnel, and ngrok are documented alternatives; public exposure is
  opt-in. Offices connect **outbound**, so clusters need no inbound ports.
- **Pairing**: offices and clients join with a token the owner approves. Each client gets
  its own key; see §3 "Gates" for human keys.
- **Data residency**: HQ stores metadata, summaries, and cost. Transcripts, run logs,
  memory (including notebooks), and secrets stay on the office where they live; the app
  fetches content on demand (unavailable while that office is offline). A per-person
  provider policy controls which LLM providers may see which data.
- **CLI naming**: agent-corp's CLI is `ac`; agent-composer's CLI is renamed `composer`.
  agent-corp uses composer as a library only.
- **Reference designs**: OpenClaw (gateway daemon, onboarding, pairing) and OpenCode
  (client/server sessions, TUI). We learn from both; we reuse OpenCode's TUI and schemas.

Proposed layout of this repo:

```
agent-composer/        # submodule; the office depends on it as a uv path dependency
packages/protocol/     # OpenCode schema subset + our extensions → TS types and pydantic
packages/ac/           # CLI + TUI shim + HQ + web (one Bun binary)
office/                # Python office daemon and harness adapters
docs/plans/
```

## 3. Data model

### Company repo (one git repo per company)

```
company.yaml
people/<id>/person.yaml   # + persona.md, main.yaml, sops/ for agents
groups/<id>.yaml          # departments, teams, cross-cutting groups
shared/flows/             # debrief.yaml, learn.yaml, triage.yaml, ...
```

The org chart is **people plus reporting lines**. No roles are hardcoded (no `assistant`
or `tech_manager` fields); an assistant or CTO is just a person you add.

```yaml
# company.yaml
name: ngocbh-corp
hq: https://hq.my-tailnet.ts.net
ceo: ngocbh                      # root of the org chart
defaults: { provider_policy: default, cost_cap_usd: 5, idle_end: 2h }
```

```yaml
# people/ngocbh/person.yaml (a human)
id: ngocbh
kind: human
title: CEO
manager: null
```

```yaml
# people/ava/person.yaml (an agent)
id: ava
kind: agent
name: Ava
title: Executive Assistant
manager: ngocbh
groups: []
persona: persona.md
home_office: laptop              # where the notebook lives and learn runs execute
main: main.yaml
sops: []                         # e.g. {flow: sops/trade.yaml, gate: true}
memory: [notebook, session]
harnesses: [composer]
harness_policy: { sandbox: workspace-write, approval: on-request, network: false }
workspaces: []
routines:
  - name: triage_ceo_queue
    trigger: { event: work_item.created, assignee: ngocbh }   # plus a periodic sweep
    flow: ../../shared/flows/triage.yaml
provider_policy: default
```

```yaml
# groups/research.yaml
id: research
name: Research
parent: null                     # groups may nest (department → team)
head: minh                       # optional
```

Structures grow by adding people: a flat start (everyone reports to the CEO), then a CTO
with reports, a CFO, more assistants. The app filters by **reporting subtree** ("everything
under Kai") or by **group**.

**Distribution**: each office keeps a clone of the company repo. It pulls on start, before
each session, and on HQ's `repo.updated` event. A session reads definitions at the commit
it pinned. "Hire new…" in the picker writes the person on a branch, and the owner approves
the diff to merge. Folder-to-person associations are machine-specific and live in the
office store, not the repo. Schema validation runs everywhere from JSON Schema. Gate lint
needs composer's Python compiler, so it runs in pre-merge CI and in the office on load. HQ
trusts the office's lint result and does not re-lint.

### Runtime entities and ownership

| Entity | Owner | Others hold |
|---|---|---|
| Person, Group, company, routines | company repo | HQ and offices: mirror at a commit |
| Office, pairing, client keys | HQ | office: its own credentials |
| WorkItem, Comment | HQ (office store before pairing or while HQ is unreachable) | offices: cache |
| Session (metadata) | office running it | HQ: index (status, summary, cost) |
| Message, Part, run logs, secrets | office running the session | nobody; live relay only |
| Notebook | person's `home_office` | nobody; `render()` output relayed on demand |
| PendingQuestion | office running the run | HQ: metadata (for gate items: a work item) |

- **WorkItem**: id (ULID), title, kind (`task` | `question`), status, assignee, requester,
  parent_id, groups, `gate` (bool), resolved_by, on_behalf_of, summary, cost, version, timestamps
- **Comment**: id, work_item_id, author, body, on_behalf_of
- **Session**: id, person, harness, harness_session_id, office, work_item_id, cwd,
  repo_commit, status, cost, timestamps
- **PendingQuestion**: id, session_id, run_id, node_id (null for model `ask_user`), payload,
  gate, answer, answered_by, consumed
- **RunRef**: office, run_id, work_item_id (pointer to a run log on an office)

**Sync**: IDs are ULIDs minted wherever an entity is created. An office that creates work
items offline (or before any HQ exists, as in M1) uploads them through the outbox. Updates
carry the version they were based on. On a version conflict, HQ keeps its state and attaches
the office's change as a comment. A human resolution at HQ always stands.

### Rules

- Humans are people with a work-item queue and no flows.
- Questions go up the `manager` chain; each manager decides from its goals and
  instructions or escalates further. A question "to the CEO" is a work item assigned to the CEO.
- **Queue triage**: the assistant's routine is the permission to act on the CEO's queue
  (it is in the repo, so the owner approved it; HQ checks the routine exists before
  accepting a resolution on someone's behalf). For each item the assistant either decides
  it (marked "on behalf of", citing the instruction relied on; reopening it becomes
  feedback) or leaves it assigned with a triage comment (summary, options,
  recommendation). It starts by forwarding everything.
- **Gate items** (`gate: true`) can only be resolved by a human key (see "Gates").
  Assistants may annotate them but not answer.
- The repo is authoritative for definitions; content streams through HQ without being stored.

### Employees and memory

- An employee is a persistent identity; its runtime is **on demand** (instantiated when a
  work item, comment, routine, or session arrives).
- **Main flow** (composer harness): handles **one turn**. Inputs are persona, rendered
  notebook, and message; the output is the reply. The office runs one `run_flow` per user
  message, so an idle session holds no run, thread, or log lock. Conversation continuity
  comes from `long_term_memory: session` on the reply agent, with **one `SessionMemory` per
  session**, because conversations are keyed by frame and leaf with no session id
  (`memory/contracts.py:1614-1636`). A turn may fail without ending the session; the next
  turn continues, as `ac chat` already does (`cli/chat/command.py:1-13`). The main flow can
  evolve per role. **SOPs** are fixed flows for recurring work, later exposed as tools.
  Evolution: improvise → codify into an SOP (owner approves the diff) → improve via feedback.
- **Waiting**: a `human_input` inside a turn (for example an SOP gate) blocks one worker
  thread until it is answered. This is cheap but not free. The broker persists every
  question as a PendingQuestion before it is shown. After an office restart, `resume_flow`
  retries the unfinished node (`docs/api.md:772-785`), and the broker matches
  `(run_id, node_id, payload)`: it returns a stored answer or re-shows the same pending
  question. Retried AGENT nodes may repeat model calls and tool effects; that is accepted
  and documented.
- **Notebook memory** (new composer built-in, `NotebookMemory`):
  - It is an accumulating list of notes, always fully in context. Later notes override
    earlier ones (a note may name the note it supersedes). Raw notes are kept.
  - **Scope is the instance**: every frame that declares `notebook` recalls the whole
    notebook, and its learner appends to it. The frame ref is ignored, so renaming flows or
    nodes orphans nothing. agent-corp creates one instance per person. The host chooses the
    scope by choosing the instance, just as it already chooses tenant identity (`docs/api.md:233-234`).
  - **Commits are append-only and commutative**. A commit from a run opened on an older
    snapshot is valid; deduplication uses `commit_id`. Feedback given days later still lands.
  - **Compaction** runs at recall or render time into a derived cache when notes exceed the
    budget. `SessionMemory`'s summary cache is the precedent (`docs/api.md:518-550`). It is
    not a write, so notes stay written **only via `backward()`**.
  - **`render()`** is a public host method returning the recall text for use outside a run.
  - **Learner material** is bounded, like Reflective's 20k-character episode cap
    (`memory/reflective.py:53`).
  - Each note records its provenance: owner, manager, or self, plus the feedback source and
    the learn run id.
- **Notebook recall**: the office calls `render()` at session start and before each composer
  turn. It passes the result as an input to every harness, so recall is uniform across
  Codex, Claude, and composer. Only `learn.yaml` declares `long_term_memory: notebook`, and
  it runs only on the person's `home_office`, the notebook store's single owner
  (`docs/api.md:316-319`). Sessions on other offices get the rendered notebook through HQ;
  if HQ is unreachable, they start without it and show a warning.
- **Learning**: each feedback event starts one fresh run of `shared/flows/learn.yaml` (inputs:
  subject, such as debrief output or a work item; feedback; source) with `learnable=True`,
  and immediately calls `backward(feedback)`. The notebook learner, not the subject's own
  agents, turns feedback into notes. One run per event respects composer's
  one-backward-per-run rule (`runtime/backward.py:221-223`). It also avoids reloading old
  debriefs at their pinned fingerprint.
- **Learning triggers live in agent-corp, not composer YAML**: feedback in the app,
  `ac feedback`, reopened on-behalf-of decisions, and answered escalations each start a
  learn run. Routines (trigger `every` | `cron` | `event`, flow, optional reviewer) may add
  more.

### Gates

- **Scope**: flow-structure guarantees apply to composer SOPs. Dangerous raw tools are
  reachable only through SOPs marked `gate: true` that contain authored approval nodes
  (`case` + `human_input`). Lint rejects definitions that break this, and rejects
  `ask_user` in gate SOPs.
- **Authored-only answers**: the broker treats a question as a gate only when it has a
  `node_id` from a gate SOP. Model `ask_user` calls cannot supply `node_id` (`docs/api.md:858-861`).
  Each gate question also becomes a gate work item.
- **Credential isolation**: dangerous-API secrets live in the office secret store. Only
  gate-SOP tool code inside the office process can read them. Harness processes get a
  scrubbed environment and no secret-store access.
- **External harnesses**: Codex and Claude run under the person's `harness_policy`
  (sandbox, approval mode, network). Their tool approvals are ordinary permissions, not gates.
- **Human keys**: gate answers require a key an agent process cannot read. Either confirm on
  a paired second device, such as a phone (the default), or use local `ac` with a key in the
  OS keychain behind user presence (Touch ID). The office socket gives agent harness
  processes no client key. Anything readable by the owner's OS user is assumed readable by
  local agents.

## 4. Session lifecycle (Milestone 1, local)

1. **Start**: `ac codex` in `~/workspace/longhstu`. The picker lists people associated
   with the folder, then recent ones, then "hire new…". The owner picks Minh.
2. **Register**: the office creates a WorkItem (assignee `minh`, requester `ngocbh`) and a
   Session (harness `codex`) with ULIDs. With HQ (M2), these are outboxed as metadata events.
   The session runs on the **office where the folder lives**; the identity travels, the work
   stays next to the code.
3. **Boot**: the office loads Minh's persona at the pinned commit and gets his rendered
   notebook (locally, or from his home office through HQ). It starts the harness adapter
   with both injected, under his `harness_policy`. Company tools (`ask_manager`,
   `create_work_item`, `comment`) are registered composer tools in the office. External
   harnesses reach them through a per-session office MCP endpoint, so the session supplies
   the caller's identity. Composer turns get identity from the context binding (§2).
4. **Chat**: `ac` talks to the local office directly over a unix socket. Browsers and phones
   (M2) reach the office through HQ's relay. The office owns the session, so closing the
   terminal only detaches.
5. **Permissions**: a tool-approval request appears in every connected client; the first
   answer wins. Gate items accept only human keys.
6. **End**: an explicit end (`/end` in any client, or `ac end`) or the idle timeout
   (`idle_end`). The office then runs `shared/flows/debrief.yaml`, which receives the
   notebook as input and outputs `summary`, `status`, `artifacts`, `decisions[]`,
   `follow_ups[]` (the owner confirms these), `open_questions[]`, and `cost`. The summary
   and cost are metadata; HQ stores them in M2.
7. **Learn**: owner feedback on the debrief, targeting the whole debrief or one field, via
   `ac feedback` (M1) or the app (M2), starts a learn run on the home office → notebook →
   rendered into the next session in any harness.

Harness adapter interface: `start(persona, notebook, cwd, tools_endpoint, policy)`,
`send(prompt)`, `events()`, `approve(request)`, `interrupt()`, `resume(harness_session_id)`,
`close()`. Codex and Claude are driven through their programmatic interfaces (Codex
app-server, Claude Agent SDK), not their TUIs. The composer harness runs one main-flow run
per turn. Its `human_input` nodes route to the chat through the broker, and `interrupt()`
uses the public cancel handle.

## 5. Failures and recovery

Each entity has one owner (§3 table), and that owner's record is authoritative. Offices
never ship content to HQ.

- **HQ unreachable**: local chat, routines, and blocked runs continue. Metadata events go to
  a SQLite outbox and replay on reconnect; event IDs make replay idempotent. Content is never
  outboxed. Web access and cross-office notebook recall are unavailable meanwhile.
- **Office offline**: HQ marks it offline after missed heartbeats; its sessions show as
  offline and content is unavailable. New work for people homed there waits at HQ. No
  failover.
- **Office restart mid-session**: a composer session starts its next turn normally. An
  interrupted turn is retried with `resume_flow`, and the broker returns stored answers
  (§3 "Waiting"). Codex and Claude adapters resume through the harness's own
  session or thread ID where supported. Otherwise the session becomes `interrupted` and the
  debrief runs on what exists.
- **Long waits**: a pending gate holds one blocked worker thread until it is answered. It
  survives restarts as a PendingQuestion plus retry. Nothing is suspended "at no cost".
- **Debrief or learn failure**: the session shows `debrief pending` (or the feedback shows
  `learning pending`) and retries with a fresh run; transcripts and feedback are never deleted.
- **Runaway cost**: each session and routine has a cost cap (person policy, company default).
  Hitting it **stops** the work (public cancel handle, or harness `interrupt()`), marks the
  session `stopped: cost cap`, and creates a work item for the manager. Continuing means
  raising the cap and sending a new turn. Codex reports tokens, so the office keeps a
  per-model price table; the Claude Agent SDK reports cost (unverified).
- **Definition changes**: sessions and runs pin the repo commit they started from; a
  retried run loads its flow at that commit, since `resume_flow` checks the fingerprint
  (`docs/api.md:757`). Invalid definitions (schema errors, gate lint) are rejected before merge.
- **Sync conflict**: HQ keeps its state, and the office's rejected change becomes a comment (§3).
- **Revoked pairing**: HQ drops the office; it keeps local data but stops syncing.

## 6. Testing

Each milestone's journey runs in CI with no API keys, using fakes at the edges.

- **Protocol contract**: shared golden fixtures (recorded event streams) replayed against
  the TypeScript shim and the Python office. A check confirms that outbox payloads never
  contain content parts.
- **Office (pytest)**:
  - flows (turn, debrief, learn, triage) against a scripted LLM stub;
  - harness adapters against recorded Codex and Claude transcripts, plus a fake harness
    (prompts, permissions, interrupts, crashes);
  - broker: questions from two concurrent sessions are routed correctly; a restart mid-wait
    returns the stored answer, and an unanswered question is re-shown once;
  - memory: feedback → learn run → notebook note with provenance → `render()` in the next
    session; a commit from a stale snapshot is accepted; two concurrent sessions of one
    person keep separate conversations.
- **Composer features (in agent-composer)**: company tools and the handler see the host
  context binding with `num_workers > 0`; the public cancel handle stops a run between
  nodes; `NotebookMemory` scope, commit, compaction, and `render()` contract tests.
- **Gates**: a model `ask_user` cannot answer a gate; an agent-side client without a human
  key is rejected; the harness environment contains no secrets.
- **HQ and `ac` (`bun test`)**: shim tests driving the real TUI against a fake office; TUI
  frame snapshots. M2: API tests with in-memory SQLite and a fake office over WebSocket.
- **End-to-end** (M1): one command starts an office and the fake harness, then scripts
  `ac codex` → pick Minh → prompt → approve → `/end` → debrief → `ac feedback` → the next
  session renders the note. M2 adds HQ and a web client.
- **Failures**:
  - kill HQ mid-session: the outbox replays with no duplicates;
  - restart the office: the turn retries with stored answers, and unresumable harness
    sessions become `interrupted`;
  - two clients answer the same question: the first wins;
  - a version conflict becomes a comment.
- **Company repo**: schema and gate lint as a pre-merge check (Python); offices run the same
  lint on load.
- **Outside CI**: opt-in live smoke tests with real Codex/Claude; a small manual eval that
  feedback actually changes the next session's behavior.

## 7. Build order

**Spikes first** (time-boxed, before step 2 freezes the protocol):

- OpenCode TUI running unmodified against a stub shim.
- Codex app-server: instruction injection, approvals, resume, MCP tools, token usage.

**Milestone 1, "a persistent employee that learns", local only:**

1. **agent-composer prerequisites** (one issue and PR each, in agent-composer):
   - rename the CLI to `composer`;
   - `NotebookMemory` (§3);
   - public cancel handle;
   - context propagation into pool workers.
2. **Protocol and company repo**: OpenCode schema subset → TS and pydantic; repo loader,
   schema validation, and lint.
3. **Office**:
   - daemon, unix socket, SQLite store (work items, sessions, pending questions, outbox);
   - broker and company tools (MCP endpoint);
   - Codex adapter, `debrief.yaml`, and `learn.yaml`;
   - `ac onboard` installs it via launchd/systemd, falling back to a tmux or login-shell
     process where user daemons are not allowed.
4. **`ac`**: picker and chat on the OpenCode TUI through the shim; `ac feedback`, `ac end`.
5. **E2E suite and dogfooding** with Minh on real repos.
   *Milestone: `ac codex` with Minh; feedback changes his next session.*

**Milestone 2, "from anywhere":** HQ (pairing, org, work-item and session API, WebSocket
relay, outbox sync); web UI (org, work items and sessions filtered by subtree or group, live
view, prompt and approve); cross-office notebook recall and learn routing; human keys on a
second device.
*Milestone: watch and prompt a laptop session from a phone.*

**Milestone 3:** composer harness (one-turn main flow, `SessionMemory` per session), Claude
adapter, TUI polish, dogfooding with 2–3 people (Minh, Ava).

Later phases:

1. **Autonomy**: routines (including Ava's queue triage), delegation between employees,
   escalation chains, cancel-and-redirect of a running turn.
2. **Growth**: HR hiring via repo diffs, SOP codification with gates, flow-as-tool, `system_prompt:`.
3. **Distribution**: offices on clusters, infra department, Obsidian knowledge base.
4. **High stakes**: finance with gated trading SOPs, cost department, messaging channels,
   OpenClaw integration.

## 8. Required agent-composer features

All are generic; none mentions companies, people, or offices.

- [ ] Rename CLI `ac` → `composer` (`pyproject.toml:54-55`)
- [ ] `NotebookMemory` built-in: instance-scoped notes, always fully recalled; append-only
      commits valid against stale snapshots; recall-time compaction cache; public `render()`
- [ ] Public cancel handle for `run_flow`/`resume_flow` (today only private
      `_run_flow_controlled` takes `stop_event`, `run.py:315-329`)
- [ ] Context propagation: node work in pool workers runs in a copy of the caller's
      `contextvars` context (today `runtime/engine.py:217` submits without it); documented
      as the way hosts give tools and `ask_user` their run identity
- [ ] `system_prompt:` (#259), later phase
- [ ] Flow-as-tool (phase 2)
- [ ] Skills (#260, later)

Removed from v1:

- **Multiple policies per frame**: flow-level `notebook` plus AGENT-level `session` already
  stack (`docs/syntax.md:257-266`).
- **`backward()` on a persisted run**: it exists (`docs/learning.md:204-223`).
- **Broker verification**: replaced by context propagation.
- **Suspend/pause**: composer removed these deliberately and they are not re-added.

## 9. Open questions

- Self-notes: should an employee record discoveries mid-run? Current lean: no mid-run tool
  in v1; capture via feedback and learn runs; route world facts to shared knowledge;
  mind memory poisoning.
- ACP as the harness adapter interface, for Codex and Claude behind `start`/`send`/...: to
  be decided by the Codex spike. It is not the client protocol, because the TUI speaks
  OpenCode's API.
- Two language stacks: revisit after the TUI spike. If the shim proves heavy, a Python HQ
  plus a static web UI may be simpler.
- Notebook on a non-home office while HQ is unreachable: start without it (current), or use
  a cached last render?
- Clusters: compute nodes may lack outbound access; confirm the login-node office pattern.

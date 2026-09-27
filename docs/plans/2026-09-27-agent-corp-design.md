# agent-corp design

- Date: 2026-09-27
- Status: validated in brainstorming; ready for implementation planning
- Decision record: [issue #1](https://github.com/ngocbh/agent-corp/issues/1)

## 1. Overview and principles

agent-corp lets anyone build a **company of AI employees** that works for them and
evolves with them. It is the application layer; [agent-composer](https://github.com/ngocbh/agent-composer)
(vendored here as the `agent-composer/` submodule) is the engine. Both are ours: any
engine capability agent-corp needs becomes a **generic** agent-composer feature, never a
company-specific one.

Principles:

1. Simplicity, generality, flexibility, in both projects.
2. agent-corp uses only agent-composer's public API.
3. Everything an employee does is a composer **flow** (main loop, SOPs, debriefs, reviews).
4. **Company as code**: definitions live in a git repo; changes are reviewable diffs.
5. **Hard guarantees come from flow structure** (gates), not prompts.
6. **Cautious by default**; autonomy grows through the owner's instructions.
7. **Work items** are the single communication primitive.
8. **Server-first sessions**: the office owns sessions; every UI is an equal client.
9. Data stays on the owner's machines; HQ keeps metadata and summaries only.

Non-goals for now: hosted multi-tenant SaaS, Windows offices, employees rewriting their
own flows mid-run, real-money trading before gated SOPs exist.

## 2. Architecture

```
Terminal (ac)  ──unix socket──►  Office (per machine, Python)  ──►  harness: composer | codex | claude
                                   │ outbound WebSocket
                                   ▼
Browser/phone  ────────────────►  HQ (TypeScript)  ──relay──►  same office
```

| Component | Tech | Role |
|---|---|---|
| `ac` binary | TypeScript/Bun | CLI + TUI + HQ server + embedded web UI in one binary |
| TUI | OpenCode's TUI (OpenTUI + Solid) and `session-ui`/`ui` components | person picker, chat, live session view |
| HQ | Hono/Effect, SSE, Drizzle + SQLite (OpenCode server plumbing) | registry, org, work items, session index, relay |
| Web UI | Solid.js, served by HQ | org, work items, sessions, live view, prompt/approve |
| Office | Python, installed by `ac onboard` via uv; launchd/systemd | hosts employees, owns sessions, runs composer in-process and harness adapters |
| Engine | agent-composer (submodule, Python library) | flows, memory, learning, run logs |

- **Protocol**: our own small session protocol shaped like OpenCode's
  (Session / Message / Part / Permission). Defined once as TypeScript schemas, exported to
  JSON Schema, from which pydantic models are generated for the office.
- **Networking**: HQ binds loopback and is exposed through `tailscale serve` by default
  (free). VPS, Cloudflare Tunnel, and ngrok are documented alternatives; public exposure
  is opt-in. Offices connect **outbound**, so clusters need no inbound ports.
- **Pairing**: offices and clients join with a token the owner approves.
- **Data residency**: HQ stores metadata, summaries, and cost. Transcripts, run logs,
  memory, and secrets stay on the office where they were produced; the app fetches content
  on demand (unavailable while that office is offline). A per-person provider policy
  controls which LLM providers may see which data.
- **CLI naming**: agent-corp's CLI is `ac`; agent-composer's CLI is renamed `composer`.
  agent-corp uses composer as a library only.
- **Reference designs**: OpenClaw (gateway daemon, onboarding, pairing) and OpenCode
  (client/server sessions). We learn from both but build on neither.

Proposed layout of this repo:

```
agent-composer/        # submodule; the office depends on it as a uv path dependency
packages/protocol/     # TS schemas → JSON Schema → generated pydantic
packages/ac/           # CLI + TUI + HQ + web (one Bun binary)
office/                # Python office daemon and harness adapters
docs/plans/
```

## 3. Data model

### Company repo (one git repo per company)

```
company.yaml
people/<id>/person.yaml   # + persona.md, main.yaml, sops/ for agents
groups/<id>.yaml          # departments, teams, cross-cutting groups
shared/flows/             # debrief.yaml, triage.yaml, ...
```

The org chart is **people plus reporting lines**. No roles are hardcoded (no `assistant`
or `tech_manager` fields); an assistant or CTO is just a person you add.

```yaml
# company.yaml
name: ngocbh-corp
hq: https://hq.my-tailnet.ts.net
ceo: ngocbh                      # root of the org chart
defaults: { provider_policy: default, cost_cap_usd: 5 }
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
home_office: laptop
main: main.yaml
sops: []
memory: [notebook, session]
harnesses: [composer]
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

### Runtime entities

HQ (SQLite):

- **Person** (mirrored from the repo), **Office** (id, host, status, last_seen)
- **WorkItem**: id, title, kind (`task` | `question`), status, assignee, requester,
  parent_id, groups, `gate` (bool), resolved_by, on_behalf_of, summary, cost, timestamps
- **Comment**: work_item_id, author, body, on_behalf_of
- **Session**: id, person, harness, office, work_item_id, cwd, repo_commit, status, cost, timestamps
- **RunRef**: office, run_id, work_item_id (pointer to a run log on an office)

Office only: **Message** (session_id, author, parts[]), **Part** (text | file | tool_call |
tool_result | permission_request | question), run logs, memory stores, secrets, event outbox.

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
- **Gate items** (`gate: true`: trades, deletions, other flow gates) can only be resolved
  by a human. Assistants may annotate them but not answer.
- The repo is authoritative for definitions; content streams through HQ without being stored.

### Employees and memory

- An employee is a persistent identity; its runtime is **on demand** (instantiated when a
  work item, comment, routine, or session arrives).
- **Main flow**: the generalist loop (like composer's `chat.yaml`), itself a flow that can
  evolve per role. **SOPs** are fixed flows for recurring work, later exposed as tools.
  Evolution: improvise → codify into an SOP (owner approves the diff) → improve via feedback.
- **Hard gates**: dangerous raw tools are reachable only through SOPs containing approval
  nodes (`case` + `human_input`). Lint rejects definitions that break this.
- **Notebook memory** (new composer built-in): accumulating notes that are always fully in
  context; older notes are LLM-compacted over budget, raw notes kept, later notes override
  earlier ones. It is the playbook, written **only via `backward()`**, with provenance
  (owner / manager / self, source run). Frames may declare several memory policies.
- **Learning triggers live in agent-corp, not composer YAML**: routines (trigger `every` |
  `cron` | `event`, flow, optional reviewer) decide when to call `backward()`. An answered
  escalation always becomes feedback.

## 4. Session lifecycle (Milestone 1)

1. **Start**: `ac codex` in `~/workspace/longhstu`. The picker lists people associated
   with the folder, then recent ones, then "hire new…". The owner picks Minh.
2. **Register**: HQ creates a WorkItem (assignee `minh`, requester `ngocbh`) and a Session
   (harness `codex`). The session runs on the **office where the folder lives**; the
   identity travels, the work stays next to the code. If HQ is unreachable, the office
   creates both locally and syncs later.
3. **Boot**: the office loads Minh's persona and recalls his notebook, starts the harness
   adapter with both injected, and exposes company tools (`ask_manager`,
   `create_work_item`, `comment`), likely via MCP.
4. **Chat**: `ac` talks to the local office directly over a unix socket. The office mirrors
   events to HQ asynchronously. Browsers and phones reach the office through HQ's relay.
   The office owns the session, so closing the terminal does not end it.
5. **Permissions**: a tool-approval request appears in every connected client; the first
   answer wins. Gate items accept only human answers.
6. **End**: on close or idle, the office runs `shared/flows/debrief.yaml` (learnable,
   declares the person's notebook): summary, work-item status, artifacts, decisions, cost,
   proposed follow-up items (owner confirms). HQ stores the summary and cost.
7. **Learn**: owner feedback on the debrief in the app → `backward()` on the persisted
   debrief run → notebook → recalled in the next session in any harness.

Harness adapter interface: `start(persona, notebook, cwd)`, `send(prompt)`, `events()`,
`approve(request)`, `interrupt()`, `close()`. Codex and Claude are driven through their
programmatic interfaces (Codex app-server / exec JSON, Claude Agent SDK), not their TUIs.
The composer harness runs the person's main flow, and its `human_input` nodes route to the
chat through the broker.

## 5. Failures and recovery

The office's local record is the source of truth; everything else can be rebuilt from it.

- **HQ unreachable**: local chat, routines, and suspended runs continue. Outgoing events go
  to a SQLite outbox and replay on reconnect; event IDs make replay idempotent. Web access
  is unavailable meanwhile.
- **Office offline**: HQ marks it offline after missed heartbeats; its sessions show as
  offline and content is unavailable. New work for people homed there waits at HQ. No
  failover in M1.
- **Office restart mid-session**: composer runs resume from their run log. Codex/Claude
  adapters resume via the harness's own session/thread ID where supported; otherwise the
  session becomes `interrupted` and the debrief runs on what exists.
- **Waiting runs** stay suspended on disk at no cost and survive restarts; an answer resumes
  them, even days later.
- **Debrief failure**: the session shows `debrief pending` and retries; transcripts are never
  deleted.
- **Runaway cost**: each session and routine has a cost cap (person policy, company default).
  Hitting it pauses the work and creates a work item for the manager.
- **Definition changes**: sessions and runs pin the repo commit they started from. Invalid
  definitions (schema errors, gate lint) are rejected before merge.
- **Revoked pairing**: HQ drops the office; it keeps local data but stops syncing.

## 6. Testing

The full Milestone 1 journey runs in CI with no API keys, using fakes at the edges.

- **Protocol contract**: shared golden fixtures (recorded event streams) replayed against
  both the TypeScript and Python sides.
- **Office (pytest)**: flows (main loop, debrief, triage) against a scripted LLM stub;
  harness adapters against recorded Codex/Claude transcripts plus a fake harness (prompts,
  permissions, interrupts, crashes); memory: feedback → persisted `backward()` → notebook
  entry with provenance → recall.
- **HQ and `ac` (`bun test`)**: API tests with in-memory SQLite and a fake office over
  WebSocket; TUI frame snapshots.
- **End-to-end**: one command starts HQ, an office, and the fake harness, then scripts
  `ac codex` → pick Minh → prompt → approve → close → debrief → feedback → next session
  recalls it.
- **Failures**: kill HQ mid-session (outbox replays, no duplicates); restart the office
  (composer resumes; unresumable harness sessions become `interrupted`); two clients answer
  the same question (first wins).
- **Company repo**: schema and gate lint as a pre-merge check; HQ runs the same code on load.
- **Outside CI**: opt-in live smoke tests with real Codex/Claude; a small manual eval that
  feedback actually changes the next session's behavior.

## 7. Build order

Milestone 1, "work with persistent employees, from anywhere":

0. **agent-composer prerequisites** (one issue and PR each, in agent-composer): rename CLI to
   `composer`; `system_prompt:` (#259); NotebookMemory; multiple memory policies per frame;
   `backward()` on a persisted run; verify a host-pluggable `human_input` broker.
1. **Protocol and company repo**: TS schemas → JSON Schema → pydantic; repo loader and lint.
2. **Office**: daemon, unix socket, SQLite store and outbox, composer harness with a generic
   main-flow template; `ac onboard` installs it via launchd.
3. **`ac`**: picker and chat on OpenCode's TUI, attached to the local office.
   *Milestone: chat with a persistent Minh locally, no HQ.*
4. **HQ**: pairing, org / work-item / session API, WebSocket relay, outbox sync.
5. **Web UI**: org, work items and sessions filtered by subtree or group, live view,
   prompt and approve. *Milestone: watch and prompt a laptop session from a phone.*
6. **Harness adapters**: Codex, then Claude.
7. **Learning loop**: debrief → feedback → `backward()` → notebook → recall.
8. **E2E suite and dogfooding** with 2–3 people (Minh, Ava).

Later phases:

1. **Autonomy**: routines (including Ava's queue triage), delegation between employees,
   escalation chains, mid-run pause/redirect.
2. **Growth**: HR hiring via repo diffs, SOP codification, flow-as-tool.
3. **Distribution**: offices on clusters, infra department, Obsidian knowledge base.
4. **High stakes**: finance with gated trading SOPs, cost department, messaging channels,
   OpenClaw integration.

## 8. Required agent-composer features

- [ ] Rename CLI `ac` → `composer`
- [ ] `NotebookMemory` built-in
- [ ] Multiple memory policies per frame (`long_term_memory: [a, b]`)
- [ ] `backward()` on a persisted run
- [ ] `system_prompt:` (#259)
- [ ] Host-pluggable `human_input` broker (verify)
- [ ] Flow-as-tool (phase 2)
- [ ] Skills (#260, later)
- [ ] Suspend-on-request / pause at the next node boundary (phase 1; verify)

## 9. Open questions

- Self-notes: should an employee record discoveries mid-run? Current lean: no mid-run tool
  in v1; capture via reflection at learning time; route world facts to shared knowledge;
  mind memory poisoning.
- ACP as the harness adapter interface: maturity to be verified.
- Exact Codex programmatic interface (app-server vs exec + resume).

VERDICT: NEEDS_REVISION

## Summary Assessment

The product shape holds up: people plus reporting lines, company as code, an office daemon per machine that owns sessions, and learning through `backward()`. The design does not yet hold up against the engine it is built on. Several load-bearing claims contradict current agent-composer code: durable suspended waits, a pluggable per-run `human_input` broker, a notebook that follows a person across flows and machines, and repeated feedback on one run. The hard-gate guarantee also fails for external harnesses. Milestone 1 is roughly three milestones combined, and the core value (learning) lands last.

## Critical Issues (must fix)

### C1. "Waiting runs stay suspended on disk at no cost" contradicts the engine, which removed suspension

- Design lines 225-226 claim waiting runs "stay suspended on disk at no cost and survive restarts; an answer resumes them, even days later". Section 8 (line 295) lists "Suspend-on-request / pause" as something to "verify".
- agent-composer deleted suspension on purpose: `docs/plans/2026-08-12-run-log-runtime-cleanup-design-v2.md:314-328` ("Delete `Pause`, `PauseRequested`, `RunPaused` ... checkpoints, live-engine resume, and the `suspension/` package"). `src/agent_composer/` has no `suspension/` package today.
- `HUMAN_INPUT` blocks a live worker thread until the handler returns (`src/agent_composer/nodes/human_input/node.py:1-5,83`; `docs/api.md:833-838`). A waiting run holds a thread, an open run, and the exclusive JSONL lock. A gate that waits for days costs one live thread per pending question.
- After a restart, `resume_flow` does not resume a wait. It re-runs every node that has a durable start but no outcome (`docs/api.md:772-790`). A `human_input` therefore asks again. An AGENT that was mid-tool-loop re-runs its model calls and tool effects (`docs/api.md:802-806`).
- The composer harness's main loop, `chat.yaml`, is one long run: a LOOP whose `human_input` fires each turn (`src/agent_composer/cli/chat/chat.yaml`). So every idle composer session is a "waiting run" in exactly this sense.
- **Fix:** State the real model. Waits block, and the office persists pending questions and their answers in its own store. After a restart, `resume_flow` re-invokes `human_input` and the broker returns the stored answer, or re-posts the question if none exists. This needs the per-run broker identity described in C2.
  - Alternatively, avoid long-lived runs. Make each chat turn its own run with `SessionMemory` continuity; `ac chat` already restarts runs after failures (`src/agent_composer/cli/chat/command.py:1-13`).
  - Either way, drop "at no cost" and remove "suspend/pause" from the engine wishlist, unless you want to reopen a decision agent-composer made deliberately.

### C2. The `ask_user` broker, tool registry, and stop control are process-global and do not know which run they serve

The office "runs composer in-process" for many employees and sessions at once. The current public surface cannot support that.

- **One global handler.** `install_ask_user` has exactly one owner per process, and a second owner raises (`src/agent_composer/tools/registry.py:168-205`; `docs/api.md:861-862`). The handler receives `question, questions, answer_schema, title, node_id` (`registry.py:178-192`), with no `run_id` and no occurrence path.
  - Two employees' runs, or one run's `human_input` inside a MAP, are indistinguishable.
  - Pool workers run in a `ThreadPoolExecutor` without `contextvars.copy_context` (`src/agent_composer/runtime/engine.py:195-198`), so a host cannot even work around this with a context variable once `num_workers > 0`.
- **No caller identity for tools.** Tools are one global `TOOL_REGISTRY` keyed by id. They receive only model arguments (`registry.py:26`; `src/agent_composer/nodes/agent/modes/tool_calling.py:157,167`). Company tools like `ask_manager`, `create_work_item`, and `comment` therefore cannot tell whether Minh or Ava called them. Composer also has no MCP support (no MCP code under `src/agent_composer`).
- **No public stop.** Public `run_flow` creates its own `threading.Event()` and never exposes it (`src/agent_composer/run.py:315-329`). Only the private `_run_flow_controlled` accepts a `stop_event`, and `ac chat` uses it (`cli/chat/command.py:43`). The adapter's `interrupt()`/`close()` would therefore break principle 2, "public API only".
- **Fix:** Add generic engine features to section 8 in place of "verify broker":
  1. Pass a run-scoped interaction handler and tool context to `run_flow`/`resume_flow`, with `run_id`, node id, and occurrence path.
  2. Add a public cooperative cancel handle.
- **Or avoid the problem:** Make the office a supervisor that spawns one Python worker process per active run. That alone fixes the global handler, tool identity, and interruption (kill the process), and isolates crashes. It is arguably the simpler design. Its tradeoff is memory-store ownership (see C3d).

### C3. Notebook memory, as described, conflicts with composer's memory and backward contracts on five points

The notebook is the product's "evolves with you" mechanism, so these points must be settled before M1.

- **(a) Scope.** Existing policies key state by authored frame, `MemoryFrameRef(root_flow_id, static_path, owner)` (`src/agent_composer/memory/contracts.py:575-589`; reflective keys by it at `memory/reflective.py:270`). Docs say "each frame owns and writes only its own state" (`docs/agent.md:227-229`).
  - The design needs one notebook per person, shared by `debrief.yaml`, each person's `main.yaml`, and the Codex/Claude harnesses. Notes learned in the debrief frame would never be recalled in the main-flow frame.
  - Renaming a node or a flow id would also orphan frame-keyed state.
  - The spec must say that `NotebookMemory` ignores the frame reference, with one instance per person, and justify that exception to frame ownership.
- **(b) Stale snapshots.** `backward()` reopens memory from the run's opening snapshot and requires an exact match (`src/agent_composer/runtime/backward.py:237-238`; `docs/learning.md:219-223`). `ReflectiveMemory`, the closest existing policy, rejects learning when the backend revision has moved on (`memory/reflective.py:1174-1183,1640,1335,1418`; `docs/api.md:396-399`).
  - Feedback on Monday's debrief given Wednesday, after any other commit to Minh's notebook, would fail under that pattern. The engine promises "no rebase".
  - `NotebookMemory` must define commutative, append-only commits that accept stale snapshots. That is also how "later notes override earlier ones" can hold.
- **(c) One feedback per run.** After a backward attempt succeeds or any commit is requested, no further backward is allowed on that run (`src/agent_composer/runtime/backward.py:221-223`; `docs/api.md:391-392`).
  - The design expects several feedback events per run: debrief feedback, "reopening it becomes feedback" (line 160), and "an answered escalation always becomes feedback" (line 183).
  - Decide what a second feedback targets: a new small learnable "review" run per feedback event, or batching feedback before calling `backward()`.
- **(d) Home and replication.** The built-in SQLite storage is "single-host, single-owning-process" (`docs/api.md:316-319`). Yet the design says "the identity travels, the work stays next to the code" (line 190), and "memory ... stay[s] on the office where [it was] produced" (line 55).
  - Minh working on the cluster office either has no notebook or forks a second one. "Recalled in the next session in any harness" (line 205) is then false across machines.
  - Pick one:
    - The notebook lives in the company git repo (`people/<id>/notebook.md`, reviewable diffs, which fits "company as code" and data residency).
    - Or it has one home office; other offices recall it through HQ and send commits back.
  - If the office uses one process per run (C2), concurrent sessions of one person also cannot all own the SQLite file.
- **(e) Recall outside a run.** Codex/Claude sessions need the rendered notebook at `start()`. Today that means building a synthetic `MemoryFrameSpec` and calling `open_run().open_frame().recall()`. Add a small public host method, for example `NotebookMemory.render()`.
- **Also specify:**
  - When LLM compaction runs. It is a write outside `backward()`; `SessionMemory`'s recall-time summary cache is a precedent (`docs/api.md:523-550`).
  - How huge transcripts are bounded for the learner. Reflective caps episode material at 20k characters (`_MAX_EPISODE_MATERIAL_CHARS`, `memory/reflective.py:50`).

### C4. "Hard guarantees come from flow structure" does not hold for Codex/Claude sessions or local agents

- Gate lint (line 174) can prove that composer-harness tools are reachable only through `case` + `human_input`. But `ac codex` and `ac claude` sessions have their own shell and network tools. A Codex "Minh" can `curl` a broker API or `rm -rf` directly, and no flow is involved.
- Principle 3 ("everything an employee does is a composer flow") is also false for these sessions; only the debrief is a flow.
- "Gate items accept only human answers" (lines 163-165, 199) has no enforcement mechanism:
  - The office trusts its unix socket.
  - Agent sessions run as the same OS user on the same machine.
  - An agent can run `ac`, reach the socket, or read the paired client token, and answer its own gate as "the owner".
  - Model-invoked `ask_user` and authored `human_input` share one handler (`docs/api.md:835-860`). Only the trusted path carries `node_id`, so the broker must accept gate answers only for authored nodes.
- **Fix:**
  1. Scope the guarantee explicitly to composer SOPs.
  2. Isolate credentials, so dangerous-API secrets are available only to gate-SOP tool code and never to harness environments.
  3. Configure the Codex/Claude sandbox and approval policy per person.
  4. Authenticate clients so a human answer needs something an agent process cannot obtain: a per-client pairing key outside the agent's reachable filesystem, or confirmation on a second device for gate items.

### C5. The source-of-truth and sync model is self-contradictory

- Line 214 says "the office's local record is the source of truth; everything else can be rebuilt from it". But HQ is the only home of:
  - work items and comments created from the web
  - pairing and org mirrors
  - cross-office work, such as an item assigned to someone homed on another office
- Offices may also create work items and sessions while offline and "sync later" (lines 190-191). Unspecified:
  - the ID scheme (office-minted IDs must be global, e.g. ULIDs)
  - conflict rules, such as the owner editing or closing the item on the web while the office's copy sits in the outbox
  - who wins on status transitions
- "The office mirrors events to HQ" through a SQLite outbox that replays on reconnect (lines 195, 216-217). As written, that ships message content to HQ, violating "HQ keeps metadata and summaries only" and "content streams through HQ without being stored" (lines 55, 166).
- **Fix:** Define ownership per entity:
  - Office owns sessions, messages, run logs, and memory.
  - HQ (or the repo) owns work items, comments, and org.
  - Split the protocol into durable metadata events (outboxed, idempotent) and live content (relayed only to subscribed clients, never outboxed).

### C6. Reusing OpenCode's TUI and UI "with our own protocol" is much more expensive than stated

This is on the M1 critical path (step 3) and drives the TypeScript stack choice.

- `packages/tui` is about 27k lines. It is wired to `createOpencodeClient` from `@opencode-ai/sdk/v2` (`/Users/ngocbh/workspace/opencode/packages/tui/src/context/sdk.tsx:1`).
  - It calls about 55 distinct `sdk.client.*` endpoints: session fork, revert, shell, summarize, provider OAuth, mcp, lsp, vcs, workspaces, and more.
  - Its sync layer consumes about 19 event types (`tui/src/context/sync.tsx`).
  - It depends on `@opencode-ai/core` and `@opencode-ai/plugin` (`tui/package.json`).
- `session-ui` and `ui` are DOM components (`@kobalte/core`, `dompurify`, `morphdom` in `packages/session-ui/package.json`). They cannot render in the terminal, so the design's TUI row (line 42) conflates web components with TUI reuse. `session-ui` also pins a vendored client tarball (`file:../app/vendor/opencode-ai-client-1.17.13-v2.tgz`).
- The protocol is "shaped like OpenCode" in name only. OpenCode models a tool as one `ToolPart` with pending/running/completed/error state (`packages/sdk/js/src/gen/types.gen.ts:292-298,384-400`). Permission and Question are separate entities (`types.gen.ts:423`), not message parts. The design's `Part (text | file | tool_call | tool_result | permission_request | question)` does not match, so the components will not bind without an adapter.
- **Fix:** Choose explicitly, and spike before freezing the protocol in step 1:
  - (a) Serve an OpenCode-compatible API subset from the office or an `ac`-side shim, and adopt OpenCode's Part/Permission/Question model as the protocol.
  - (b) Fork the TUI and rewrite its sdk/sync layer, owning upstream churn (version 1.18.32, with `v2`/`sdk-next` still moving).
  - (c) Build a minimal Solid/OpenTUI picker and chat that borrows components but not the data layer.
- Also consider ACP. OpenCode already ships an ACP implementation (`packages/opencode/src/acp/`), and ACP adapters exist for Codex and Claude. It could serve as both the harness-adapter interface and the client protocol, which would retire the custom protocol and the TS-to-pydantic codegen (the design's open question at line 318).

### C7. Milestone 1 is too large, the build order puts the core value last, and the prerequisite list is wrong

- **Scope.** M1 bundles six composer PRs, protocol codegen across two languages, a launchd daemon, a TUI fork, HQ (pairing, relay, sync), a web UI, two harness adapters, the learning loop, and a full E2E suite. The learning loop, the product's differentiator, is step 7 of 8. The step-3 milestone "persistent Minh" has a persona but no learning.
- **Prerequisite list errors:**
  - "`backward()` on a persisted run" already exists: `resume_flow(flow, log=..., memory=...)` then `.backward(...)` (`docs/learning.md:204-223`; `docs/api.md:705-740,769-770`). Remove it. Note that `resume_flow` checks the flow fingerprint (`docs/api.md:756-757`), so the office must load `debrief.yaml` from the pinned repo commit, not HEAD.
  - "Multiple memory policies per frame" is unnecessary for M1. Frames already stack outer to inner: flow-level `long_term_memory: notebook` plus AGENT-level `long_term_memory: session` gives both policies (`docs/syntax.md:260-266`; `docs/agent.md:219-230`). Frame identity is one policy per frame, so changing that is not a small feature.
  - `system_prompt:` (#259) can be deferred. The persona can be a flow input rendered into the prompt.
  - Missing: a run-scoped interaction handler, tool run context, and a public cancel handle (C2), plus notebook stale-snapshot semantics (C3).
- **Suggested re-cut:**
  - **M1:** office, one harness (Codex, the user's headline journey, or composer), notebook, debrief, local feedback (`ac feedback`), and recall in the next session, all local.
  - **M2:** HQ, pairing, relay, and web.
  - **M3:** the second harness and TUI polish.
  - Run the OpenCode-reuse spike and the Codex app-server spike before freezing the protocol in step 1.

## Suggestions (nice to have)

- **Lint language.** "HQ runs the same code on load" (line 253) is not possible as stated. Gate lint needs composer's Python compiler, and HQ is TypeScript. Either HQ trusts lint results reported by the office, or HQ bundles Python.
- **Company repo distribution.** Unspecified: how each office gets and updates the company repo (clone, pull cadence, pinned-commit checkout), who commits when "hire new…" runs from the picker, and how "people associated with the folder" is stored.
- **Session end.** "On close or idle" (line 200) conflicts with "closing the terminal does not end it" (line 197). Define an explicit end command plus an idle timeout.
- **SessionMemory scope.** Conversations are keyed by frame plus authored leaf, with no session id (`docs/api.md:483-490`; `memory/contracts.py:1614-1636`). Concurrent composer sessions of one person need separate `SessionMemory` instances, or they share and queue one conversation.
- **Stale recall in long runs.** Recall uses the run-opening snapshot (`docs/api.md:573-575`). Notes learned during a session that stays open for days never reach it, and resuming a long run needs that exact old snapshot. Run-per-turn avoids both problems.
- **Feedback semantics.** Feedback is given on the debrief's output (the summary), not on the work. Define the debrief output fields, such as decisions and follow-ups, so structured feedback targets them. Make sure the notebook learner, not the debrief agent's self-feedback, turns it into playbook notes.
- **Reuse ReflectiveMemory.** `ReflectiveMemory` already does LLM-proposed add/revise/remove of lessons with durable storage (`memory/reflective.py:1-5,1644-1650`). Consider extending it with person scope, recall of all lessons, and compaction, rather than adding a parallel built-in.
- **Cost caps.** Codex reports tokens, and the design needs a price table to enforce a USD cap. Claude Agent SDK reports cost. Not verified here.
- **Clusters.** Many clusters forbid persistent user daemons or systemd user units, and compute nodes may lack outbound access or Tailscale. Clusters are a later phase, but "`ac onboard` installs a persistent daemon" should allow a login-node or tmux fallback.
- **Two language stacks.** A TypeScript HQ plus a Python office plus codegen adds ongoing cost. Revisit once C6 is decided. If OpenCode reuse shrinks, a single Python HQ and office with a static web UI may be simpler.
- **Tailscale for clients.** `tailscale serve` as the default requires Tailscale on every phone and browser client. Document this in onboarding.
- **Gate trust boundary.** Gate SOPs should rely only on authored `human_input` (trusted path with `node_id`), never on model `ask_user`. Lint should reject `ask_user` in gate SOPs.

## Verified Claims (things you confirmed are correct)

- agent-composer's CLI is currently `ac` (`agent-composer/pyproject.toml:54-55`), so the rename is needed to avoid a collision.
- `system_prompt:` is not yet valid; it is tracked in #259 (`docs/agent.md:217-218,410-412`).
- Learning is explicit and separate from forward execution. `learnable=True` plus `result.backward(feedback)` commits through host-injected memory policies (`docs/learning.md:22-48`; `docs/api.md:94-146`).
- Backward on a run in a later process works today through `resume_flow` (`docs/learning.md:204-223`).
- The YAML selects a policy by name, and the host supplies the implementation. A per-person instance under a static name like `notebook` is supported (`docs/syntax.md:225-260`; `docs/api.md:212-265`).
- Durable JSONL run logs, `resume_flow` recovery with fingerprint checks, and at-least-once re-execution of interrupted nodes (`docs/api.md:652-806`). The design's "composer runs resume from their run log" is accurate, with the retry caveats in C1.
- `on_event` and `on_stream` give post-durable events and transient stream chunks for live views (`docs/api.md:118-122`).
- `human_input` is host-pluggable through `install_ask_user`, but globally and without run identity (C2).
- Built-in durable memory is SQLite with mode 0600, single-host and single-owner (`docs/api.md:298-320`).
- OpenCode's TUI is OpenTUI plus Solid (`packages/tui/package.json`). OpenCode packages are MIT-licensed. Its session model is Session/Message/Part plus Permission and Question events.
- The Codex CLI installed on this machine has an `app-server` subcommand (marked experimental) with JSON Schema and TypeScript generation (`codex app-server --help`). The details of instructions injection and approvals were not verified.

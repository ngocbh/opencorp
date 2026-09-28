VERDICT: NEEDS_REVISION

# agent-corp design review, round 2 (final)

Reviewed: `agent-corp-design-v3.md` (cited as `v3:<line>`), against agent-composer at
`ca4052c` (paths relative to `agent-composer/`), issues #324–#330 (including the #329
comment), and `~/workspace/opencode/packages/tui` at `b471c2b`.

v3 resolves most of round 1. Waits now block honestly, identity travels in per-run
closures, notebooks have one home, entity ownership is explicit, and learning lands in
M1. Two problems remain that block implementation. First, the decided "Esc = cancel the
run and start a new one" rule conflicts with the decided "feedback = `backward()` on the
run" rule, and this breaks the M1 milestone journey. Second, the local trust boundary
contradicts itself, which leaves the permission and gate model open to any process
that runs as the owner's OS user. Both have small fixes that keep the owner's
decisions.

## Critical (blocks implementation)

### K1. Feedback cannot target a chat session that was interrupted, cancelled, or ended while busy

The design claims that feedback on "a chat session" works by `resume_flow` then
`backward`, and that "Finished nodes are reused, so nothing re-runs" (v3:388-393). That
holds only for a run that reached a terminal state. The engine facts:

- Cancel leaves the run **non-terminal**. The stop path raises the private `_HostStop`
  out of the engine (`runtime/engine.py:468-471`, `nodes/base.py:472-477`: "unwinds node
  evaluation without becoming a node failure or a flow failure"). The log keeps a
  `NodeStarted` with no outcome.
- `backward()` needs a terminal run. The handle is built only from terminal state
  (`run.py:544-546`, `run.py:602` → `_result_from_state`, which raises on a non-terminal
  state at `run.py:786`), and `drive_backward` runs "against an accepted terminal run"
  (`runtime/backward.py:195`).
- `resume_flow` on a non-terminal log **retries the unfinished nodes and continues the
  frontier** (`docs/api.md:771-776`). For an interrupted chat run, that re-sends the
  cancelled reply's model calls, repeats its tool effects, then loops into the next
  `human_input`, which asks a human and blocks.

Runs that end up non-terminal:

- every Esc (v3:458, "cancel the run (#326) and immediately start a new chat run");
- `ac end` or `idle_end` while the employee is busy (v3:479-480);
- cost-cap stops (v3:521-523);
- office crashes where the session is not resumed.

A session is therefore a **chain of runs** (interrupt restarts, plus the restarts after
failed runs described in I3), but `Session` has a single `run_id` (v3:308-309). It is
also unspecified which run(s) "feedback on the session" targets. The M1 end-to-end
journey is exactly "steer, then Esc and prompt again, then `/end`, then `ac feedback`"
(v3:567-571). As written, that feedback either loses the pre-Esc turns or
re-executes them.

**Fix (pick one and write it down):**

- **(a) Recommended; keeps "one live run per session".** Make interrupt node-scoped
  instead of run-scoped. Generalize #327 or #326 so the host can abort the **current
  steerable AGENT node**. The node then completes with its partial output marked
  interrupted (as a value, not a failure), the LOOP moves on to the next `human_input`,
  and the session keeps one run.
  - Route `/end`, `ac end`, and `idle_end` through the flow's own exit case: the office
    answers the pending `human_input` with the exit command, and aborts the current node
    first if busy. The run then finishes terminally.
  - Run-level `cancel=` stays for pause, cost cap, and shutdown.
- **(b)** Add a generic engine operation that closes a non-terminal log as terminal
  (`failed: cancelled`) without re-executing, and allow `backward()` on failed runs over
  the accepted prefix. Then give `Session` a `run_ids[]` list and define feedback on a
  session as backward on each run, or on the last run plus the debrief.

With either fix, remove "nothing re-runs" from v3:392 unless the run is terminal.

### K2. The local trust boundary contradicts itself, so any process running as the owner's OS user holds the owner's authority

- v3:430-431 says "Anything the owner's OS user can read is assumed readable by local
  agents". Yet v3:419-421 says Codex and Claude have "no access to the secret store",
  and the office, which reads that store, runs as that same OS user. No mechanism is
  named.
  - Codex's `workspace-write` sandbox restricts writes, not reads, as far as I know
    (not verified here). "Scrubbed environment" does not cover files or the Keychain.
- The office's unix socket authenticates nobody (v3:449-451). Only gate answers are
  excluded from it (v3:428-431). Everything else is owner-equivalent to any process
  that can reach the socket, including:
  - approving definition diffs, which include **grants and `gate:` flags** (v3:255-256);
  - editing any notebook (v3:374-375);
  - giving feedback, which writes notes into any employee's notebook;
  - answering harness tool approvals (v3:463);
  - starting sessions as any person.

  A Codex "Minh" with a shell (M1.5), or a composer employee with a shell tool, can
  run `ac` against the socket. It can then approve a diff that grants itself `admin` on
  an asset and use that asset's tools. The model never sees the credentials, but it
  gets their effect.
- The per-session office MCP endpoint (v3:448-449) has no stated authentication. A
  harness in Ava's session could call Minh's endpoint and use Minh's grants.
- The office clone of the company repo is writable by the same user. An agent can
  append to `people/*/notebook.jsonl` or edit `assets/*.yaml` directly, and the next
  auto-commit (v3:381-384) publishes the change.
- This already applies in **M1**. "Dogfooding with Minh on real repos" (v3:609) needs
  file and shell tools, and the design never says where they come from. Composer ships
  none (`tools/registry.py:7-8`), and the toolbox in M1 contains only company tools
  (v3:284-285).

**Fix:** state one trust rule and apply it everywhere.

1. Every agent-driven process runs in an OS sandbox (seatbelt/landlock, or a separate
   OS user). This covers Codex, Claude, and composer shell/file tools. The sandbox
   profile **denies** the office state dir: socket, SQLite store, secret store, run
   logs, and the office's company-repo clone.
   - Make this a named, testable requirement of `harness_policy`, and have the M1.5
     spike verify it for Codex.
2. Office-privileged operations are **owner-only**, meaning reachable only from
   outside the sandbox. These are definition merges, grant or gate changes, notebook
   edits, and feedback. From M2, grant and gate diffs also need paired-device approval,
   like gate answers.
3. Each per-session MCP endpoint gets an unguessable per-session capability, and is
   reachable only from that session's sandbox.
4. Define workspace file and shell tools for M1 as an asset kind (for example
   `local_folder`) granted per person and run under the same sandbox.

## Important

### I1. Office git layout is unspecified, and a naive implementation corrupts notebooks

- Definitions are read at a pinned commit (v3:254). Feedback "checks out the flow at the
  run's pinned `repo_commit`" (v3:390-391), and resume does the same (v3:525).
  Meanwhile, live sessions are appending to `people/<id>/notebook.jsonl` in the working
  tree, and the office auto-commits, pulls, and pushes (v3:381-384).
  - A `git checkout <old>` in the shared clone would revert the notebook file under the
    running JSONL backend, so new ops get appended to an old version.
  - Composer loads flows from files with relative references (`main:
    ../../shared/flows/chat.yaml`, v3:214), so each pinned commit needs a materialized
    tree.
- **Fix:**
  - Definitions come from a read-only `git worktree` (or export) per pinned commit,
    cached by commit.
  - The notebook backend always writes to the main working tree.
  - One office-wide repo lock serializes appends, commit, pull (merge), and push.
- **M1 gaps in the same area:**
  - There is no push remote in M1 (no HQ, and the GitHub mirror is off by default), yet
    v3:382 says "the office then pushes".
  - v3:255 requires owner approval of definition branches, but M1 has no approval UX,
    and "hire new…" in the M1 picker (v3:441) creates a definition. Say that
    owner-initiated changes from `ac` count as approved in M1, or add `ac review`.

### I2. NotebookMemory snapshot identity and op ordering are unsafe under `merge=union` (#329, M0)

- Resume and backward require every policy to "reproduce the exact snapshot stored by
  `RunStarted`" (`docs/api.md:762-764`; `runtime/backward.py:237-238`). The #329
  comment defines a past snapshot as **a line offset**, which breaks under union merge.
  - Office B pushes `base+b1`, then office A pulls and merges to `base+a1+b1` and
    pushes.
  - B fast-forwards to that merge. B's recorded offset `len(base)+1` now covers `a1`,
    not `b1`.
- Folding "in op-id order" (v3:364-366) uses ULIDs, which follow wall clocks. On a
  laptop and a cluster with skewed clocks, an `edit` can get a smaller op id than the
  `add` it edits. The edit then folds first, has no effect, and is silently lost.
- **Fix:**
  - A snapshot is the set of op ids visible at open (or a digest plus the set, since
    notebooks are small). Reconstruct it by filtering.
  - Mint op ids as `max(now, max_seen_op_id + 1)`, a monotonic ULID seeded from the
    file, or have `edit` and `delete` name the op they supersede.
  - The backend must ignore a malformed trailing line: a crash mid-append can commit a
    partial line, and union merge will spread it.

### I3. Tool errors fail the whole chat run, and the design has no recovery for a failed live run

- Tool exceptions and model-argument validation errors propagate to the node boundary
  (`tools/registry.py:146-156`; `nodes/agent/modes/tool_calling.py:157`;
  `nodes/agent/conversation.py:655-658`). The AGENT node fails, and so does the chat
  run.
- So v3:531-532 ("the next call fails with a permission error that the model sees") is
  false as written. It also covers `where` violations and a tool-iteration cap hit.
- `ac chat` handles this by restarting the flow (`cli/chat/command.py:5-13`), but the
  design never says what the office does when a live session run fails.
- **Fix:**
  - Per-run wrappers **return** permission and constraint errors as tool results, and
    never raise.
  - The office restarts a failed chat run in the same session, as `ac chat` does.
    `SessionMemory` carries the conversation, and the new run joins the session's run
    chain (K1).

### I4. Feedback prerequisites are unstated

- `backward()` requires the run to have been started with `learnable=True`
  (`run.py:151-152`). The design never says so. Chat, SOP, debrief, and triage runs
  must all be started learnable.
- Backward reopens **every** enabled policy at its recorded snapshot, including
  `session` (`run.py:192-201`). The same holds for resume after an office restart.
  - A fresh in-memory `SessionMemory` "adopts" the snapshot as pristine
    (`memory/session.py:557-559`). After a restart, that loses all conversation after
    session start.
  - So "one `SessionMemory` per session" (v3:348-349) must be a **durable per-session
    SQLite store**, kept as long as the run log can receive feedback.
- A run log is exclusively locked while live, and overlapping backward calls are
  rejected (`docs/api.md:797-800`). Feedback on a session that is still live must
  wait until its run ends; queue it.

### I5. Composer changes are missing for the live view and cost caps

- No node kind streams today: "No node kind returns a generator today"
  (`nodes/base.py:1005-1007`), and `tool_calling` uses a blocking `chat.invoke`
  (`tool_calling.py:97`). So `on_stream` "token chunks" (v3:118-119) never arrive, and
  replies show up only when the node finishes.
- Observer events are node-level only (`events.py:28-125`), with no in-loop model or
  tool events. Office wrappers can synthesize `ToolPart`s for per-run tools, but not
  for text streaming.
- No event or result carries token usage (`events.py`; no `usage` handling in
  `nodes/`). So `Session.cost`, the debrief's `cost`, and the per-run cost cap
  (v3:521-524) cannot be implemented for the composer harness through the public API.
- **Fix:** file generic issues:
  - AGENT token streaming through `on_stream`;
  - an observer for in-loop model and tool calls;
  - per-model-call usage in events.

  Mark which ones M1 needs. At minimum, usage is needed before cost caps, and
  streaming is needed for the M1 polish goal.

### I6. The #324, #326, and #327 specs leave gaps that affect correctness

- **#324 ask_user schema.** The issue lets the host pass `ask_user` as a plain
  `Callable` in `tools=`. Today the trusted fields (`node_id`, `questions`, ...) are
  `InjectedToolArg`s, hidden from the model (`tools/registry.py:178-192`).
  - A host callable with `node_id` or `occurrence` parameters would expose them in the
    model schema. The model could then forge the "authored occurrence path" that gates
    rely on (v3:426-427).
  - The engine must wrap the host's handler with the fixed schema: only `question`
    public, everything else injected.
  - Also, `resolve_tools` must not fall back to the global `TOOL_REGISTRY` for hosts
    that ask for isolation. Otherwise "a tool the person has no grant for doesn't exist
    in their run" (v3:279-280) fails for any globally registered id.
- **#326 cancel outcome.** The issue does not define what `run_flow` returns or raises
  on cancel. Today it would leak the private `_HostStop`.
  - Define a public exception or status.
  - Document that a blocked `ask_user` does not see cancel unless the host's handler
    watches the same event. The CLI does this via `_ControllerStopEvent(broker.cancel_all)`
    (`cli/run.py:433`).
  - Cancel is cooperative: an in-flight model call or tool call runs to completion
    (`tool_calling.py:97,157`). So Esc is not "immediate" (v3:458). The new run must
    wait for the old thread to exit, because `SessionMemory` conversations queue in
    FIFO order (`docs/syntax.md:282-284`).
- **#327 lost steers.** Drain happens only at the top of an iteration. A steer that
  arrives during the final model call of a steerable node is never drained, and the
  next loop iteration's node id differs (`chat#k/…`, `nodes/loop/node.py:11`).
  - The office must move undrained inbox messages to the next turn when the node
    finishes. The rule "queued as the next turn" (v3:457) currently covers only
    non-steerable nodes.
  - Also define what Enter does while the busy agent is blocked in a model `ask_user`
    call: it should answer the question, not steer.

### I7. #329 does not define what happens when two frames in one run use the same notebook instance

- "Every frame that declares `notebook` recalls the whole notebook" (v3:356-358). A
  chat flow with flow-level `notebook` that CALLs an SOP also declaring `notebook` has
  two frames of the same instance.
  - Recall stacks both, so the notebook appears twice in the prompt.
  - Backward aggregates proposals from every frame of a policy
    (`runtime/learning.py:399-405`, `policy_frame_indices`). Both learners see the same
    feedback, so notes are written twice.
- **Fix:** have #329 specify that only the outermost frame of an instance recalls and
  learns, or that proposals are deduplicated per instance.

### I8. The TUI fork is scoped as two files, but the SDK is wired throughout

- v3:93 says to replace `context/sdk.tsx` and `sync.tsx`. But `@opencode-ai/sdk` is
  imported in 26 files, `@opencode-ai/plugin` in 20, and `@opencode-ai/core` in 12.
  About 40 files call `sdk.client.*` (59 distinct endpoints). `package.json` depends on
  `workspace:*` and `catalog:` packages.
- This does not reopen the fork decision. But the M1 plan should budget for vendoring
  or stubbing `core`, `plugin`, and `ui`, and for rewriting the call sites.

### I9 (M2). HQ must enforce what offices push to the canonical repo

- Offices push auto-commits to the canonical repo at HQ (v3:382, v3:619-620). Without a
  pre-receive check, any office can push definition or grant changes directly to main.
  So can any local process with that office's git credentials (K2). That bypasses
  "owner approves the diff" (v3:255).
- **Fix:** HQ accepts office pushes to main only when they change nothing but
  `people/*/notebook.jsonl`, and only by appending lines.

## Suggestions

- The #324 "occurrence path" is likely redundant. LOOP and MAP clones already have
  expanded ids (`L#k/child`, `nodes/loop/node.py:11`; `nodes/ids.py:4-12`), so
  `HumanInputNode` passes an occurrence-unique `self.id` (`nodes/human_input/node.py:90`).
  Verify, then drop the extra field.
- #324 types `tools` as `dict[str, BaseTool | Callable]`, but #325 passes a list under
  `toolbox`. Make the type say so. #325 must also expand groups before the grant check
  at `tool_calling.py:151`.
- Asset tool names collide. Two `slurm_cluster` assets both expose `submit_job`
  (v3:236-244). Define toolbox names such as `cluster_a__submit_job`, within provider
  limits (`[a-zA-Z0-9_-]{1,64}`).
- "Learning pending, retried" (v3:529-530) becomes a **new** attempt under #328, so a
  partially committed attempt can duplicate notes. Retry only attempts that failed
  before any commit request, or rely on the #328 "later attempts see earlier feedback"
  rule, and test it.
- Gate lint needs a way to know which tools are "dangerous" (v3:415-418). Add a
  per-tool `risk: gated` in `assets/*.yaml` before gated SOPs ship.
- Notebook access "by the manager chain" (v3:286-287) includes agent managers. That
  conflicts with "agents' notes come only from `backward()`" (v3:373), unless it means
  human managers only. Say which.
- Pending questions from a model `ask_user` call become orphans when the agent node
  re-runs after a restart. Mark them stale, not open.
- The `chat.yaml` LOOP has `max: 1000` (`cli/chat/chat.yaml:88`). Set an explicit
  limit in `shared/flows/chat.yaml`, and treat reaching it as a normal session end.

## Round-1 issues status

| Round 1 | Status in v3 |
|---|---|
| C1 durable suspension | **Resolved.** Waits block, the office stores `PendingQuestion`s, and a re-run `human_input` re-shows or returns the stored answer (v3:467-475, v3:510-516) |
| C2 global broker, tools, stop | **Resolved in design** via #324/#325/#326. Spec gaps remain (I6: trusted schema, cancel outcome, isolation from the global registry) |
| C3a notebook scope | **Resolved** (#329 instance scope). Two frames of one instance are open (I7) |
| C3b stale snapshots | **Resolved in principle** (append-only, stale writes valid). The snapshot identity under union merge is wrong (I2) |
| C3c one feedback per run | **Resolved** by #328. The new conflict with cancelled runs is K1 |
| C3d home and replication | **Resolved** (company repo, JSONL, `merge=union`, auto-commit). Git mechanics are open (I1) |
| C3e recall outside a run | **Resolved** (`render()` in #329) |
| C3 compaction and learner bounds | **Resolved** (recall-time derived cache; "learner material is bounded") |
| C4 gates vs external harnesses | **Partially resolved.** Scoped to composer SOPs, with authored-only answers and paired-device approval. Credential isolation has no mechanism, and non-gate owner authority is open to local agents (K2) |
| C5 source of truth and sync | **Resolved** (ownership table, metadata vs live channels, ULIDs, conflict rule) |
| C6 OpenCode reuse | **Resolved by decision** (fork). Protocol shapes now match OpenCode's `ToolPart`, Permission, and Question. Fork cost is understated (I8) |
| C7 milestone size and order | **Resolved** (M0 to M3, learning in M1, prerequisite list corrected) |
| S: lint language | Resolved (HQ trusts the office's lint) |
| S: repo distribution | Partially resolved (pull cadence, pinned commits). Checkout mechanics and the M1 remote are open (I1) |
| S: session end | Resolved (`/end`, `ac end`, `idle_end`). The busy-end case feeds K1 |
| S: `SessionMemory` scope | Resolved (one per session). It must be durable (I4) |
| S: stale recall in long runs | Resolved by definition (session-start snapshot; a new run picks up new notes) |
| S: feedback semantics and debrief fields | Resolved (v3:481-485) |
| S: reuse `ReflectiveMemory` | Answered in #329 (scope, stale acceptance, and editing differ) |
| S: cost caps | Partially resolved. A price table exists for harnesses, but the composer harness reports no usage (I5) |
| S: clusters, Tailscale for clients | Resolved (tmux/login-shell fallback; the tailnet requirement is stated) |
| S: `ask_user` not allowed in gate SOPs | Resolved (lint rule, v3:417-418) |

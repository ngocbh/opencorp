VERDICT: NEEDS_REVISION

# agent-corp design review, round 3 (extra)

Reviewed: `agent-corp-design-v4.md` (cited as `v4:<line>`), against agent-composer at
`ca4052c` (paths relative to `agent-composer/src/agent_composer/` unless they start with
`docs/`), issues #324, #325, #327–#331 including the spec-update comments, and #326
(closed).

v4 fixes K1 cleanly. Esc is now node-scoped, `/end` leaves through the flow's exit, and a
whole-run stop kills a process whose log is kill-safe (`runtime/log.py:843`, `:869-881`).
Most of round 2 is resolved. One new problem blocks implementation: the worker process
model added for K2. The sandbox deny list and the credential rule exclude exactly the
files, credentials, and network access that an in-process composer run must use. Its fix
also changes the #329 spec, which is M0. The Important items are small, but several
of them are behavior bugs that the M1 journey would hit.

## Critical (blocks implementation)

### C1. The worker sandbox and credential rules exclude what an in-process composer run needs

v4 runs `run_flow`/`resume_flow` with composer in-process inside the worker
(v4:127, v4:169-172). It also says:

- the sandbox **denies** "run logs, `SessionMemory` files, and the repo clone" (v4:518-519);
- network is allowed "only when a grant allows it" (v4:517);
- "The model and the worker never see credentials" (v4:355), agent processes get a scrubbed
  environment (v4:526), and the test "Credentials never appear in worker memory"
  (v4:681).

The engine needs all of these inside the worker process:

1. **Run log (read-write).** `JsonlRunLog.create` opens the file `O_RDWR|O_CREAT|O_EXCL`
   and takes `flock` (`runtime/log.py:838-843`). Every append fsyncs (`log.py:928-943`),
   and resume truncates the tail (`log.py:869-881`).
2. **SessionMemory SQLite (read-write, plus its directory).** `SQLiteStorage` creates the
   file (`memory/storage.py:149`) and uses `locking_mode = EXCLUSIVE`, a rollback journal,
   and `BEGIN EXCLUSIVE` (`storage.py:167-178`). The journal needs write access to the
   directory. The store is single-owner and must be constructed in the process that uses
   it (`memory/session.py:420-429` rejects handles inherited across a fork), so it can't be
   proxied from the office.
3. **Notebook (read at open, append during backward).** Feedback runs `backward()` in a
   worker (v4:480-485). The #329 JSONL backend is an in-process file backend, and the file is
   `people/<id>/notebook.jsonl` in the office's main working tree (v4:315, v4:447), which
   is the denied repo clone. Even with a hole punched for that one file:
   - The repo lock is held by the office (v4:319), while `git pull` (union merge) rewrites
     the same file. A worker appending during a merge loses ops.
   - Op-id minting as `max(now, largest + 1)` (v4:448) needs that same lock across every
     writer. Writers include concurrent sessions of one person and the office's own host
     methods (v4:459).
   - Provenance ("author id, via …", v4:445-446) would be asserted by the worker, not by the
     reference monitor.
   - The recall-time compaction cache (v4:457) needs a writable location too.
4. **LLM credentials and network.** Provider keys come from the environment
   (`llm_clients/connection.py:78`, `:243-250`) or from
   `~/.config/agent-composer/auth.json` (`llm_clients/auth/store.py:49-53`), which the
   subscription path refreshes. Every model call needs network, with or without a grant.
5. **Pinned definitions (read).** The worker must read flows from the per-commit worktree
   (v4:316-318). v4 doesn't say where worktrees live relative to the denied clone.

As written, an implementer can't build M1 step 2 ("the run worker, the sandbox … and the
per-run channel", v4:737), and #329 would ship a storage shape agent-corp can't use.

**Fix (small, and keeps every owner decision):**

- **Per-session directory.** The office owns one directory per session, holding that
  session's run logs and `session.sqlite`. The session's workers get read-write access to
  it. Worktrees live outside the clone and are readable. The deny list becomes "every
  other office path".
- **#329 storage protocol (M0).** Specify a minimal host-suppliable storage interface,
  such as `load_ops()` and `append_ops(ops) -> minted ids`. JSONL-file and SQLite become
  two implementations of it. agent-corp's worker passes a proxy that forwards ops over
  the per-run channel. The office then stamps provenance, mints op ids and appends under
  the repo lock, and auto-commits. So the office is the only writer, which also settles
  multi-process safety. Post this on #329 before its PR starts.
- **LLM access.** Pick one and update v4:355, v4:526, and v4:681:
  - (i) The worker receives a provider token over the channel at start and may reach the
    network. State that the token is the one credential a worker holds, and don't run
    model-directed shell code in the worker's own process (see I1).
  - (ii) The office runs a model proxy. Clients accept `base_url` (`llm_clients/factory.py:54-121`).
    The worker then holds no credentials and needs no general network. The proxy also
    meters usage and can refuse calls over the cost cap, a harder cap than an interrupt at
    safe points. It costs a proxy that has to handle provider streaming.

## Important

### I1. Workspace file and shell tools have no home (round-2 K2 item 4 is still open)

- Every run tool is "a small stub … that forwards the call to the office", and "the office
  … executes" it (v4:172-174). Yet the sandbox grants the worker "the session's workspace
  (write)" (v4:516), and nothing running in the worker writes the workspace.
- If the office executes a shell tool, the tool runs unsandboxed as the owner. That is
  the K2 hole again. Composer ships no tools (`tools/registry.py:7-8`), and M1 plans
  "dogfooding with Minh on real repos" (v4:750).
- **Fix:** define workspace tools (read, write, edit, shell) as an asset kind (for example
  `local_folder`) granted per person and folder. They must execute inside a sandbox under
  `harness_policy`:
  - in the worker, if C1 option (ii) keeps credentials out of it;
  - otherwise in a per-call sandboxed subprocess that the office starts, with no
    credentials.

### I2. Esc, `/end`, and `idle_end` hang while the reply is waiting in a model `ask_user`

- #327 checks interrupts only at the loop's safe points, and "a running tool finishes"
  (v4:787; `nodes/agent/modes/tool_calling.py:136-177`).
- A model `ask_user` is a tool call that blocks until someone answers. If the user is away,
  `idle_end` fires, and "interrupting a busy reply first" (v4:590-591) never completes. So
  the session never ends. Long office tools (for example `submit_job`) likewise delay Esc.
- **Fix (office-only, no engine change):**
  - On interrupt or end, the office completes that run's in-flight office-side tool calls,
    at least `ask_user`, with a tool result such as `[interrupted by the user]`.
  - It marks the PendingQuestion `stale`.
  - The safe point after the tool call then fires immediately.

### I3. The #327 interrupt spec conflicts with how conversations are recorded

- **"After a model call: drop the reply."** `invoke_model` persists the reply to the
  SessionMemory turn **before** its stop check (`nodes/agent/conversation.py:529`,
  `:564-565`).
  - So the next turn's model sees the "dropped" reply.
  - Any tool calls in it are projected as "Tool result unavailable; execution outcome
    unknown (status: unrecorded)" (`conversation.py:276-285`). That's false: they never
    ran.
- **"The saved conversation ends with an `[interrupted by the user]` note."** Retained
  items must belong to a model exchange. `_history_messages` raises "retained message has
  no model exchange owner" (`conversation.py:225`), and no API appends a free-standing
  note. The machinery already exists, though:
  - `ConversationTurnStatus` includes `interrupted` (`memory/contracts.py:1766`);
  - the projection renders non-completed invocations as a "Session history status"
    context note (`conversation.py:288-309`);
  - but `_Turn._finish` closes the turn as `completed` whenever the body returns normally
    (`memory/session.py:1433-1438`).
- **"Returns the text it has so far."** The model call is a blocking `chat.invoke`
  (`tool_calling.py:97`, `:102`), so the current call has no partial text. Esc waits for a
  full model call plus the running tool. Meanwhile the TUI has shown streamed tokens
  (#331) that the record then drops (v4:568).
- **Fix (edit the #327 comment):**
  - Keep the persisted reply. If it has no tool calls, return it as the answer. If it has
    tool calls, record each skipped call as a tool effect with status `interrupted`.
  - Close the turn with the existing `interrupted` status through a small turn-level
    method, instead of a synthetic message.
  - Once #331 streams, make the stream loop a safe point and persist the partial
    `AIMessage` as the reply. Then "partial text" is exactly what the user saw, and Esc is
    immediate.
  - Update the §6 #327 tests to match.

### I4. Reaching the loop `max` fails the run, so the session restarts instead of ending

- A `while` loop that exceeds `max` raises `LoopMaxExceeded` and the run fails
  (`nodes/loop/node.py:38-42`, `:154-159`).
- v4 says reaching it "ends the session normally" (v4:428, v4:589-592). But v4:631
  restarts failed chat runs, so the session keeps going in a new run. This round-2
  suggestion was adopted with the wrong mechanism.
- **Fix:** the office counts turns from `on_event` and answers the N-th `human_input` with
  the exit command. Keep the loop's `max` above N as a backstop, and treat
  `LoopMaxExceeded` as an end, not a restart.

### I5. Feedback must wait for the whole session, not only the target run

- `SQLiteStorage` is single-owner, with a non-blocking exclusive lock (`storage.py:167-178`).
  `backward()` reopens every enabled policy at its snapshot, including `session`
  (`run.py:192-201`).
- A failed chat run "is finished (failed), so it can still take text feedback"
  (v4:634-635). But the session's restarted run holds `session.sqlite`, so backward
  fails with `storage.busy`.
- **Fix:** queue feedback per **session** until no run of that session is live (v4:478-479,
  v4:596).

### I6. Orphaned workers block resume

- After an office restart, v4 starts a new worker and resumes (v4:622-623). If the old
  worker is still alive, resume fails. That can happen after an office crash, or under the
  tmux or login-shell fallback (v4:742-743).
  - The run log `flock` is `LOCK_NB` (`log.py:869`).
  - SQLite uses `timeout=0` (`storage.py:167`).
- "Kill now, resume later" has the same race unless the office waits for the killed process
  to exit.
- **Fix:**
  - A worker exits when its channel closes.
  - The office records worker pids (or process groups), then kills and reaps them before
    any resume.
  - An inherited `socketpair` channel gives the EOF signal for free (see Suggestions).

### I7. Notebook JSONL: partial-line repair and op-id collisions (I2 is only partly fixed)

- **Partial lines.** "A malformed trailing line is ignored" (v4:453) isn't enough.
  - The next append concatenates onto the partial line, which corrupts the new op too.
  - Union merge can move a partial line into the middle of the file.
  - **Fix:** under the repo lock, the writer terminates or truncates a partial trailing line
    before appending, as `JsonlRunLog.resume` does (`log.py:869-881`). The fold skips any
    malformed line, not only the last one.
- **Op-id collisions.** `max(now, largest + 1)` (v4:448) is deterministic in exactly the
  clock-skew case it exists for. Two offices holding the same largest id both mint
  `largest + 1`. After union merge, "duplicate op ids are ignored" (v4:451), so one op is
  silently dropped. This bites only from M2, but the rule ships in #329 at M0.
  - **Fix:** mint the time part as `max(now, largest) + 1` plus a random or writer-id
    suffix, and dedupe only byte-identical lines. Alternatively, `edit` and `delete` name
    the op they supersede.

### I8. The one-notebook-frame lint breaks learning in standalone SOPs

- v4 lints "exactly one frame per run" declaring `notebook` (v4:432-433). It also says an SOP
  called from a chat "doesn't declare `notebook` itself" (v4:437).
- SOPs also run on their own as tasks and routines (v4:434-438, v4:574-575). Such runs then
  have no notebook frame, so no recall and no learning. That contradicts "improvements
  from feedback" (v4:436).
- #329's "only the outermost frame of an instance recalls and learns" (v4:442-443) already
  handles nesting generically.
- **Fix:** drop the lint, and let every flow that needs notes declare `notebook`. This is
  also the simpler rule.

## Suggestions

- **Simpler worker channel.** Use an inherited `socketpair` fd instead of a socket path
  plus a secret (v4:521-525). There's no path to allow in the sandbox and no secret to
  mint, and EOF means the office is gone (I6). Keep the secrets for the external-harness
  MCP endpoints.
- **Transcript source for the debrief.** Observers are published after the log fsync, and
  resume replays history silently (`docs/api.md` resume section). So a kill between those
  two steps leaves a gap in the office's Message/Part store. Say which source the debrief
  of a killed run uses (v4:636), or reconcile on resume.
- **Steer delivery.** Make `inbox.drain` a synchronous call to the office, so the office
  knows exactly which steers were delivered and which move to the next turn (v4:567).
- **Model `ask_user` has no node id.** Only `HUMAN_INPUT` injects `node_id`
  (`nodes/human_input/node.py:83-92`); a model call passes `question` alone. Keying by
  `(run_id, node_id)` (v4:581-582) therefore doesn't cover model questions. On resume, mark
  all of the run's open model questions stale, or have #324 inject the calling node id.
- **Engine-side tool errors still fail the node.** An ungranted tool name
  (`tool_calling.py:151-155`) and schema validation of arguments (`tools/registry.py:136-143`)
  both raise before the host wrapper runs. The chat restart covers chats, but SOPs fail.
  Either soften "never as an exception" (v4:352-353) or add a #324 option that returns
  these as tool results.
- **SessionMemory write cost.** Every request, observation, and close rewrites the whole
  session state as one JSON blob with `synchronous = EXTRA`, after a full revalidation
  (`session.py:916-922` → `storage.py:275-300`). Long live sessions are O(n²). Measure
  during dogfooding; incremental storage would be a generic engine fix.
- **Persona input.** The shared `chat.yaml` needs the persona as a flow input until
  `system_prompt:` (#259) exists. Say so.
- **Cost cap in chat.** After the cap interrupts a reply (v4:641-642), hold further turns
  until the cap is raised. Otherwise every new turn spends again.
- **`run_ids[]` wording.** v4:387-388 says killed chat runs are "restarted", but §5 resumes
  them under the same run id (v4:622). Align the two.
- **#329 commit idempotency.** State that commits are idempotent by `commit_id`, as
  SessionMemory's `applied_commits` are, so a retried attempt can't double-append.
- **M1.5 spike.** Also check that Codex with network off can still reach the office MCP
  endpoint.

## Round-2 issues status

| Round 2 | Status in v4 |
|---|---|
| K1 stopping vs feedback | **Resolved in design.** Node-scoped interrupt (#327 comment), exit through the flow, kill-and-resume for whole runs; the engine's kill safety is verified (`log.py:843`, `:869-881`). Gaps: I2 (hang on a model `ask_user`), I3 (interrupt vs recording), I4 (loop `max`) |
| K2 local trust boundary | **Partially resolved.** Sandbox for every agent process, office-side privileged tools, owner-only socket, per-session MCP secret. The worker's deny and credential rules contradict what it must do (C1), and workspace tools are undefined (I1) |
| I1 git layout | **Resolved.** Read-only worktrees per commit, notebooks in the main tree, one repo lock, no remote in M1, owner-started changes count as approved. Worktree placement relative to the sandbox: C1 |
| I2 notebook op ids | **Mostly resolved.** Op-id-set snapshots are right. Partial-line handling and cross-office id collisions remain (I7) |
| I3 tool errors | **Resolved** for permission and constraint errors, plus chat restart. Engine-side validation still raises (Suggestions). The restart rule interacts badly with the loop `max` (I4) |
| I4 feedback preconditions | **Resolved** (`learnable=True`, durable SessionMemory, live-run queue). The single-owner store widens the queue to the whole session (I5). Reopening a past snapshot of a grown store works (`session.py:529-585`, prefix check) |
| I5 streaming and usage | **Resolved.** #331 filed for M0. Its interplay with interrupt: I3 |
| I6 issue spec gaps | **Resolved.** #324 comment (fixed schema, registry fallback off, groups, occurrence); #327 comment (late steers, model `ask_user`); #326 closed |
| I7 one notebook, two frames | **Resolved** in #329. The extra agent-corp lint is harmful (I8) |
| I8 TUI fork scope | **Resolved** (inventory, SDK-shaped client, vendoring budget) |
| I9 HQ push check | **Resolved** (pre-receive: appends to `people/*/notebook.jsonl` only) |

VERDICT: APPROVED

# agent-corp design review, round 4

Reviewed: `agent-corp-design-v5.md` (cited as `v5:<line>`), against agent-composer at
`ca4052c` (paths relative to `agent-composer/src/agent_composer/` unless they start with
`docs/`), and issues #256, #324, #325, #327, #328, #330, #331 (plus #326 and #329, both closed).

Owner decision A resolves C1 cleanly. Workers are trusted, so they need no sandbox holes,
and every engine requirement listed in C1 (run log, SQLite, provider keys, worktrees) is
now satisfied by construction. The v5 line citations I checked are accurate:
`runtime/log.py:843`, `:869`, `memory/storage.py:167`, `run.py:479`,
`runtime/backward.py:221-223`, `memory/contracts.py:1766`. Nothing blocks M0 or M1, so this
review has no Critical items.

The Important items cluster in three places:

- the workspace sandbox boundary, which is now the only thing between model-controlled
  code and the owner's account;
- the `local_folder` grant model;
- how `ProfileMemory` maps onto the engine's memory contracts and onto git.

Most need a sentence or two in v5, or an issue edit. Three have a simpler alternative.

## Critical (blocks implementation)

None.

## Important

### I1. The workspace sandbox is specified as a deny list; decision A needs default-deny

Under decision A, the workspace sandbox is the only barrier between model-written shell
code and an unsandboxed process running as the owner. v5 specifies it as "allows the
workspace (write) … denies the office socket, the office store, secrets, run logs,
`SessionMemory` files, and the repo clone" (v5:548-550). The §6 sandbox test checks only
those names (v5:714-716). A deny list leaves these paths open:

- **Provider keys.** They are in `~/.config/agent-composer/auth.json`
  (`llm_clients/auth/store.py:48-52`, also refreshed there) or in the worker's
  environment (`llm_clients/connection.py:53`, `:78`). v5:557 says workers hold them, but
  the sandbox doesn't deny the file. On Linux, a same-uid process can also read
  `/proc/<worker pid>/environ` unless the sandbox has its own pid namespace.
- **Escapes to unsandboxed execution.**
  - The tmux server socket, when the office runs under the tmux fallback (v5:777-778):
    `tmux send-keys` runs commands outside the sandbox.
  - LaunchServices and Apple Events on macOS (`open`, `osascript`), and the D-Bus user bus
    on Linux (`systemd-run --user`).
  - Any of these gives full owner access, including the office secret store.
- **General credentials**: `~/.ssh`, `~/.aws`, `~/.codex`, and browser profiles. They are
  readable, and with a network grant they can be sent out.
- **The worker's own import path.** CODE nodes import `module:function` at run time
  (`nodes/code/node.py:342`), and `python -m` puts the cwd first on `sys.path`. If a worker
  starts with cwd set to the session workspace (the Session has a `cwd`, v5:419), a
  model-written `foo.py` in the workspace can shadow a lazily imported module and run
  inside the trusted worker.

**Fix:**

- **Sandbox profile.** Make it default-deny, like Codex's Seatbelt profile. Allow only:
  - the workspace (read-write);
  - system and toolchain paths (read-only);
  - a private temp directory;
  - network only when `harness_policy` allows it.
- **Process and IPC access.** Deny `process-info`, mach-lookup, and Apple Events except
  a minimal allowlist.
- **Linux.** Use bubblewrap with new mount and pid namespaces, binding only the allowed
  paths. Landlock alone does not isolate `/proc` or pathname unix sockets reliably.
- **Workers.** Start them with cwd set to their session directory, never the workspace,
  and run Python with `-I` (or `-P`).
- **Tests.** Change the §6 sandbox test to "nothing outside the allowlist is readable",
  plus explicit checks for `auth.json`, a tmux socket, and `/proc/*/environ`.

### I2. The per-session sandbox server is underspecified; a per-call sandbox is simpler

v5 runs "a sandboxed subprocess per session" (v5:106, v5:121, v5:544-545). It leaves four
questions open:

- **Routing.** Is the path worker → sandbox, or worker → office → sandbox? v5:175-176 says
  tools "forward to the session's sandbox". v5:386 says calls go there "after the same
  grant check and audit", which only the office can do.
- **Channel trust.** Model-controlled shell code runs in the same sandbox as the tool
  server, so it can take over the server's channel. Whatever the office accepts on that
  channel must be treated as untrusted: tool results only, never asset calls, profile
  writes, or lock requests.
- **Interrupt.** I2 answers in-flight `ask_user` and "office-side" tool calls
  (v5:43-45, v5:595). A workspace `shell` running `pytest` or `sleep 3600` is neither, so
  Esc, `/end`, and `idle_end` wait for it, which is round-3 I2 again.
- **Cleanup.** Background processes started by `shell` (`nohup`, `setsid`) outlive calls
  and sessions. Seatbelt has no pid namespace.

**Simpler option (recommended):** run each workspace tool call as its own sandboxed
subprocess, started by the office after the grant check. The office can use
`sandbox-exec -p … <helper>` or `bwrap --die-with-parent --unshare-pid …`.

- The office owns the only channel: the child's stdio for that one call.
- Interrupt and timeout mean killing that call's process group.
- Cleanup is per call.
- Nothing is long-lived, so there is no server lifecycle, no session-start step
  (v5:583), and no channel to trust.

The cost is tens of milliseconds per call, which is noise next to a model call. Codex
already runs each command fresh. If a persistent session is kept anyway, v5 should
state routing through the office, the untrusted channel, kill-on-interrupt for running
workspace calls, and process-tree cleanup at session end.

### I3. `local_folder` assets conflict with the office-store folder association and add M1 friction

- **Contradiction.** v5:360-361 says "Which folders belong to which person is
  machine-specific, so it lives in the office store, not the repo". But `assets/longhstu.yaml`
  puts a machine path and per-person grants in the repo (v5:328-337). "Resolved per office"
  means the same grant covers different directories on the laptop and on a cluster login
  node (M2 and later).
- **Unspecified behavior.** v5 doesn't say:
  - whether `path` must equal the session's cwd or contain it;
  - what happens when the owner picks a person who has no grant for the cwd. Does the
    session get no workspace tools silently?
- **Friction.** The M1 journey's first step, "make him edit a file" (v5:737), needs an
  asset file with a grant. Each new folder is a definition change (diff and confirm in
  M1, branch approval in M2) before the first prompt can edit anything.

**Simpler option:** in a session the owner starts from `ac` in a folder, that folder is
the workspace. The owner's choice is the grant, the way a user running a program in a
directory is. `harness_policy` decides write and network. The office store keeps the
folder association for the picker. Keep `local_folder` assets only for work that isn't
started from a folder (routines, delegation, M3). This removes a repo concept from M1 and
the contradiction with v5:360-361.

### I4. Say where `profile` and `session` are declared; the choice decides whether feedback reaches the profile

- **One declaration each.** A flow or AGENT has exactly one `long_term_memory:`
  declaration (`docs/syntax.md:225-264`). The main flow can't declare both `session` and
  `profile` "on the flow" (v5:463-466).
- **Placement matters.** Whole-run feedback on a chat reaches only frames on the
  feedback's path:
  - Every reachable node gets a memory scope (`compile/memory_layout.py:567-571`).
  - The feedback message is recorded as an `output` channel entry for each scoped
    occurrence it reaches (`runtime/learning.py:1145-1153`).
  - The CODE node `normal_turn` has no `backward` and stops transfer
    (`nodes/base.py:1082-1104`; `cli/chat/chat.yaml` shape).
  - Leftover root feedback goes only to the root flow frame (`runtime/learning.py:1296-1297`).
  - So a `profile` frame declared on the reply AGENT would never see chat feedback.
- **Fix:** state "`profile` on the root flow, `session` on the reply AGENT". Conversation
  continuity across a restarted run still holds, because `ConversationKey` is
  `(frame_ref, consumer_static_path)` with no run id (`memory/contracts.py:1614-1634`).
- **Debrief.** Also state that `debrief.yaml` declares `profile` at its root. Feedback on a
  Codex or Claude session can only target the debrief run (principle 3, v5:84-86), and
  without that declaration it never reaches `profile.md`.

### I5. `ProfileStore`: version identity, hand edits, who writes, and the re-apply loop

`resume_flow` requires each memory session to reproduce the exact `RunStarted` snapshot
(`runtime/memory_runtime.py:370-381`; `docs/api.md` "Durable recovery"). So the recorded
version must reproduce the same text for as long as the run log lives. v5:482-488 leaves
four things open:

- **Version identity.** Use the git **blob id** of `people/<id>/profile.md`, not a commit
  sha.
  - With commit shas, every unrelated commit (another person's profile, a definition
    change) would look like a stale version and trigger a needless model re-apply.
  - An M2 `pull --rebase` would rewrite local commit shas that run logs recorded.
  - Blob ids are per file and survive rebase.
- **Hand edits.** "Humans may edit directly … by hand" (v5:493-494). A dirty working-tree
  edit has no committed version: the text the run sees and the version it records
  disagree, and a later auto-commit sweeps the edit in. Either route hand edits through
  the store (`ac profile edit @minh` opens `$EDITOR` on a copy and calls `write`), or
  auto-commit a dirty `profile.md` before any `read`.
- **The office is the only writer.** v5:350-351 has workers "request" the repo lock over
  their channel, which reads as leasing the lock to a worker that then writes the file.
  That needs lock release on EOF and a worker writing into the clone. Instead:
  - the worker's `ProfileStore` is an RPC stub;
  - the office does the compare-and-swap, writes the file, and commits under its own lock;
  - it returns the new version, or a mismatch with the current text and version.
- **Re-apply loop.** "The learner re-applies its edit" (v5:485-486) is a model call made
  inside `MemorySession.commit()` (`memory/contracts.py:1591-1598`), after the proposal
  was recorded. It must:
  - not hold the repo lock during the model call;
  - be bounded (for example, 3 tries, then `learning failed`).

**Simpler option:** the learner reads the current text (`read(None)`) in `learn()`, next
to the snapshot text it was trained on. `commit()` is a plain compare-and-swap. On a
mismatch the commit fails, and the office retries with a new `backward()` attempt (#328,
bounded). Then composer's `ProfileMemory` has no model call in `commit`, and the M2 case in
I6 uses the same path.

### I6. The M2 push-race "re-apply" has no mechanism (M2, not M0/M1)

v5:487-488 says that when a push to HQ loses a race, "the office pulls, and the learner
re-applies". By then the backward attempt has finished and the worker is gone, so no
learner is running. Re-applying would need a model call in the office outside
`backward()`, which contradicts v5:492.

**Fix:** when the office is online, make the push part of `write`:

1. fetch;
2. compare-and-swap against the fetched tip;
3. commit and push;
4. on a rejected push, reset and report a mismatch.

When it's offline, a pull that conflicts on reconnect drops the local profile commit and
re-queues the feedback as a new attempt. Use `pull --rebase` so the pre-receive check
(v5:358-359) sees only profile diffs.

### I7. #256's body and #327's comment still carry the old specs

- **#256.** The body is still the original plan:
  - structured facts with deterministic identities;
  - frame-local entries;
  - "keep flow inheritance and agent-local isolation exactly as defined by #46; each frame
    may read its stack but writes only itself".

  The agent-corp comment requires a single markdown document scoped to the instance,
  with outermost-frame-only recall and learning, stale-snapshot commits, and host
  methods. These contradict the body on form and scope.

  The comment is implementable on the current contracts:
  - all frames open at run start (`runtime/memory_runtime.py:331-345`), so a session can
    find the outermost frame by static path;
  - the inner frame's `recall` returns `""`;
  - its `learn` returns `[]`.

  But a PR author reading the body builds the wrong thing. Rewrite the body before the
  M0 PR starts. Also say what `reset()` (a required `Memory` method,
  `memory/contracts.py:1608`) means for a git-backed document, for example "not
  supported", and specify the budget (see Suggestions).
- **#327.** The only spec comment still says "after a model call: drop the reply" and "ends
  with an `[interrupted by the user]` note". Both contradict the engine (round-3 I3) and
  v5 §8 (v5:824). It also has `drain(node_id, occurrence)` in the body and `drain(node_id)`
  in the comment. The owner's memory work may change the recording details, but the issue
  should not ship the known-broken version. Add a comment matching v5:824.

### I8. Codex and Claude "fully sandboxed" can't reach their own model (M1.5)

v5 sandboxes the Codex and Claude processes with network "only when a grant allows it"
and a scrubbed environment (v5:546-557), with `harness_policy: {network: false}` by
default (v5:277). These processes call their model provider themselves, so they need
network to it and their own credentials (`~/.codex/auth.json` or a key). This is C1's
problem again, for harnesses.

**Fix:** pick one for the M1.5 spike:

- The outer sandbox always allows the provider endpoint and the harness's auth file.
  `harness_policy.network` then governs only command execution, through the harness's own
  sandbox.
- Or treat the harness process like a worker, trusted with its own provider auth, and
  rely on its built-in sandbox for commands. This is only acceptable if the spike shows
  that sandbox can deny the office paths, which v5 already asks the spike to check.

## Suggestions

- **Interrupt answers only model questions.** Answer only in-flight `ask_user` calls with a
  null `node_id`, never a `human_input`. If Esc races with the end of a reply, the next
  turn's `human_input` would otherwise get `[interrupted by the user]` as a user message
  and start a new reply to it.
- **Interrupted asset tools.** When the office answers an asset tool call early, the side
  effect (for example `submit_job`) may still happen. Say "interrupted; outcome unknown",
  or let calls with side effects finish.
- **Durable turn count.** `resume_flow` publishes no replay events (`docs/api.md`:
  `recovered.events == []`, "events contains only forward observers published in the
  current call"). A count kept from `on_event` therefore resets after a worker restart.
  Count the session's answered chat `human_input` PendingQuestions in the office store
  instead. The office already serves them, so it doesn't need `on_event` for this.
- **Serialize every worker of a session.** That includes forward runs, resumes, and
  backward attempts. Two queued feedback items on one session would otherwise race for the
  single-owner SQLite store (`memory/storage.py:167`, `timeout=0`). v5:507-510 says "no run
  of that session is live". Make backward workers count as live.
- **Worker exit.** EOF on the socketpair is seen only by a reader. Add a watchdog thread
  that exits on EOF, because a worker blocked in a model call never reads the channel.
  Kill leftovers by process group, and check the process start time to avoid pid reuse.
- **Profile budget.** Give a number and the behavior when a human edit exceeds it. Don't
  truncate silently, because that drops role text. Warn in the profile view, and let the
  next backward compact.
- **Learner input budget.** The root frame's `LearnContext` has an episode for every scoped
  occurrence in the run, including LOOP, CODE, and `human_input` (`runtime/learning.py:1264-1297`).
  The bundled chat shape also passes a growing `transcript` to every turn
  (`cli/chat/chat.yaml`), so a 500-turn chat feeds the learner O(n²) text. Drop
  `transcript` from agent-corp's `chat.yaml`, since `SessionMemory` carries the
  conversation, and have the learner use only AGENT interactions within a budget.
- **Recall wording.** Recall runs on every AGENT invocation against the run's snapshot
  (`memory/contracts.py:1548`, `runtime/memory_runtime.py:451-502`), not "when the outermost
  frame opens" (v5:477). A chat restarted after a failure opens a new snapshot, so it may
  see a newer profile mid-session. That's harmless, but v5:495 should say "run start".
- **Protect workspace hooks.** Make `.git/hooks` and `.git/config` read-only in the workspace
  sandbox. Otherwise model code can plant hooks that the owner later runs unsandboxed.
  Codex does the same in workspace-write mode.
- **Network source.** v5:548 says "network only when a grant allows it", and person.yaml has
  `harness_policy.network`. Name one source of truth.

## Round-3 issues status

| Round 3 | Status in v5 |
|---|---|
| C1 worker sandbox vs engine needs | **Resolved** by decision A (v5:32-42, v5:167-170). Workers own the run log, `SessionMemory`, and provider keys, so there are no sandbox holes. Credential statements are updated (v5:388, v5:555-557, v5:712-713). Residual: the sandbox boundary that decision A now depends on (I1). Harnesses have the same problem (I8) |
| I1 workspace tools have no home | **Resolved in design** (workspace tool sandbox, `local_folder`). Gaps: routing, channel trust, interrupt, and cleanup (I2); the grant model (I3) |
| I2 hang on `ask_user` | **Resolved** (v5:43-45, v5:595, v5:618-620). Long workspace shell calls are still uncovered (I2). Restrict the answer to model questions (Suggestions) |
| I3 #327 vs recording | **Resolved in v5 text** (v5:824, §6 tests). The #327 issue comment is not updated (I7) |
| I4 loop `max` | **Resolved** (v5:461-462, v5:662-663; `LoopMaxExceeded` is distinguishable by `cause_type`, `nodes/loop/node.py:40-44`). Make the turn count durable (Suggestions) |
| I5 per-session feedback queue | **Resolved** (v5:507-510). Also serialize backward workers (Suggestions) |
| I6 orphaned workers | **Resolved** (v5:164-166, v5:187-189). EOF watchdog and pid reuse (Suggestions) |
| I7 notebook partial lines and op ids | **Moot**: the notebook is gone (#329 closed) |
| I8 one-frame lint | **Resolved**: the lint is dropped. The outermost-frame rule is implementable on the current contracts (I7). Declaration placement needs stating (I4) |
| Suggestion: socketpair channel | Adopted (v5:164-166) |
| Suggestion: debrief transcript source | Adopted (v5:667-668) |
| Suggestion: synchronous steer drain | Adopted (v5:180-182) |
| Suggestion: model `ask_user` has no node id | Adopted: stale on resume (v5:613-614) |
| Suggestion: engine-side tool errors | Moved to open questions (v5:853-855) |
| Suggestion: `SessionMemory` write cost | Open question (v5:858-860) |
| Suggestion: persona input | **Moot**: the profile is recalled into the system message (`docs/agent.md:212`) |
| Suggestion: cost cap in chat | Adopted (v5:672-673) |
| Suggestion: `run_ids[]` wording | Adopted (v5:420-422) |
| Suggestion: commit idempotency | Adopted (v5:484). Implement it in the office-side write (I5) |
| Suggestion: M1.5 spike | Adopted (v5:790-793). Add provider access for the harness itself (I8) |

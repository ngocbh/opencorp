# Third-party notices

OpenCorp is MIT-licensed (see `LICENSE`). It includes or adapts code and designs from the
projects below. Their licenses ask that their copyright and permission notices travel with the
parts we use, so each one is listed here with what we took and where it lives.

When you copy or substantially port code from another project, add an entry: the project, its
license, the upstream paths and commit, and our paths.

## OpenCode

- **What:** the terminal UI in `packages/tui` is forked from OpenCode's TUI.
- **Upstream:** https://github.com/anomalyco/opencode (formerly `sst/opencode`). The fork's base is commit `b471c2b`
  (`packages/tui`, `@opencode-ai/tui` 1.18.32).
- **Restored from the fork's base:** `packages/tui/src/context/permission.tsx` (upstream
  `packages/tui/src/context/permission.tsx` at `b471c2b`), adapted to hold each session's mode and open approval cards
  as the office holds them; and `packages/tui/src/routes/session/permission.tsx` (upstream
  `packages/tui/src/routes/session/permission.tsx` at `b471c2b`), the permission prompt, adapted to answer the office's
  approval cards, to be read whole before any choice, and to start on No.
- **Ported from current upstream:** `packages/tui/src/util/permission.ts`, the titles and bodies per tool and the
  "always" page's lines, from `permissionPresentation` and `permissionAlwaysLines` in upstream
  `packages/tui/src/util/permission.ts`, read at commit `df46f69` (2026-11-16), cut to the office's tools.
- **License:** MIT, "Copyright (c) 2025 opencode". The full notice is in `packages/tui/LICENSE`.
- **What:** the bash command lines that the shell scanner's tests read (here-documents, `$'…'`, parameter and
  arithmetic expansions, compound commands, functions), copied as test fixtures for the permission reader. The
  reader itself is our own.
- **Upstream:** `packages/core/test/shell-parse-syntax.test.ts`, read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/office/tests/runtime/permissions/commands.test.ts`.
- **What:** the escape-sequence cases in the test of a shell's model view (colors, cursor moves, erases, C1 CSI, and
  OSC with each terminator), copied from `packages/session-ui/src/tools/ansi.test.ts`. The parser they test is ours.
- **Upstream:** https://github.com/anomalyco/opencode, read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/office/tests/tools/terminal/output.test.ts`.
- **What:** the reply rules of its permission requests, as a design: a reject answers the session's other pending
  requests with the same feedback, and an "always" re-checks them and lets through those the new rule allows. The
  chat's approval cards follow both; the code is our own.
- **Upstream:** `packages/core/src/permission.ts` (`reply`), read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/office/src/features/chat/session_actor.ts` (`#cardAnswered`, `#recheck`).
- **What:** its saved permissions, as a design: a list of the saved rules and a removal of one
  (`permission.saved.list` and `permission.saved.remove`), and a save that skips a rule already saved. A chat's
  `/rules` lists its rules and removes one the same way; the code is our own, and the rules live in the company repo
  rather than a table.
- **Upstream:** `packages/protocol/src/groups/permission.ts` and `packages/core/src/permission/saved.ts`, read at
  commit `df46f69` (2026-11-16).
- **Ours:** `packages/office/src/company/rules.ts`, `packages/office/src/server/routes/rules.ts`,
  `packages/tui/src/routes/session/dialog-rules.tsx`.
- **What:** its terminals' output and size, as a design: output carries an absolute offset from the terminal's
  start, so a client joining late takes the kept output up to an end offset and then only the live bytes past it,
  with nothing lost or applied twice; the server keeps each terminal's last output in memory (`BUFFER_LIMIT`) for
  that; a terminal's size is part of what is listed, so every viewer draws at it; and one client controls a
  terminal's size. An instrument's events and its screen follow these, over the event stream and plain requests
  rather than a WebSocket, with the kept output starting at a line and only the session's approver typing or
  resizing; the code is our own.
- **Upstream:** `packages/core/src/pty.ts` (`attach`, `BUFFER_LIMIT`), `packages/core/src/pty/protocol.ts`,
  `packages/schema/src/persistent-pty.ts` (`Info.size`, `Info.output`) and `packages/process-daemon/SPEC.md` (one
  controller per terminal), read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/protocol/src/schemas/instruments.ts`, `packages/client/src/client.ts`
  (`sessions.instrumentScreen`), `packages/office/src/runtime/sessions/instruments.ts`,
  `packages/office/src/server/routes/instruments.ts`.
- **What:** its shell tool, as the model sees it, as a design: one permission request per call, covering all of the
  call's commands; a reply within two minutes by default, the command still running past it rather than killed; its
  prompt's "DO NOT poll", with its advice to quote paths that hold spaces or special characters and to prefer a
  dedicated tool over a shell command; and a call that is stopped stopping its own command, replying once it has
  ended or after a short wait, while a command its reply left running goes on. The terminal tools' gate, descriptions
  and stops follow these; the code is our own.
- **Upstream:** `packages/core/src/tool/plugin/shell.ts` (`description`, `DEFAULT_TIMEOUT_MS`,
  `BACKGROUND_INSTRUCTION`, `prepare`'s `permission.assert`, and `cancelled` with `INTERRUPT_WAIT`), read at commit
  `df46f69` (2026-11-16).
- **Ours:** `packages/office/src/tools/terminal/tools.ts`, `packages/office/src/tools/terminal/terminal.ts`.
- **What:** a background command's end, as a design: a command still running past its reply goes on, and its end is
  told to the session once, as a message holding its exit code and its last lines, which a running turn reads at its
  next step and which wakes a session at rest; its shell tool's wording that the model will be told and must not
  poll, but end its reply when it has nothing else to do; and the TUI's one line for that end, `↳` in the info colour.
  The terminal's notes and the session's delivery are our own code; the TUI's line is ported from
  `SessionNoticeMessageV2`, opening the note where upstream jumps to the call.
- **Upstream:** `packages/core/src/tool/plugin/shell.ts` (`BACKGROUND_INSTRUCTION`, `notify`),
  `packages/core/src/shell/result.ts` (`notification`), `packages/core/src/session/session.ts` (the synthetic message
  and its wake) and `packages/tui/src/routes/session/index.tsx` (`SessionNoticeMessageV2`), read at commit `df46f69`
  (2026-11-16).
- **Ours:** `packages/office/src/tools/terminal/terminal.ts`, `packages/office/src/tools/terminal/tools.ts`,
  `packages/office/src/features/chat/session_actor.ts` (`note`), `packages/tui/src/routes/session/note-line.tsx`.
- **What:** the line under the prompt keeps the fork's layout: the spinner and `esc interrupt` (or the folder) on the
  left, the shortcuts on the right. What the chat has running follows the left side (the picker's count, below), and
  what waits for the owner takes the shortcuts' place in the warning colour, as the fork's session footer showed its
  open permissions (`△ N Permissions`).
- **Upstream:** `packages/tui/src/component/prompt/index.tsx` and `packages/tui/src/routes/session/footer.tsx` at
  commit `b471c2b`.
- **Ours:** `packages/tui/src/routes/session/instrument-line.tsx`, `packages/tui/src/component/prompt/index.tsx`.
- **What:** the TUI's move to OpenTUI 0.8.4, the version current upstream runs: the spinner renderable, which replaces
  the `opentui-spinner` package; and, as upstream does, a text area's size invalidated with
  `invalidateIntrinsicSize`, syntax styles given the renderer's scene, awaited suspends and resumes, the renderer's
  own `requestAnimationFrame` (0.8 sets no global one), nothing printed before the renderer has closed, and test
  renderers whose terminal is set up. The test of OpenTUI's embedded terminal registers it as upstream's terminal
  pane does.
- **Upstream:** `packages/tui/src/component/spinner-renderable.ts`, `packages/tui/src/component/prompt/index.tsx`,
  `packages/theme/src/tui/syntax.ts`, `packages/tui/src/editor.ts`, `packages/tui/src/app.tsx`,
  `packages/tui/src/feature-plugins/system/diff-viewer.tsx`, `packages/tui/test/app-lifecycle.test.tsx` and
  `packages/tui/src/component/terminal-pane.tsx`, read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/tui/src/component/spinner-renderable.ts`, `packages/tui/src/component/register-spinner.ts`,
  `packages/tui/src/component/prompt/index.tsx`, `packages/tui/src/theme/index.ts`,
  `packages/tui/src/context/theme.tsx`, `packages/tui/src/editor.ts`, `packages/tui/src/app.tsx`,
  `packages/tui/src/ui/dialog-select.tsx`, `packages/tui/test/fixture/frame.ts`,
  `packages/tui/test/app-lifecycle.test.tsx` and `packages/tui/test/ui/embedded-terminal.test.tsx`.
- **What:** the TUI's move to OpenTUI 0.9.4, the version current upstream runs, as upstream's move made it: text
  without padding, which 0.9 draws inside (0.8 drew over it); Markdown without `internalBlockMode`, streaming only
  while a reply can still grow; the prompt without its deferred size and cursor updates; and the autocomplete's
  `deleteCells`, which deletes a range of cells without moving the cursor there first.
- **Upstream:** `packages/tui/src/prompt/content.ts` (`deleteCells`),
  `packages/tui/src/component/prompt/autocomplete.tsx`, `packages/tui/src/component/prompt/index.tsx`,
  `packages/tui/src/ui/dialog-select.tsx`, `packages/tui/src/routes/session/index.tsx` and
  `packages/tui/src/routes/session/message-parts.tsx`, as commit `4c5298bc` (2026-11-19) changed them.
- **Ours:** `packages/tui/src/prompt/content.ts`, `packages/tui/src/component/prompt/autocomplete.tsx`,
  `packages/tui/src/component/prompt/index.tsx`, `packages/tui/src/ui/dialog-select.tsx`,
  `packages/tui/src/routes/session/index.tsx`, `packages/tui/src/routes/profile/index.tsx`,
  `packages/tui/src/routes/home.tsx` and `packages/tui/test/cli/tui/inline-tool-wrap-snapshot.test.tsx`.
- **What:** the terminal title and renderer teardown, ported whole: a title is never set on a destroyed or suspended
  renderer and has its control characters replaced with spaces, and a destroyed renderer is left alone. Its tests
  come with it, and the SIGHUP test reads the cleared title from what the renderer writes, as upstream's does.
- **Upstream:** `packages/tui/src/util/renderer.ts`, `packages/tui/test/util/renderer.test.ts` and
  `packages/tui/test/app-lifecycle.test.tsx` ("SIGHUP clears title and disposes scoped resources once"), read at
  commit `df46f69` (2026-11-16).
- **Ours:** `packages/tui/src/util/renderer.ts`, `packages/tui/test/util/renderer.test.ts`,
  `packages/tui/test/app-lifecycle.test.tsx`.
- **What:** an open instrument's views, in the session frame's one right pane. Ported:
  - the session frame (`SessionFrame`): the right pane beside the session, a panel there before the sidebar, its width
    dragged with the handle and kept on disk for every pane, a double click going back to half; full screen hiding the
    session; focus moved by `pane.focus.left` and `pane.focus.right` on `<leader>left` and `<leader>right`, off in full
    screen, and by a click, with the overlay that hands the session the keys on a click and passes the wheel to the
    transcript; focus followed through `FOCUSED_RENDERABLE`; `terminal.close` and `terminal.select` as the pane's
    close and picker keys, on `<leader>up` and `<leader>down`;
  - the panel state (`createPanelState`) whole, with its tests: one panel at a time, split or full screen, full screen
    forced under 108 columns (`SESSION_PANEL_SPLIT_MIN_WIDTH`) without losing the choice; its target is an instrument
    of the session rather than a plugin's panel;
  - the panel host: its interactivity scope, a click focusing it, the raised background docked and the base one full
    screen; and the diff viewer's chrome, a header row and a footer whose hint is the focus key docked and the close
    key full screen, and a full-screen toggle that is remembered only when it took effect;
  - the pane resize and its handle, whole, with `clampSessionPaneWidth` and their tests;
  - the terminal pane around OpenTUI's `EmbeddedTerminalRenderable`: its queue that writes bytes only once the
    terminal is at the size they were meant for, its throttled intermediate renders and its column of margin. Its
    WebSocket gives way to the office's screen read, `instrument.output` events and size route, and its palette is cut
    to the theme's text and background;
  - the interactivity provider that mutes the side without the keys, which the keymap's layers honour, as its
    `createLayer` does, and the prompt honours too;
  - the shell-output dialog's layout, for a pipes shell: the command, a note when earlier output is gone, and the
    output following its end with its escapes stripped;
  - `TextBoundary.tail`, which keeps a pipes shell's newest output without half a character, and its test's cases;
  - the terminal pane's key routing: a `key` intercept at priority 100 that hands every key but the leader, and the
    key after it, to the focused terminal's `handleKeyPress`, whose `onData` input bytes go to the shell;
  - a subagent's user messages with their left border in its colour, as a Codex or Claude Code session's messages
    take their speaker's.

  Our own: a Codex or Claude Code session as a panel, the session route given its id; the box around the pane in its
  driver's colour, bright with the keys and dim without, and the header saying who drives it; a pipes shell's `$`
  lines in the employee's colour; `<leader>o` for full screen, which the diff's `f` can't be in a pane that takes
  typing; under 108 columns, a pane without the keys waiting behind a line in the chat rather than covering a draft
  or a card; the leader twice sending the leader key; the keys gathered a frame at a time for the office's keys
  route; a waiting shell opening itself, and the keys dropped until Enter when a pane closes mid-line.
- **Upstream:** `packages/tui/src/component/session-frame.tsx`, `packages/tui/src/context/panel.tsx`,
  `packages/tui/src/component/panel-host.tsx`, `packages/tui/src/feature-plugins/system/diff-viewer.tsx` (its header
  and footer, `diff.toggle_fullscreen`), `packages/tui/src/component/terminal-pane.tsx`,
  `packages/tui/src/config/keybind.ts` (`pane.focus.left`, `pane.focus.right`, `terminal.close`, `terminal.select`),
  `packages/tui/src/context/interactivity.tsx`, `packages/tui/src/context/keymap.tsx` (`createLayer`),
  `packages/tui/src/ui/pane-resize.ts`, `packages/tui/src/ui/pane-resize-handle.tsx`, `packages/tui/src/ui/layout.ts`
  (`SESSION_PANEL_SPLIT_MIN_WIDTH`, `clampSessionPaneWidth`), `packages/tui/src/routes/session/index.tsx`
  (`UserMessage`), `packages/tui/src/component/dialog-shell-output.tsx`, `packages/util/src/text-boundary.ts`,
  `packages/util/src/text-boundary.test.ts`, `packages/tui/test/panel.test.ts`,
  `packages/tui/test/ui/pane-resize.test.ts` and `packages/tui/test/ui/pane-resize-handle.test.tsx`, read at commit `df46f69` (2026-11-16), unchanged at `4332e24f`
  (2026-11-21).
- **Ours:** `packages/tui/src/component/session-frame.tsx`, `packages/tui/src/component/panel-host.tsx`,
  `packages/tui/src/context/panel.tsx`, `packages/tui/src/ui/layout.ts`, `packages/tui/src/ui/pane-resize.ts`,
  `packages/tui/src/ui/pane-resize-handle.tsx`, `packages/tui/src/routes/session/terminal-pane.tsx`,
  `packages/tui/src/routes/session/instrument-view.tsx`, `packages/tui/src/routes/session/keys.ts`,
  `packages/tui/src/routes/session/index.tsx`, `packages/tui/src/config/keybind.ts`,
  `packages/tui/src/context/interactivity.tsx`, `packages/tui/src/keymap.tsx` (`useBindings`),
  `packages/tui/src/util/text-boundary.ts`, `packages/tui/test/util/text-boundary.test.ts`,
  `packages/tui/test/context/panel.test.ts`, `packages/tui/test/ui/pane-resize.test.ts`,
  `packages/tui/test/ui/pane-resize-handle.test.tsx`.
- **What:** an agent's terminal commands in the transcript take the fork's shell view (`$ <command>`, its output
  folded to 10 lines that a click expands, a spinner while it runs). From current upstream's shell view: the
  command takes the warning colour while the call waits on the owner, spins only while its shell still runs it, and
  folds with `collapseShellOutput`, ported whole with its helpers (the command to two rows, the output to its last
  lines after a count of the rest). What the views read from the terminal tools' replies, the typed-line row and the
  one-line read, interrupt and close are our own.
- **Upstream:** `packages/tui/src/routes/session/index.tsx` (`Shell`) at commit `b471c2b`; its `Shell` and
  `ShellDisplay`, and `packages/tui/src/util/collapse-tool-output.ts` (`collapseShellOutput`,
  `collapseShellCommand`, `collapseTail`), read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/tui/src/routes/session/index.tsx` (`toolView`, `Shell`, `TypedLine`, `ShellCall`),
  `packages/tui/src/util/collapse-tool-output.ts`, `packages/tui/test/util/collapse-tool-output.test.ts`.
- **What:** the composer picker and what goes with it, ported: `createComposerTabs` and its context; the picker in the
  prompt's place, its tabs switched by ←/→ and closed with Esc or Ctrl-C, the active tab's hints then `tabs ←/→`; the
  Subagents tab as our Sessions tab (the family from `sessionFamily`, ↑/↓, ↑ on the first row closing, Enter or a click
  opening it in the right pane as the Terminals tab opens a terminal, the row the pane shows marked, ctrl+d interrupting, ctrl+a flipping between active and inactive, the current row tinted, five rows that
  scroll) and the Shell tab (its rows, keys and scroll); `busyTab`, the first tab with something running; the
  `session.child.first` command on ↓ that toggles it, or opens it on the tab a click names; the picker always shown in
  a child, its `onClose` going to the parent; `session.parent` on ↑; the prompt footer's count, with the picker's key
  in front and a click opening it; arrow keys shown as arrows; the prompt's ↑ and ↓ moving the cursor, then through the
  history, then falling through past its ends; and one draft per session across prompt remounts. Their tests come with
  them, the footer's as a frame test. Adapted: the rows and counts read the office's sessions and instruments; a
  Sessions row is a Codex or Claude Code child session, marked Running, Idle or Ended; a shell opens in the right pane
  too, and ctrl+d sends it Ctrl-C, as the office has no route to remove a shell; the Shell tab takes ctrl+a too; the
  picker shows in place of the prompt only in a child whose session ended, since a live or idle child keeps its prompt
  for the owner; the draft stash and the filters are one per TUI rather than per process; and the line under the
  prompt keeps its counts per kind and its failures. Scripts and Terminals aren't ported.
- **Upstream:** `packages/tui/src/routes/session/composer/{context,tabs,index,subagents-tab,shell-tab}.ts(x)`,
  `packages/tui/src/util/session.ts` (`sessionFamily`), `packages/tui/src/component/prompt/draft-stash.ts`,
  `packages/tui/src/component/prompt/index.tsx` (`prompt.history.previous` and `prompt.history.next`, the draft's take
  and save), `packages/tui/src/prompt/history.tsx` (`move`), `packages/tui/src/routes/session/index.tsx` (the
  `composer` store, `composerVisible`, `session.child.first`, `session.parent`),
  `packages/tui/src/feature-plugins/prompt/footer.tsx`, `packages/tui/src/config/keybind.ts` (`composer.*`),
  `packages/tui/src/context/keymap.tsx` (`keyNameAliases`), `packages/tui/test/routes/composer-tabs.test.tsx`,
  `packages/tui/test/feature-plugins/prompt-footer.test.tsx` and `packages/tui/test/util/session.test.ts`, read at
  commit `4332e24f` (2026-11-21).
- **Ours:** `packages/tui/src/routes/session/composer/{context,tabs,index,sessions-tab,shell-tab}.ts(x)`,
  `packages/tui/src/util/session.ts`, `packages/tui/src/component/prompt/draft-stash.ts`,
  `packages/tui/src/context/prompt.tsx`, `packages/tui/src/component/prompt/index.tsx`,
  `packages/tui/src/prompt/history.tsx`, `packages/tui/src/routes/session/index.tsx`,
  `packages/tui/src/routes/session/instrument-line.tsx`, `packages/tui/src/config/keybind.ts`,
  `packages/tui/src/keymap.tsx`, `packages/tui/test/routes/session/composer-tabs.test.tsx`,
  `packages/tui/test/routes/session/composer-frame.test.tsx`, `packages/tui/test/util/session.test.ts`.
- **What:** the subagent row, ported for an employee's Codex and Claude Code calls: an inline row with `│` while it
  runs, `↳` for a call to a session already started and `✓` for a start that is done, a spinner while the call or the
  session runs, its error held back until the session stops, and a click (not one that ends a selection) opening the
  session. Adapted: the label is the picker's name for the session (`Codex: codex 1`) and the message, or the call
  (`interrupt`); the session is the chat's instrument the call names, in its input or a start's reply; the click opens
  it in the right pane rather than navigating to it, and a call to a session the chat doesn't list isn't clickable.
- **Upstream:** `packages/tui/src/routes/session/index.tsx` (`Subagent`, the `running` prop of `InlineTool`), read at
  commit `4332e24f` (2026-11-21).
- **Ours:** `packages/tui/src/routes/session/index.tsx` (`toolView`, `HarnessCall`, `InlineTool`),
  `packages/tui/test/routes/session/harness-calls-frame.test.tsx`.
- **What:** the pending message's look, ported from current upstream: a user message whose delivery is pending draws
  its left border in the border colour instead of its speaker's, its text unchanged. Adapted: pending is a chat
  message its run hasn't read yet (`unread`), and a muted line under it says `unread` and, while Esc can stop the
  reply, what Esc does. The "Pending steer" dialog (Move to queue, Delete) isn't ported: Yian can neither take back
  one message nor hold one until the turn ends, so a click opens the message's actions as before.
- **Upstream:** `packages/tui/src/routes/session/index.tsx` (`UserMessage` and its `delivery`, `pendingDelivery`),
  read at commit `4332e24f` (2026-11-21).
- **Ours:** `packages/tui/src/routes/session/index.tsx` (`UserMessage`, `unreadHint`),
  `packages/tui/test/routes/session/unread-message-frame.test.tsx`.
- **What:** the descendants' requests in the parent session: a session with no parent lists its own requests, then
  its descendants', and answers a child's where it is; a child lists only its own. Adapted: the requests are the open
  Codex cards of the chat's Codex and Claude Code sessions, shown above the chat's prompt as in the child's own view
  (the first card or the prompt holding the keys), waiting as lines while one of the chat's own cards holds the
  prompt's place; the card with the keys keeps them until it closes or ctrl+t moves them, a card that opens meanwhile
  waiting as a line, the chat's own included, and once the chat's own card closes the keys go back to whoever had them
  before it; Esc on one interrupts that child.
- **Upstream:** `packages/tui/src/routes/session/index.tsx` (`descendantSessionIDs`, `permissions`, `forms`, the
  prompt's `Switch`), read at commit `4332e24f` (2026-11-21).
- **Ours:** `packages/tui/src/routes/session/composer/tabs.ts` (`familyQuestions`),
  `packages/tui/src/routes/session/index.tsx`, `packages/tui/src/component/session-frame.tsx`,
  `packages/tui/test/routes/session/pane-frame.test.tsx`.
- **What:** ported from current upstream: the reconnecting overlay, a dimmed full screen with a raised box holding a
  spinner line and a muted line, and the app's timer that shows it once the connection has been down past a grace
  and hides it when the connection is back: one second after a drop, five before the first connection. Adapted: home
  shows none before the first connection, since it says the office isn't running; while the office's state can't
  be read, the muted line says why, as home words it; its text names the office, and there is no service-restart
  variant.
- **Upstream:** `packages/tui/src/component/reconnecting.tsx` and `packages/tui/src/app.tsx` (`showReconnecting` and
  its timer), read at commit `4332e24f` (2026-11-21).
- **Ours:** `packages/tui/src/component/reconnecting.tsx`, `packages/tui/src/app.tsx`,
  `packages/tui/test/component/reconnecting-frame.test.tsx`.
- **What:** ported from current upstream: transcript verbosity and tool grouping. At Low each run of tool calls folds
  into one muted line counting its finished work (`+ 3 commands, 1 edit, 4 reads`), spinning with what runs until
  something finishes, and a click opens it; Medium groups only reads and searches (`Explored: 2 reads, 1 search`);
  High opens those groups. Questions never fold, a call waiting on an approval stays below its group, and the open
  groups are kept per session in memory. The group tree is copied as is, its merge and split included, which only its
  tests use, since the office sends a transcript whole rather than in pages. Adapted: a run is an assistant message's
  consecutive tool parts, which a text, file or error part ends (blank text doesn't); the office's tools map to
  upstream's by their view (a Codex or Claude Code call as its subagent call, running while its session runs); no
  thoughts, instruction loads or code-mode scripts; the settings live in `kv.json` and the commands in the palette;
  the expanded calls keep the transcript's own spacing.
- **Upstream:** `packages/tui/src/routes/session/grouping/{tree,session}.ts`,
  `packages/tui/src/routes/session/activity-summary.ts`, `packages/tui/src/routes/session/group-view.tsx`,
  `packages/tui/src/routes/session/render-context.tsx`, `packages/tui/src/routes/session/rows.ts`
  (`reduceSessionRows`, `createSessionRows`'s reconcile by key), `packages/tui/src/routes/session/anchors.ts`
  (`groupID`), `packages/tui/src/routes/session/anchor-view.tsx` (`visitEntries`),
  `packages/tui/src/routes/session/message-parts.tsx` (`InlineToolRow`'s home),
  `packages/tui/src/routes/session/index.tsx` (`verbosity`, `groupExpanded`, `session.verbosity.cycle`,
  `session.toggle.exploration_grouping`), `packages/tui/src/context/session-tabs.tsx` (`groupExpanded`,
  `setGroupExpanded`), `packages/tui/src/component/dialog-config.tsx` (the "Tool grouping" and "Verbosity"
  settings), `packages/tui/src/config/keybind.ts`, `packages/tui/test/cli/tui/grouping-tree.test.ts`,
  `packages/tui/test/cli/tui/session-verbosity.test.ts` and `packages/tui/test/cli/tui/group-view.test.tsx`, read at
  commit `4332e24f` (2026-11-21).
- **Ours:** `packages/tui/src/routes/session/grouping/{tree,session}.ts`,
  `packages/tui/src/routes/session/{activity-summary,rows,group-memory}.ts`,
  `packages/tui/src/routes/session/{group-view,render-context,message-parts}.tsx`,
  `packages/tui/src/routes/session/index.tsx` (`AssistantMessage`, `toolName`), `packages/tui/src/config/keybind.ts`,
  `packages/tui/test/cli/tui/grouping-tree.test.ts`, `packages/tui/test/cli/tui/session-verbosity.test.ts`,
  `packages/tui/test/routes/session/fold-tools-frame.test.tsx`.
- **What:** ported from current upstream: tail-first transcript mounting. A session opens on its newest entries, by
  a budget of rendered entries in which a folded group costs one; older ones mount a chunk at a time as the reader
  nears the top, an anchor holding the view still; a toggled group's line keeps its row; message navigation mounts the
  rest first; and each session's scroll anchor is kept in memory, so the session opens where it was left. The mount
  budget's, the anchors' and the activity anchor's tests come with them, and the frame tests' cases. Adapted: an
  entry is a message, weighed by the rows it renders; an anchor registers a row's own first node rather than a box
  around it; a reads' group's line keeps its row too; navigation holds the reader's view while the rest mounts; the
  anchors are kept per renderer rather than in session tabs, for the 50 sessions left most recently; and nothing
  loads from the office, which sends a session's whole transcript at once, so the history prepend isn't ported.
- **Upstream:** `packages/tui/src/routes/session/mount-budget.ts`, `packages/tui/src/routes/session/anchors.ts`,
  `packages/tui/src/routes/session/anchor-view.tsx`, `packages/tui/src/routes/session/group-view.tsx` (its
  `GroupAnchor`s, the toggle's anchor), `packages/tui/src/routes/session/message-parts.tsx` (`InlineToolRow`'s
  `onMouseUp`), `packages/tui/src/routes/session/render-context.tsx` (`anchors`, `setGroupExpanded`'s anchor),
  `packages/tui/src/routes/session/index.tsx` (`TRANSCRIPT_TAIL_ROWS`, `TRANSCRIPT_BACKFILL_CHUNK`,
  `afterLayout`, `pinAbove`, `revealOlderRows`, `revealNewerRows`, `ensureAllRows`, `isAwayFromBottom`,
  `updateAwayFromBottom`, `saveScrollAnchor`, `restoreScrollPosition`, `toBottom`, `moveTranscript`,
  `session.first`, `setGroupExpanded`), `packages/tui/src/context/session-tabs.tsx` (`ScrollAnchor`, `scrollAnchor`,
  `setScrollAnchor`), `packages/tui/test/cli/tui/mount-budget.test.ts`, `packages/tui/test/cli/tui/anchors.test.ts`,
  `packages/tui/test/context/session-tabs.test.tsx` (the scroll anchor tests),
  `packages/tui/test/session-mount-budget.test.tsx`, `packages/tui/test/session-history-reveal.test.tsx` and
  `packages/tui/test/session-activity-anchor.test.tsx`, read at commit `4332e24f` (2026-11-21).
- **Ours:** `packages/tui/src/routes/session/{mount-budget,anchors}.ts`,
  `packages/tui/src/routes/session/{anchor-view,index,group-view,message-parts,note-line,render-context}.tsx`,
  `packages/tui/test/cli/tui/mount-budget.test.ts`, `packages/tui/test/cli/tui/anchors.test.ts`,
  `packages/tui/test/routes/session/paged-transcript-frame.test.tsx`,
  `packages/tui/test/routes/session/activity-anchor-frame.test.tsx`.
- **What:** ported from current upstream: session links. In a reply's text a session's id is underlined in the link
  colour, and a plain click on it (not one that ends a selection, nor a modified one) opens that session; a code span
  links only when it is exactly an id, and fenced code and table cells never link. Adapted: an id is a bare ULID, so it
  links only when the TUI's list holds that session and it is neither the transcript's own nor the route's, with no
  lookup; it keeps its text, since our sessions have no title; the hook runs on the blocks that name a listed session;
  a click opens the session through the transcript's `onOpen` (one of the chat's Codex or Claude Code sessions in the
  right pane) or goes there; there is no `@session:` form and no dialog to close.
- **Upstream:** `packages/tui/src/ui/session-link.ts`, `packages/tui/src/ui/link.tsx` (`plainClick`),
  `packages/util/src/session-mention.ts`, `packages/tui/src/routes/session/message-parts.tsx` (`TextPart`'s ref),
  `packages/tui/test/ui/session-link.test.tsx` and `packages/util/src/session-mention.test.ts`, read at commit
  `4332e24f` (2026-11-21).
- **Ours:** `packages/tui/src/ui/session-link.ts`, `packages/tui/src/ui/link.ts`,
  `packages/tui/src/util/session-mention.ts`, `packages/tui/src/routes/session/index.tsx` (`TextPartView`),
  `packages/tui/test/ui/session-link.test.tsx`, `packages/tui/test/util/session-mention.test.ts`,
  `packages/tui/test/routes/session/session-links-frame.test.tsx`.
- **What:** the check before a terminal starts that its folder is a directory, since a PTY's library may start the
  shell in the home instead, ported for learning's shells.
- **Upstream:** `packages/core/src/persistent-pty/index.ts` (`create`), read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/office/src/features/reach/terminal.ts` (`startsIn`).
- **What:** the fake Claude Code's fixture: one line per kind of line the fake writes, copied from upstream's
  recordings of Claude Code's stream-json protocol, with long lists shortened and the upstream name replaced by
  `fixture`. The fake's design follows upstream's: a stand-in `claude` that answers `initialize`, writes a turn's
  lines and its result, sends `hook_callback` before a tool, rejects a waiting tool on an interrupt, and keeps each
  session's lines for a resume. Ours is a program behind a shim rather than an in-process spawn, and runs scripted
  steps rather than replaying recordings; the code is our own.
- **Upstream:** `packages/core/test/plugin/provider/claude-agent/fixtures/recordings/{text,text-cancel,tools,tools-continue,tools-waiting-cancel,startup-logged-out,controls,billing-error}.jsonl`,
  `packages/core/test/plugin/provider/claude-agent/lib/fake-claude.ts` and `lib/recorder.ts`, read at commit `df46f69`
  (2026-11-16).
- **Ours:** `packages/office/tests/fixtures/claude/stream.jsonl`, `packages/office/src/testing/fake_claude.ts`.
- **What:** how the office starts Claude Code and checks it: the command line the Agent SDK passes (`--setting-sources=`,
  `--strict-mcp-config`, hooks off in `--settings`, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`), a user message sent as
  written (`client_composed`), and the sign-in check from `initialize`'s `account` (signed in when its `tokenSource`
  isn't `none` or it has an `apiKeySource`) with no message sent, so no model call. Our driver speaks the CLI's
  stream-json directly instead of through the SDK; the code is our own.
- **Upstream:** `packages/core/src/plugin/provider/claude-agent/claude/{probe,query-options}.ts` and the recordings
  above, read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/office/src/tools/claude/{claude,probe}.ts`.

## Paperclip

- **What:** the HQ company view follows Paperclip's org chart. Our code is a SolidJS rewrite of
  its design, not a copy of its files:
  - the chart's tree layout, elbow lines, pan, zoom and fit, adapted from
    `ui/src/pages/OrgChart.production.tsx`;
  - the indented, collapsible list, adapted from `ui/src/pages/Org.tsx`.
- **Upstream:** https://github.com/paperclipai/paperclip, read at commit `1a79c8b` (2026-10-18).
- **Ours:** `packages/app/src/company/layout.ts`, `packages/app/src/company/chart.tsx`,
  `packages/app/src/company/list.tsx`.
- **What:** the HQ sidebar follows Paperclip's sidebar: the company at the top, sections with small
  uppercase headings, inset rounded rows with a highlighted current page and a text badge, and on a
  phone a menu button that opens the sidebar as a drawer over a backdrop. It is a SolidJS rewrite of
  the layout, not a copy of the files:
  - the sections, rows and badges, adapted from `ui/src/components/Sidebar.tsx`,
    `ui/src/components/SidebarSection.tsx`, `ui/src/components/SidebarNavItem.tsx` and
    `ui/src/components/primary-sidebar-styles.ts`;
  - the phone drawer, adapted from `ui/src/components/Layout.tsx`;
  - the Lucide icon before each item's label, at 16 px, picked as `ui/src/components/Sidebar.tsx` picks them (read at
    commit `98d17da`). The icons come from the `lucide-solid` dependency (ISC), not from Paperclip.
- **Upstream:** https://github.com/paperclipai/paperclip, read at commit `3bbc210` (2026-10-20).
- **Ours:** `packages/app/src/shell.tsx`.
- **License:**

```
MIT License

Copyright (c) 2025 Paperclip AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Some Paperclip sub-folders have their own copyright holders. If we take code from one, add its
notice too. For example, `packages/adapters/hermes` (MIT, Nous Research) and
`packages/shared/src/cliplab` (MIT, Jérémy Perret and Tonio). Brand logos, such as Paperclip's
`ui/public/brands/adapters`, are trademarks of their owners and aren't covered by these licenses;
we don't use them.

## highlight.js

- **What:** HQ Source's syntax colors use the `highlight.js` dependency. Beside it, we copied:
  - the GitHub and GitHub Dark themes' color rules, with the dark ones scoped to the app's dark mode, from
    `src/styles/github.css` and `src/styles/github-dark.css` (theme author github.com, maintainer @Hirse);
  - the scope-to-class rule (`title.function` is `hljs-title function_`), ported from `scopeToCSSClass` in
    `src/lib/html_renderer.js`.
- **Upstream:** https://github.com/highlightjs/highlight.js, release `11.12.0`, commit `f7f7d38`
  (`f7f7d3803bd898e37c017ffb881317f0cde04a70`); the npm package's `styles/` and `lib/core.js` are built from it.
- **Origin of the colors:** the themes say their colors come from GitHub's CSS, on top of Primer's
  https://github.com/primer/github-syntax-light and https://github.com/primer/github-syntax-dark (both MIT). We copied
  highlight.js's theme files, not Primer's.
- **Ours:** `packages/app/src/company/source.css`, `packages/app/src/company/highlight.ts`.
- **License:**

```
BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## CPython

- **What:** the `__fs-helper`'s `search` glob matching is a TypeScript port of `fnmatch.translate`'s pattern
  handling (`*`, `?`, and `[...]` classes: `!` negation, a leading `]`, `-` ranges with reversed ones dropped,
  an unclosed `[` as a literal) and of its stars (every `*` but the last matches its shortest run, never
  retried). Our changes: the result is a JavaScript RegExp anchored with `^…$` (flags `s` and `u`); Python's
  atomic group `(?>.*?fixed)` becomes a lookahead capture matched again by a named backreference; `\`, `]`,
  `[`, `^` and `-` are escaped inside a class.
- **Upstream:** https://github.com/python/cpython, `Lib/fnmatch.py` at tag `v3.12.14` (the 3.12 line), commit
  `2abcf904b8dac8c999d2b3aac76681abb333798a`.
- **Ours:** `packages/office/src/runtime/sandbox/fs_helper.ts`.
- **License:** PSF-2.0 (Python Software Foundation License Version 2):

```
PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2
--------------------------------------------

1. This LICENSE AGREEMENT is between the Python Software Foundation
("PSF"), and the Individual or Organization ("Licensee") accessing and
otherwise using this software ("Python") in source or binary form and
its associated documentation.

2. Subject to the terms and conditions of this License Agreement, PSF hereby
grants Licensee a nonexclusive, royalty-free, world-wide license to reproduce,
analyze, test, perform and/or display publicly, prepare derivative works,
distribute, and otherwise use Python alone or in any derivative version,
provided, however, that PSF's License Agreement and PSF's notice of copyright,
i.e., "Copyright (c) 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010,
2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023 Python Software Foundation;
All Rights Reserved" are retained in Python alone or in any derivative version
prepared by Licensee.

3. In the event Licensee prepares a derivative work that is based on
or incorporates Python or any part thereof, and wants to make
the derivative work available to others as provided herein, then
Licensee hereby agrees to include in any such work a brief summary of
the changes made to Python.

4. PSF is making Python available to Licensee on an "AS IS"
basis.  PSF MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR
IMPLIED.  BY WAY OF EXAMPLE, BUT NOT LIMITATION, PSF MAKES NO AND
DISCLAIMS ANY REPRESENTATION OR WARRANTY OF MERCHANTABILITY OR FITNESS
FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF PYTHON WILL NOT
INFRINGE ANY THIRD PARTY RIGHTS.

5. PSF SHALL NOT BE LIABLE TO LICENSEE OR ANY OTHER USERS OF PYTHON
FOR ANY INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES OR LOSS AS
A RESULT OF MODIFYING, DISTRIBUTING, OR OTHERWISE USING PYTHON,
OR ANY DERIVATIVE THEREOF, EVEN IF ADVISED OF THE POSSIBILITY THEREOF.

6. This License Agreement will automatically terminate upon a material
breach of its terms and conditions.

7. Nothing in this License Agreement shall be deemed to create any
relationship of agency, partnership, or joint venture between PSF and
Licensee.  This License Agreement does not grant permission to use PSF
trademarks or trade name in a trademark sense to endorse or promote
products or services of Licensee, or any third party.

8. By copying, installing or otherwise using Python, Licensee
agrees to be bound by the terms and conditions of this License
Agreement.
```

## Yian

- **What:** `shared/flows/compact_history.yaml` in the company template is Yian's
  `examples/compact_history.yaml`, copied unchanged.
- **Upstream:** https://github.com/ngocbh/yian at commit `e5349583`.
- **Ours:** `packages/office/src/company/template/shared/flows/compact_history.yaml`.
- **License:** Apache-2.0; the full text is in `packages/yian/LICENSE`. Yian's NOTICE
  (`packages/yian/NOTICE`) says "yian, Copyright 2026 Ngoc Bui".
- **What:** the session actor's wake-at timer: `sleepUntil` is Yian's `sleepUntil`
  (`ts/src/cli/chat.ts`), copied unchanged, and `wakeAt` follows Yian's `wakeAt`
  (`ts/src/runtime/waits.ts`) over the office's own `Wait` list.
- **Upstream:** https://github.com/ngocbh/yian at commit `0fa15307`.
- **Ours:** `packages/office/src/features/chat/session_actor.ts`.
- **License:** Apache-2.0, as above.
- **What:** the source lexer of the office's repo tests: `blank` and the import pattern are Yian's
  `tests/helpers/source_scan.ts`, ported to the office's style; the office adds import kinds, whether an import is
  type-only or a file import, and triple-slash references.
- **Upstream:** https://github.com/ngocbh/yian at commit `77ceac07`.
- **Ours:** `packages/office/tests/repo/scan.ts`.
- **License:** Apache-2.0, as above.

## Dependencies

Yian (`packages/yian`, Apache-2.0) and the packages in `uv.lock` and `bun.lock` are dependencies
installed alongside OpenCorp, under their own licenses. Apart from the Yian code listed above, none
of their code is copied here.

OpenTUI's native library (`@opentui/core-<os>-<cpu>`) bundles FFmpeg (LGPL-2.1-or-later), Ghostty, Little CMS, libwebp,
stb, Wuffs, Yoga and zlib, with code from Zig's and LLVM's runtimes and, in the Windows builds, MinGW-w64's and its
gdtoa. The built packages (`packages/cli/script/build.ts`) ship every license and notice file it ships
(`LICENSE*`, `AUTHORS*`, `PATENTS*`, `FFMPEG-SOURCE.md`) beside the library, under `assets/<package>/`, and refuse a
package whose license names the LGPL but that lacks `LICENSE-FFMPEG` or `FFMPEG-SOURCE.md`
(`packages/cli/script/notices.ts`).

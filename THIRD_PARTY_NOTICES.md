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
  call's commands; a reply within two minutes by default, the command still running past it rather than killed; and
  its prompt's "DO NOT poll", with its advice to quote paths that hold spaces or special characters and to prefer a
  dedicated tool over a shell command. The terminal tools' gate and descriptions follow these; the code is our own.
- **Upstream:** `packages/core/src/tool/plugin/shell.ts` (`description`, `DEFAULT_TIMEOUT_MS`,
  `BACKGROUND_INSTRUCTION`, and `prepare`'s `permission.assert`), read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/office/src/tools/terminal/tools.ts`, `packages/office/src/tools/terminal/terminal.ts`.
- **What:** the line under the prompt keeps the fork's layout: the spinner and `esc interrupt` (or the folder) on the
  left, the shortcuts on the right. The chat's instrument counts follow the left side, and what waits for the owner
  takes the shortcuts' place in the warning colour, as the fork's session footer showed its open permissions
  (`△ N Permissions`).
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
  `packages/tui/src/setup/screen.tsx`, `packages/tui/src/setup/run.tsx`, `packages/tui/src/ui/dialog-select.tsx`,
  `packages/tui/test/fixture/frame.ts`, `packages/tui/test/setup/boot.tsx`,
  `packages/tui/test/setup/in-process-frame.test.tsx`, `packages/tui/test/app-lifecycle.test.tsx` and
  `packages/tui/test/ui/embedded-terminal.test.tsx`.
- **What:** the terminal title and renderer teardown, ported whole: a title is never set on a destroyed or suspended
  renderer and has its control characters replaced with spaces, and a destroyed renderer is left alone. Its tests
  come with it, and the SIGHUP test reads the cleared title from what the renderer writes, as upstream's does.
- **Upstream:** `packages/tui/src/util/renderer.ts`, `packages/tui/test/util/renderer.test.ts` and
  `packages/tui/test/app-lifecycle.test.tsx` ("SIGHUP clears title and disposes scoped resources once"), read at
  commit `df46f69` (2026-11-16).
- **Ours:** `packages/tui/src/util/renderer.ts`, `packages/tui/test/util/renderer.test.ts`,
  `packages/tui/test/app-lifecycle.test.tsx`.
- **What:** an open instrument's views. Ported:
  - the terminal pane around OpenTUI's `EmbeddedTerminalRenderable`: its queue that writes bytes only once the
    terminal is at the size they were meant for, its throttled intermediate renders and its column of margin. Its
    WebSocket gives way to the office's screen read, `instrument.output` events and size route, and its palette is cut
    to the theme's text and background;
  - the pane resize and its handle, whole, with `clampSessionPaneWidth`;
  - from the session frame: the right pane beside the session, its width dragged with the handle; the overlay that
    hands the session the keys on a click and passes the wheel to the transcript; focus followed through
    `FOCUSED_RENDERABLE`;
  - the interactivity provider that mutes the session while the pane has the keys, which the keymap's layers honour,
    as its `createLayer` does, and the prompt honours too;
  - the shell-output dialog's layout, for a pipes shell: the command, a note when earlier output is gone, and the
    output following its end with its escapes stripped;
  - `TextBoundary.tail`, which keeps a pipes shell's newest output without half a character, and its test's cases;
  - the terminal pane's key routing: a `key` intercept at priority 100 that hands every key but the leader, and the
    key after it, to the focused terminal's `handleKeyPress`, whose `onData` input bytes go to the shell;
  - the session frame's `pane.focus.left` and `pane.focus.right`, on `<leader>left` and `<leader>right`, which move
    the keys between the chat and the pane, the left one off in full screen.

  The floating view is our own, as are the leader twice sending the leader key, the keys gathered a frame at a time
  for the office's keys route, and a waiting shell opening itself.
- **Upstream:** `packages/tui/src/component/terminal-pane.tsx`, `packages/tui/src/component/session-frame.tsx`,
  `packages/tui/src/config/keybind.ts` (`pane.focus.left`, `pane.focus.right`),
  `packages/tui/src/context/interactivity.tsx`, `packages/tui/src/context/keymap.tsx` (`createLayer`),
  `packages/tui/src/ui/pane-resize.ts`, `packages/tui/src/ui/pane-resize-handle.tsx`, `packages/tui/src/ui/layout.ts`
  (`clampSessionPaneWidth`), `packages/tui/src/component/dialog-shell-output.tsx`, `packages/util/src/text-boundary.ts`
  and `packages/util/src/text-boundary.test.ts`, read at commit `df46f69` (2026-11-16).
- **Ours:** `packages/tui/src/routes/session/terminal-pane.tsx`, `packages/tui/src/routes/session/instrument-view.tsx`,
  `packages/tui/src/routes/session/keys.ts`, `packages/tui/src/config/keybind.ts`,
  `packages/tui/src/routes/session/index.tsx`, `packages/tui/src/context/interactivity.tsx`,
  `packages/tui/src/keymap.tsx` (`useBindings`), `packages/tui/src/ui/pane-resize.ts`,
  `packages/tui/src/ui/pane-resize-handle.tsx`, `packages/tui/src/util/text-boundary.ts`,
  `packages/tui/test/util/text-boundary.test.ts`.
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
stb, Wuffs and zlib. The built packages (`packages/cli/script/build.ts`) ship every license and notice file it ships
(`LICENSE*`, `AUTHORS*`, `PATENTS*`, `FFMPEG-SOURCE.md`) beside the library, under `assets/<package>/`, and refuse a
package whose license names the LGPL but that lacks `LICENSE-FFMPEG` or `FFMPEG-SOURCE.md`
(`packages/cli/script/notices.ts`).

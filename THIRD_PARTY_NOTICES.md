# Third-party notices

OpenCorp is MIT-licensed (see `LICENSE`). It includes or adapts code and designs from the
projects below. Their licenses ask that their copyright and permission notices travel with the
parts we use, so each one is listed here with what we took and where it lives.

When you copy or substantially port code from another project, add an entry: the project, its
license, the upstream paths and commit, and our paths.

## OpenCode

- **What:** the terminal UI in `packages/tui` is forked from OpenCode's TUI.
- **Upstream:** https://github.com/anomalyco/opencode (formerly `sst/opencode`).
- **License:** MIT, "Copyright (c) 2025 opencode". The full notice is in `packages/tui/LICENSE`.

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
- **Upstream:** https://github.com/highlightjs/highlight.js, release `11.12.0` (the npm package's `styles/` and
  `lib/core.js`).
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

## Dependencies

Yian (`packages/yian`, Apache-2.0) and the packages in `uv.lock` and `bun.lock` are dependencies
installed alongside OpenCorp, under their own licenses; none of their code is copied here.

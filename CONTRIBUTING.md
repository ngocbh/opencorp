# Contributing

[`ARCHITECTURE.md`](ARCHITECTURE.md) explains how the code fits together.

## Setup

```
git clone --recurse-submodules https://github.com/ngocbh/opencorp.git && cd opencorp
bun install
```

To create a company and use it (init, the TUI, hiring, HQ, doctor), follow the
[Quickstart](README.md#quickstart).

Run `opencorp` from a checkout through `packages/cli/bin/opencorp`. Never run
`bun packages/cli/src/main.ts`, which reads the folder's `.env` and `bunfig.toml`. Put the wrapper
on `PATH` with
`mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/bin/opencorp" ~/.local/bin/opencorp` (this
replaces any old `~/.local/bin/opencorp`). The wrapper runs the `bun` on `PATH`, or `OPENCORP_BUN`
if set. Don't put project folders on `PATH` (for example direnv's `PATH_add node_modules/.bin`):
a model-written project could then shadow `bun` or `opencorp` itself.

`(cd packages/cli && bun run build)` writes the compiled binary and the npm packages to
`packages/cli/dist/npm/`, for the current platform. Name targets (for example
`bun run build linux-x64`) to cross-build; each needs OpenTUI's native package for that target
(`bun install --os='*' --cpu='*'`). Nothing is published.

## Tests

- `(cd packages/<pkg> && bun test)`; from the root, `bun run test` and `bun run typecheck`
  run each package's own `test` and `typecheck` scripts, except yian's (`@ngocbh/yian` in
  `packages/yian`), which the yian repo tests.
- CI runs a package's `bun test` only once it has a `*.test.ts(x)` file.
- A new office test goes where `packages/office/tests/` mirrors `packages/office/src/`; see "Where
  tests live" in `ARCHITECTURE.md`.

## GitHub workflow

1. Open (or pick up) an issue.
2. Post a plan as a comment on the issue.
3. Branch `dev/<domain>/<short-name>`.
4. Make small, test-first commits.
5. Open a PR with `Fixes #N` that lists the exact checks you ran.

Work is complete only when the PR merges.

Yian changes go to the yian repo (github.com/ngocbh/yian) as their own issue and PR; never edit
the submodule (`packages/yian/`) here. The submodule pointer is the office's yian, and a bump is its
own commit inside the PR that needs it: move the pointer forward to a yian `main` commit (never a
branch), run `bun run typecheck` and the office tests on it, fix the office in the same PR if yian
changed under it, and name in the PR the yian PRs the bump brings in. If `main`'s pointer is newer
when you rebase, keep the newer one and re-run the checks. When you bump it, also check that the
root `typescript` and `@types/bun` pins still equal yian's:
`grep -c '"typescript@' bun.lock` and `grep -c '"bun-types@' bun.lock` (the package behind
`@types/bun`) each print 1, so yian resolves the same versions, and
`(cd packages/yian && bun run typecheck)` passes (the root typecheck skips yian).

## Design docs

The design docs in `docs/plans/` are gitignored, so a fresh clone does not have them; issue #1 is
the shared record of the design decisions.

## Releases

Nothing is published. `(cd packages/cli && bun run build)` writes the compiled binary and the npm
packages under `packages/cli/dist/npm/` for whoever runs it (see Setup), and that is the only way to
get a build today.

What ships, where, and how it is trusted is #525. The PyPI package `opencorp` was the Python
office's and went with it; yian is public but not on npm, so a published build vendors it or waits
for yian to publish.

## Code style

- Keep code direct and scoped to the task.
- Docstrings say what a symbol does; comments say why non-obvious code exists.
- No task numbers or plan labels in source.

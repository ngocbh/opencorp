# OpenCorp

OpenCorp: run a company of AI employees on your machine. A local office daemon runs them on top
of the Yian engine.

## Goals

- Yian flows hold each employee's traits and SOPs: repeatable work that improves over long runs.
- Flexible or one-off work runs in Codex, Claude Code, or OpenCode, unchanged. OpenCorp lets
  an employee act as their user.
- OpenCorp dogfoods Yian. Whenever we can, automate work with a Yian YAML flow that people and
  agents can share and reuse, rather than with one-off code.

OpenCorp isn't affiliated with OpenCode (the TUI is forked from it) or OpenCorporates.

## Built around Yian

Everything in OpenCorp is built around Yian flows. Each kind of work an employee does is a flow:
chatting with them, running an SOP, handing work to Codex, Claude Code, or OpenCode. Office code
runs flows and provides the tools they call (workspace, company, questions, ...). It doesn't add
a way to do work beside a flow.

Codex sessions (#144) predate this principle and run outside Yian; #179 sketches moving them
onto flows.

## Building a feature on Yian

Before designing a feature, during brainstorming:

1. Design the feature as Yian flows plus the office tools they call. Ask whether the work
   repeats: will the owner, other people, or agents run it again? If so, make it an SOP that
   anyone can share and reuse. If it's one-off or flexible work, a flow hands it to Codex,
   Claude Code, or OpenCode.
2. For a flow, list the Yian features it needs and check that Yian supports each one.
3. For each missing feature, file an issue on the yian repo (github.com/ngocbh/yian) asking for a
   generic feature. Don't work around it in OpenCorp; build on what Yian has today and expand
   when Yian ships more.

## Counterparts to study

Before designing something, or when stuck, look at how well-established open-source projects solve
it. Map their pieces to ours, reuse as much as their licenses allow, and decide only where
following them conflicts with our goals. Yian's own invention is learning across runs and
readable, typed SOPs. For everything else (durable recovery, external events, scheduling,
retries, run views), borrow the designs below instead of re-solving them.

| Area | Project | Strong at |
|---|---|---|
| Agent graphs | LangGraph | Checkpoints per step, `interrupt()` and resume for human input, time travel, Studio's run view |
| Durable execution | Temporal | Event-history replay, retries, signals, queries and updates, long-running workflows, versioning, a mature web UI |
| Event-driven steps | Inngest | Memoized `step.run`, `step.waitForEvent`, `step.sleep`, concurrency and throttling controls |
| Learning from feedback | DSPy, TextGrad | DSPy: optimizers that tune prompts and examples against a metric. TextGrad: text feedback propagated backward through LLM calls |
| Server and clients | OpenCode (our TUI's upstream) | One service with many clients, a contract-first API, an SSE event stream, a SolidJS web app, pairing, an Electron desktop app |
| Gateway, security, native apps | OpenClaw | Device pairing and scopes, auth on loopback, protocol schema discipline, a macOS menu-bar app. Its security advisories show what to avoid |
| Coding-agent protocol | Codex app-server | Threads, turns and items; approvals as server requests; one protocol for many clients |
| AI-company org | Paperclip | Org chart, reporting lines and budgets for agent companies |

Research notes on these live in `docs/plans/research/` (local only).

OpenCorp is MIT-licensed. When you copy or substantially port code from another project, credit it in
`THIRD_PARTY_NOTICES.md` (project, license, upstream paths and commit, our paths).

## The office

The office lives in `packages/office` (`@opencorp/office`): a module is
`packages/office/src/<pkg>/<mod>.ts` and its tests are `packages/office/tests/<pkg>/<mod>.test.ts`,
each test's name in words. Run them with `(cd packages/office && bun test <file>)`. `bun test` has
no fixtures: inject dependencies, give children an explicit env, and never change `process.env` in
a test.

The clients (TUI, CLI, HQ app) reach it through the wrapper `packages/cli/bin/opencorp` in a
checkout, and the compiled binary when installed. Their tests run against a real office on a temp
home (`@opencorp/office/testing/office`). Fakes are kept only for scripted tests (the TUI's frame
tests, HQ's Playwright tests), and a contract test checks each against the real office.

**Run `opencorp` in a checkout through `packages/cli/bin/opencorp`**: it runs Bun with
`--no-install --no-env-file --config=/dev/null`, so the current folder's `.env` and
`bunfig.toml` aren't read (see Setup).

## Layout

```
packages/office/                      # office daemon, run worker, sandbox launcher, permission layer, harness adapters
packages/yian/                        # submodule; the Yian engine the office runs flows on
packages/protocol/                    # zod schemas: the protocol the office and the clients share
packages/client/                      # the TS client the TUI, CLI and HQ app reach the office with
packages/tui/                         # the TUI (forked from OpenCode)
packages/cli/                         # the `opencorp` CLI (npm package "opencorp")
packages/app/                         # OpenCorp HQ, the web app (#184)
docs/plans/                           # design docs and plans (local only, gitignored)
```

The design docs in `docs/plans/` are gitignored, so a fresh clone does not have them; issue #1 is
the shared record of the design decisions.

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
- `packages/office/tests/<pkg>/` mirrors `packages/office/src/<pkg>/`. The office's e2e tests
  (`tests/e2e/`) and its sandbox tests run with the rest of its suite; a sandbox test skips where it
  can't sandbox, unless `CI` or `OPENCORP_TEST_SANDBOX` is set.

## Protocol schema

The protocol is the zod schemas in `packages/protocol/src/schemas/`: the office and every client
take their types from them, and nothing is generated.

A PR may add, rename or remove a protocol field as long as it updates every package that uses it
(office, client, TUI, CLI, HQ app) in the same PR, and adds the matching store migration
(`packages/office/src/store/migrations/`) when a field lands on a schema the store persists, since
inserts fail until the column exists. The additive-only rule and the schema-only-PR rule the port
suspended stay off until there are outside clients to keep compatible.

Clients ignore enum values and event types they don't know. Make timestamps with `now()` from
`@opencorp/protocol`.

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

## Releases

Nothing is published. `(cd packages/cli && bun run build)` writes the compiled binary and the npm
packages under `packages/cli/dist/npm/` for whoever runs it (see Setup), and that is the only way to
get a build today.

What ships, where, and how it is trusted is #525. The PyPI package `opencorp` was the Python
office's and went with it; yian is a private submodule, so a published build has to vendor it or
wait for yian to publish.

## Code style

- Keep code direct and scoped to the task.
- Docstrings say what a symbol does; comments say why non-obvious code exists.
- No task numbers or plan labels in source.

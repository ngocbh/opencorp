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

## TS port in progress

The office is being ported to TypeScript on TS Yian (#302). Until the cut-over:

- **The Python office is frozen.** `packages/corp_office` gets no new features; they land in the
  TS office. It gets bug fixes only, each through its own issue. Its code and tests are the spec
  the port is checked against. Nobody runs the office itself during the port, so `main`'s TUI, CLI
  and HQ app may stop working with it as soon as the protocol changes. Run its tests
  (`uv run pytest -q`) in any PR that touches it. Touch `packages/corp_office`, `pyproject.toml` or
  `uv.lock` only for such a fix or when a port issue names them. The cut-over deletes it, with no
  migration of its data.
- **The TS office** lives in `packages/office` (`@opencorp/office`, from its skeleton PR on) and
  mirrors the Python packages: `opencorp/<pkg>/<mod>.py` becomes
  `packages/office/src/<pkg>/<mod>.ts`, and `tests/<pkg>/test_<mod>.py` becomes
  `packages/office/tests/<pkg>/<mod>.test.ts`, keeping each test's name in words (no
  apostrophes, so the parity ledger can match them). Run its tests with
  `(cd packages/office && bun test <file>)`. `bun test` has no fixtures: inject dependencies, give
  children an explicit env, and never change `process.env` in a test.
- **Two yian pins.** The `packages/yian` submodule pointer is the TS office's pin. The Python
  office takes yian from its own git rev in `pyproject.toml` (`[tool.uv.sources]`), not from the
  submodule; that rev isn't bumped except for a Python bug fix that needs a yian fix (then only the
  `rev` and `uv.lock` change, in their own commit). A submodule bump is its own commit inside the PR
  that needs it: move the pointer forward to a yian `main` commit (never a branch), run
  `bun run typecheck` and the office tests on it, fix the office in the same PR if yian changed
  under it, and name in the PR the yian PRs the bump brings in. If `main`'s pointer is newer when
  you rebase, keep the newer one and re-run the checks.
- **Protocol rules suspended.** The schema-only-PR rule and the additive-only rule in "Protocol
  schema" don't apply during the port. The zod schemas in `packages/protocol/src/schemas/` are
  the only protocol source the TS side follows, and a PR may add, rename or remove
  protocol fields if it updates every package that uses it (client, TUI, CLI, HQ app) in the same
  PR. The frozen `protocol.schema.json`, `models.py` and their fixtures are left as they are. The
  rules can return after the port (for example once there are outside clients).
- **Run `opencorp` in a checkout through `packages/cli/bin/opencorp`**: it runs Bun with
  `--no-install --no-env-file --config=/dev/null`, so the current folder's `.env` and
  `bunfig.toml` aren't read (see Setup).

## Layout

```
pyproject.toml                        # Python project "opencorp" (import opencorp)
packages/corp_office/src/opencorp/    # office daemon, run worker, sandbox launcher, permission layer, harness adapters
packages/corp_office/tests/           # Python tests, mirroring packages/corp_office/src/opencorp/
packages/office/                      # the TS office (from its skeleton PR on; see "TS port in progress")
packages/yian/                        # submodule; the TS side's yian (see "TS port in progress")
packages/protocol/                    # zod schemas (the TS types); frozen JSON Schema → pydantic
packages/tui/                         # the TUI (forked from OpenCode)
packages/cli/                         # the `opencorp` CLI (npm package "opencorp")
docs/plans/                           # design docs and plans (local only, gitignored)
```

The design docs in `docs/plans/` are gitignored, so a fresh clone does not have them; issue #1 is
the shared record of the design decisions.

## Setup

```
git clone --recurse-submodules https://github.com/ngocbh/opencorp.git && cd opencorp
uv sync        # uses a uv-managed Python 3.12
bun install
```

Run `opencorp` from a checkout through `packages/cli/bin/opencorp`. Never run
`bun packages/cli/src/main.ts`, which reads the folder's `.env` and `bunfig.toml`. Put the wrapper
on `PATH` with
`mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/bin/opencorp" ~/.local/bin/opencorp` (this
replaces any old `~/.local/bin/opencorp`). The wrapper runs the `bun` on `PATH`, or `OPENCORP_BUN`
if set. Don't put project folders on `PATH` (for example direnv's `PATH_add node_modules/.bin`):
a model-written project could then shadow `bun` or `opencorp` itself.

## Tests

- Python: `uv run pytest -q packages/corp_office/tests/<path>` (all: `uv run pytest -q`).
- TS: `(cd packages/<pkg> && bun test)`; from the root, `bun run test` and `bun run typecheck`
  run each package's own `test` and `typecheck` scripts, except yian's (`@ngocbh/yian` in
  `packages/yian/ts`), which the yian repo tests.
- CI runs a package's `bun test` only once it has a `*.test.ts(x)` file.
- `packages/corp_office/tests/<pkg>/` mirrors `packages/corp_office/src/opencorp/<pkg>/`.
  Every test directory has an empty `__init__.py` so same-named test modules in different
  directories don't collide.

## Protocol schema

The schema-only-PR rule and the additive-only rule below are suspended during the TS port (see
"TS port in progress"). The TS side's protocol types come from the zod schemas in
`packages/protocol/src/schemas/`; no TS is generated from `protocol.schema.json`.

`packages/protocol/schema/protocol.schema.json` changes only in a schema-only PR that:

- edits the schema and its fixtures, and regenerates
  `packages/corp_office/src/opencorp/protocol/models.py` in the same commit (its drift test
  fails otherwise);
- only adds fields, `$defs`, and enum members; never renames, removes, narrows, or changes the
  type of anything merged code uses;
- while the PyPI releases are 0.0.x placeholders (see Releases), may also remove a field once
  the code that read it has merged without it, and says in the PR what stops loading;
- adds the matching store migration (`packages/corp_office/src/opencorp/store/migrations/`)
  when a new field lands on a `$def` the store persists, since inserts fail until the column
  exists;
- merges before dependent work continues.

Clients ignore enum values and event types they don't know. Make timestamps with `now()` from
`@opencorp/protocol` (`opencorp.protocol.now()` in Python).

## GitHub workflow

1. Open (or pick up) an issue.
2. Post a plan as a comment on the issue.
3. Branch `dev/<domain>/<short-name>`.
4. Make small, test-first commits.
5. Open a PR with `Fixes #N` that lists the exact checks you ran.

Work is complete only when the PR merges.

Yian changes go to the yian repo (github.com/ngocbh/yian) as their own issue and PR; never edit
the submodule (`packages/yian/`) here. Bump the submodule pointer in a separate commit. When you
bump it, also check that the root `typescript` and `@types/bun` pins still equal yian's:
`grep -c '"bun-types@' bun.lock` and `grep -c '"typescript@' bun.lock` each print 1, and
`(cd packages/yian/ts && bun run typecheck)` passes (the root typecheck skips yian).

## Releases

The Python package `opencorp` goes to PyPI from `.github/workflows/publish.yml`, through PyPI
Trusted Publishing (the `pypi` environment); no token is stored.

1. Bump `version` in `pyproject.toml` in a PR and merge it.
2. Publish a GitHub Release tagged `v<version>`. The workflow fails if the tag and the version
   differ.

Actions must be enabled for the workflow to run; run it by hand (`workflow_dispatch`) for a
build-only dry run.

The published package depends on `yian[all]>=0.0.3` from PyPI, not the git rev in
`[tool.uv.sources]`. yian 0.0.3 predates that rev, so an install from PyPI can't load the flows
the office ships yet. The 0.0.x releases are placeholders until yian publishes a matching build;
then raise the floor.

## Code style

- Keep code direct and scoped to the task.
- Docstrings say what a symbol does; comments say why non-obvious code exists.
- No task numbers or plan labels in source.

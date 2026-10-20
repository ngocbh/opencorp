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

## Layout

```
pyproject.toml                        # Python project "opencorp" (import opencorp)
packages/corp_office/src/opencorp/    # office daemon, run worker, sandbox launcher, permission layer, harness adapters
packages/corp_office/tests/           # Python tests, mirroring packages/corp_office/src/opencorp/
packages/yian/                        # submodule; uv path dependency
packages/protocol/                    # JSON Schema → TS types + pydantic
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

## Tests

- Python: `uv run pytest -q packages/corp_office/tests/<path>` (all: `uv run pytest -q`).
- TS: `(cd packages/<pkg> && bun test)`; from the root, `bun run test` and `bun run typecheck`
  run each package's own `test` and `typecheck` scripts.
- CI runs a package's `bun test` only once it has a `*.test.ts(x)` file.
- `packages/corp_office/tests/<pkg>/` mirrors `packages/corp_office/src/opencorp/<pkg>/`.
  Every test directory has an empty `__init__.py` so same-named test modules in different
  directories don't collide.

## Protocol schema

`packages/protocol/schema/protocol.schema.json` changes only in a schema-only PR that:

- edits the schema and its fixtures, and regenerates
  `packages/corp_office/src/opencorp/protocol/models.py` and
  `packages/protocol/src/gen/protocol.ts` in the same commit (drift tests fail otherwise);
- only adds fields, `$defs`, and enum members; never renames, removes, narrows, or changes the
  type of anything merged code uses;
- adds the matching store migration (`packages/corp_office/src/opencorp/store/migrations/`)
  when a new field lands on a `$def` the store persists, since inserts fail until the column
  exists;
- merges before dependent work continues.

Clients ignore enum values and event types they don't know. Make timestamps with
`opencorp.protocol.now()`.

## GitHub workflow

1. Open (or pick up) an issue.
2. Post a plan as a comment on the issue.
3. Branch `dev/<domain>/<short-name>`.
4. Make small, test-first commits.
5. Open a PR with `Fixes #N` that lists the exact checks you ran.

Work is complete only when the PR merges.

Yian changes go to the yian repo (github.com/ngocbh/yian) as their own issue and PR; never edit
the submodule (`packages/yian/`) here. Bump the submodule pointer in a separate commit.

## Releases

The Python package `opencorp` goes to PyPI from `.github/workflows/publish.yml`, through PyPI
Trusted Publishing (the `pypi` environment); no token is stored.

1. Bump `version` in `pyproject.toml` in a PR and merge it.
2. Publish a GitHub Release tagged `v<version>`. The workflow fails if the tag and the version
   differ.

Actions must be enabled for the workflow to run; run it by hand (`workflow_dispatch`) for a
build-only dry run.

The published package depends on `yian[all]>=0.0.3` from PyPI, not the submodule. yian 0.0.3
predates the submodule, so an install from PyPI can't load the flows the office ships yet. The
0.0.x releases are placeholders until yian publishes a matching build; then raise the floor.

## Code style

- Keep code direct and scoped to the task.
- Docstrings say what a symbol does; comments say why non-obvious code exists.
- No task numbers or plan labels in source.

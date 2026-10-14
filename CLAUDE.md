# agent-corp

A local office daemon that runs AI employees on top of the Yian engine.

## Goals

- Yian flows hold each employee's traits and SOPs: repeatable work that improves over long runs.
- Flexible or one-off work runs in Codex, Claude Code, or OpenCode, unchanged. agent-corp lets
  an employee act as their user.
- agent-corp dogfoods Yian. Whenever we can, automate work with a Yian YAML flow that people and
  agents can share and reuse, rather than with one-off code.

## Building a feature on Yian

Before designing a feature, during brainstorming:

1. Ask whether the work repeats: will the owner, other people, or agents run it again? If so,
   build it as a Yian flow (an SOP or part of an employee's flows) that anyone can share and reuse.
   If it's one-off or flexible work, leave it to a harness (Codex, Claude Code, OpenCode) or
   plain office code.
2. For a flow, list the Yian features it needs and check that Yian supports each one.
3. For each missing feature, file an issue on the yian repo (github.com/ngocbh/yian) asking for a
   generic feature. Don't work around it in agent-corp; build on what Yian has today and expand
   when Yian ships more.

## Layout

```
pyproject.toml                        # Python project "agent-corp" (import agent_corp)
packages/corp_office/src/agent_corp/  # office daemon, run worker, sandbox launcher, permission layer, harness adapters
packages/corp_office/tests/           # Python tests, mirroring packages/corp_office/src/agent_corp/
packages/yian/                        # submodule; uv path dependency
packages/protocol/                    # JSON Schema → TS types + pydantic
packages/tui/                         # the TUI (forked from OpenCode)
packages/ac/                          # `ac` CLI entry
docs/plans/                           # design docs and plans (local only, gitignored)
```

The design docs in `docs/plans/` are gitignored, so a fresh clone does not have them; issue #1 is
the shared record of the design decisions.

## Setup

```
git clone --recurse-submodules https://github.com/ngocbh/agent-corp.git && cd agent-corp
uv sync        # uses a uv-managed Python 3.12
bun install
```

## Tests

- Python: `uv run pytest -q packages/corp_office/tests/<path>` (all: `uv run pytest -q`).
- TS: `(cd packages/<pkg> && bun test)`; from the root, `bun run test` and `bun run typecheck`
  run each package's own `test` and `typecheck` scripts.
- CI runs a package's `bun test` only once it has a `*.test.ts(x)` file.
- `packages/corp_office/tests/<pkg>/` mirrors `packages/corp_office/src/agent_corp/<pkg>/`.
  Every test directory has an empty `__init__.py` so same-named test modules in different
  directories don't collide.

## Protocol schema

`packages/protocol/schema/protocol.schema.json` changes only in a schema-only PR that:

- edits the schema and its fixtures, and regenerates
  `packages/corp_office/src/agent_corp/protocol/models.py` and
  `packages/protocol/src/gen/protocol.ts` in the same commit (drift tests fail otherwise);
- only adds fields, `$defs`, and enum members; never renames, removes, narrows, or changes the
  type of anything merged code uses;
- adds the matching store migration (`packages/corp_office/src/agent_corp/store/migrations/`)
  when a new field lands on a `$def` the store persists, since inserts fail until the column
  exists;
- merges before dependent work continues.

Clients ignore enum values and event types they don't know. Make timestamps with
`agent_corp.protocol.now()`.

## GitHub workflow

1. Open (or pick up) an issue.
2. Post a plan as a comment on the issue.
3. Branch `dev/<domain>/<short-name>`.
4. Make small, test-first commits.
5. Open a PR with `Fixes #N` that lists the exact checks you ran.

Work is complete only when the PR merges.

Yian changes go to the yian repo (github.com/ngocbh/yian) as their own issue and PR; never edit
the submodule (`packages/yian/`) here. Bump the submodule pointer in a separate commit.

## Code style

- Keep code direct and scoped to the task.
- Docstrings say what a symbol does; comments say why non-obvious code exists.
- No task numbers or plan labels in source.

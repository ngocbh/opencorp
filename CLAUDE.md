# agent-corp

A local office daemon that runs AI employees on top of the agent-composer engine.

## Layout

```
pyproject.toml         # Python project "agent-corp" (import agent_corp)
src/agent_corp/        # office daemon, run worker, sandbox launcher, permission layer, harness adapters
tests/                 # Python tests, mirroring src/agent_corp/
agent-composer/        # submodule; uv path dependency
packages/protocol/     # JSON Schema → TS types + pydantic
packages/tui/          # forked OpenCode TUI
packages/ac/           # `ac` CLI entry
docs/plans/            # design docs and plans (gitignored)
```

The design docs live in `docs/plans/` and are gitignored; issue #1 records the design decisions.

## Tests

- Python: `uv run pytest -q tests/<path>` (all: `uv run pytest -q tests`).
- TS: `(cd packages/<pkg> && bun test)` and `bun run typecheck` from the root.
- `tests/<pkg>/` mirrors `src/agent_corp/<pkg>/`. Every test directory has an empty
  `__init__.py` so same-named test modules in different directories don't collide.

## Protocol schema

After WP1, `packages/protocol/schema/protocol.schema.json` changes only in a schema-only PR that:

- edits the schema and its fixtures, and regenerates `src/agent_corp/protocol/models.py`
  and `packages/protocol/src/gen/protocol.ts` in the same commit (drift tests fail otherwise);
- only adds fields and `$defs`; never renames or removes one that merged code uses;
- merges before the WPs that need it continue.

## GitHub workflow

1. Open (or pick up) an issue.
2. Post a plan as a comment on the issue.
3. Branch `dev/<domain>/<short-name>`.
4. Make small, test-first commits.
5. Open a PR with `Fixes #N` that lists the exact checks you ran.

Work is complete only when the PR merges.

agent-composer changes go to the agent-composer repo (github.com/ngocbh/agent-composer) as their
own issue and PR; never edit the submodule here. Bump the submodule pointer in a separate commit.

## Code style

- Keep code direct and scoped to the task.
- Docstrings say what a symbol does; comments say why non-obvious code exists.
- No task numbers or plan labels in source.

#!/usr/bin/env bash
# Regenerate the office pydantic models from the protocol schema.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="${1:-$root/packages/corp_office/src/opencorp/protocol/models.py}"
# --collapse-root-models inlines required refs such as Id but leaves `Id | None` and
# `list[Id]` pointing at the def; --use-type-alias makes those defs Annotated str aliases
# rather than RootModels, so every id is a plain, hashable str. --strict-nullable keeps a
# defaulted field non-nullable (`list[Id] = []`). The builtin formatter keeps the output
# independent of external black/isort versions. --no-sync keeps the drift test from syncing
# the environment mid-run.
uv run --no-sync --project "$root" datamodel-codegen \
  --input "$root/packages/protocol/schema/protocol.schema.json" \
  --input-file-type jsonschema \
  --output-model-type pydantic_v2.BaseModel \
  --use-annotated --use-standard-collections --use-union-operator \
  --collapse-root-models --enum-field-as-literal all \
  --target-python-version 3.12 --disable-timestamp \
  --use-type-alias --strict-nullable --use-schema-description --skip-root-model \
  --formatters builtin \
  --output "$out"

#!/usr/bin/env bash
# Regenerate the office pydantic models from the protocol schema.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="${1:-$root/src/agent_corp/protocol/models.py}"
# The builtin formatter keeps the output independent of external black/isort versions.
uv run --project "$root" datamodel-codegen \
  --input "$root/packages/protocol/schema/protocol.schema.json" \
  --input-file-type jsonschema \
  --output-model-type pydantic_v2.BaseModel \
  --use-annotated --use-standard-collections --use-union-operator \
  --collapse-root-models --enum-field-as-literal all \
  --target-python-version 3.12 --disable-timestamp \
  --formatters builtin \
  --output "$out"

import { createHash } from "node:crypto"
import { z } from "zod"
import cli from "../../cli/package.json" with { type: "json" }
import * as S from "./schemas"

/** `value` with every `description` keyword removed; a property named `description` stays. */
function withoutDescriptions(value: unknown, inProperties = false): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutDescriptions(item))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      // Keys directly under `properties` are property names, not keywords.
      .filter(([key]) => inProperties || key !== "description")
      .map(([key, item]) => [key, withoutDescriptions(item, !inProperties && key === "properties")]),
  )
}

/** The first 12 hex of the sha256 of `schemas`' JSON Schema, without descriptions. */
export function schemaKey(schemas: Record<string, z.ZodType>): string {
  const registry = z.registry<{ id: string }>()
  for (const name of Object.keys(schemas).sort()) registry.add(schemas[name], { id: name })
  const json = JSON.stringify(withoutDescriptions(z.toJSONSchema(registry)))
  return createHash("sha256").update(json).digest("hex").slice(0, 12)
}

/**
 * The compatibility key the office and the built app share: the version plus a hash of the protocol's JSON Schema
 * without descriptions, so a docs-only change keeps the key. The JSON Schema drops regex flags, so the source test
 * pins `u`, not the key.
 */
export function apiId(): string {
  const schemas: Record<string, z.ZodType> = {}
  for (const [name, value] of Object.entries(S)) if (value instanceof z.ZodType) schemas[name] = value
  return `${cli.version}+${schemaKey(schemas)}`
}

// Regenerate the TS protocol types from the protocol schema.
import { compile } from "json-schema-to-typescript"
import { readFileSync, writeFileSync } from "node:fs"

const schemaUrl = new URL("../schema/protocol.schema.json", import.meta.url)
const outUrl = new URL("../src/gen/protocol.ts", import.meta.url)

const TYPING_KEYS = ["type", "$ref", "anyOf", "oneOf", "allOf", "enum", "const", "properties", "items"]

/** Compiles the schema to TS source, one named export per `$defs` entry. */
export async function generate(): Promise<string> {
  const schema = JSON.parse(readFileSync(schemaUrl, "utf8"))
  // json-schema-to-typescript types an untyped property that has a description or default
  // as an object; any-JSON properties (such as Question.answer) must stay `unknown`.
  for (const def of Object.values<any>(schema.$defs)) {
    for (const prop of Object.values<any>(def.properties ?? {})) {
      if (!TYPING_KEYS.some((k) => k in prop)) prop.tsType = "unknown"
    }
  }
  // Compile each $def as a named export; the root is only a container.
  schema.type = "object"
  schema.properties = Object.fromEntries(Object.keys(schema.$defs).map((k) => [k, { $ref: `#/$defs/${k}` }]))
  schema.additionalProperties = false
  return compile(schema, "AgentCorpProtocol", {
    bannerComment: "// Generated from schema/protocol.schema.json. Do not edit.",
    unreachableDefinitions: true,
  })
}

if (import.meta.main) writeFileSync(outUrl, await generate())

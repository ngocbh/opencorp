// Regenerate the TS protocol types from the protocol schema.
import { compile } from "json-schema-to-typescript"
import { readFileSync, writeFileSync } from "node:fs"

const schemaUrl = new URL("../schema/protocol.schema.json", import.meta.url)
const outUrl = new URL("../src/gen/protocol.ts", import.meta.url)

const TYPING_KEYS = [
  "type", "$ref", "anyOf", "oneOf", "allOf", "enum", "const",
  "properties", "additionalProperties", "patternProperties", "items", "prefixItems",
]

/** Marks `node` and every subschema under it that has no type with `tsType: "unknown"`, in place. */
export function markUntyped(node: any): void {
  if (typeof node !== "object" || node === null) return
  // json-schema-to-typescript types an untyped schema that has a description or default
  // as an object; any-JSON values (such as Question.answer) must stay `unknown`.
  if (!TYPING_KEYS.some((k) => k in node)) node.tsType = "unknown"
  const children = [
    ...Object.values(node.properties ?? {}),
    ...(node.anyOf ?? []),
    ...(node.oneOf ?? []),
    ...(node.prefixItems ?? []),
    node.items,
    node.additionalProperties,
  ]
  for (const child of children) markUntyped(child)
}

// The schema root only holds $defs; json-schema-to-typescript still emits it as this interface.
const ROOT_INTERFACE = "export interface AgentCorpProtocol {\n  [k: string]: unknown;\n}\n"

/** Compiles the schema to TS source, one named export per `$defs` entry. */
export async function generate(): Promise<string> {
  const schema = JSON.parse(readFileSync(schemaUrl, "utf8"))
  for (const def of Object.values(schema.$defs)) markUntyped(def)
  // A root description would become a JSDoc block left orphaned above the next export.
  delete schema.description
  const out = await compile(schema, "AgentCorpProtocol", {
    bannerComment: "// Generated from schema/protocol.schema.json. Do not edit.",
    // Emit every $def, including ones no other def references.
    unreachableDefinitions: true,
    // Length bounds are checked at runtime; tuple unions like [T] | [T, T] are noise in TS.
    ignoreMinAndMaxItems: true,
  })
  if (!out.includes(ROOT_INTERFACE)) throw new Error("unexpected root output from json-schema-to-typescript")
  return out.replace(ROOT_INTERFACE, "")
}

if (import.meta.main) writeFileSync(outUrl, await generate())

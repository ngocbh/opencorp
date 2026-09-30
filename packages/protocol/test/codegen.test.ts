import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { generate, markUntyped } from "../scripts/gen_ts"

test("generated types are current", async () => {
  const current = readFileSync(new URL("../src/gen/protocol.ts", import.meta.url), "utf8")
  expect(await generate()).toBe(current)
})

test("untyped subschemas become unknown at any depth", () => {
  const schema: any = {
    type: "object",
    properties: {
      top: { description: "any JSON" },
      list: { type: "array", items: { default: {} } },
      tuple: { type: "array", prefixItems: [{ description: "first" }] },
      either: { anyOf: [{ description: "any" }, { type: "null" }] },
      one: { oneOf: [{ default: 1 }, { type: "string" }] },
      map: { type: "object", additionalProperties: { description: "value" } },
      open: { additionalProperties: false },
      typed: { type: "string", description: "a string" },
    },
  }
  markUntyped(schema)
  const p = schema.properties
  expect(schema.tsType).toBeUndefined()
  expect(p.top.tsType).toBe("unknown")
  expect(p.list.items.tsType).toBe("unknown")
  expect(p.tuple.prefixItems[0].tsType).toBe("unknown")
  expect(p.either.anyOf[0].tsType).toBe("unknown")
  expect(p.one.oneOf[0].tsType).toBe("unknown")
  expect(p.map.additionalProperties.tsType).toBe("unknown")
  expect(p.open.tsType).toBeUndefined()
  expect(p.typed.tsType).toBeUndefined()
})

test("exports are exactly the schema's $defs", () => {
  const schema = JSON.parse(readFileSync(new URL("../schema/protocol.schema.json", import.meta.url), "utf8"))
  const source = readFileSync(new URL("../src/gen/protocol.ts", import.meta.url), "utf8")
  const exported = [...source.matchAll(/^export (?:type|interface) (\w+)/gm)].map((m) => m[1])
  expect(exported.sort()).toEqual(Object.keys(schema.$defs).sort())
})

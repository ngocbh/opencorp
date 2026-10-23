import { expect, test } from "bun:test"
import { z } from "zod"
import cli from "../../cli/package.json" with { type: "json" }
import { apiId, schemaKey } from "@opencorp/protocol/version"

test("the key is the version and the schema hash", () => {
  const id = apiId()
  expect(id.startsWith(`${cli.version}+`)).toBe(true)
  expect(id.slice(cli.version.length + 1)).toMatch(/^[0-9a-f]{12}$/u)
})

test("a docs only change keeps the key", () => {
  const plain = schemaKey({ A: z.strictObject({ name: z.string() }) })
  const documented = schemaKey({ A: z.strictObject({ name: z.string().describe("docs") }).meta({ description: "more" }) })
  expect(documented).toBe(plain)
  expect(schemaKey({ A: z.strictObject({ description: z.string() }) }))
    .not.toBe(schemaKey({ A: z.strictObject({ other: z.string() }) }))
})

test("a schema change changes the key", () => {
  const before = schemaKey({ A: z.strictObject({ name: z.string().regex(/^a$/u) }) })
  expect(schemaKey({ A: z.strictObject({ name: z.string().regex(/^a$/u), more: z.string() }) })).not.toBe(before)
  expect(schemaKey({ A: z.strictObject({ name: z.string().regex(/^b$/u) }) })).not.toBe(before)
})

test("the key is stable", () => {
  expect(apiId()).toBe(apiId())
})

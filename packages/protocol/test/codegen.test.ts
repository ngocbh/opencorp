import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { generate } from "../scripts/gen_ts"

test("generated types are current", async () => {
  const current = readFileSync(new URL("../src/gen/protocol.ts", import.meta.url), "utf8")
  expect(await generate()).toBe(current)
})

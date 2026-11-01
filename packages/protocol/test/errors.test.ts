import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { z } from "zod"
import { ERROR_CODES, OFFICE, validationMessage } from "@opencorp/protocol"
import * as Schemas from "@opencorp/protocol/schemas"

const FIXTURES = new URL("./fixtures/", import.meta.url)
const PACKAGES = new URL("../../", import.meta.url)

const SECRET = "sk-PLANTED-0123456789"
const HASH = "d07f963c2bb7a3cc74a910e51ca0075b194da412a93737881f105a55156a988f"

const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"))

/** The 422 text for `data`, which must fail `schema`. */
function message(schema: z.ZodType, data: unknown) {
  const result = schema.safeParse(data)
  if (result.success) throw new Error(`expected ${JSON.stringify(data)} to fail`)
  return validationMessage(schema, result.error, data)
}

test("422 text never holds an input value or an unknown key", () => {
  const person = fixture("Person.json")
  const chat = fixture("Message.json")
  const cases: [z.ZodType, unknown, string][] = [
    [Schemas.HqLoginRequest, { handle: "x", password: "p", [SECRET]: 1 }, "an extra field: isn't allowed"],
    [
      Schemas.Person,
      { ...person, devices: [{ name: "macbook", token_sha256: HASH, [SECRET]: 1 }] },
      "devices: has an unknown field",
    ],
    [Schemas.HqLoginRequest, { handle: "x", password: { [SECRET]: SECRET } }, "password: has the wrong type"],
    [Schemas.Person, { ...person, kind: SECRET }, "kind: isn't an allowed value"],
    [Schemas.Message, { ...chat, parts: [{ ...chat.parts[0], type: SECRET }] }, "parts: isn't an allowed value"],
    [Schemas.HqLoginRequest, { handle: "x", password: "p", label: SECRET.repeat(10) }, "label: is too long"],
    [Schemas.AddDeviceRequest, { name: "macbook", token_sha256: SECRET }, "token_sha256: isn't in the right format"],
    [Schemas.SetupPrompt, { type: SECRET, text: SECRET }, "type: isn't an allowed value"],
    [
      Schemas.Asset,
      { id: "cluster-a", kind: "slurm_cluster", tools: { [SECRET]: { risk: "bogus" } } },
      "tools: isn't an allowed value",
    ],
  ]
  for (const [schema, data, expected] of cases) {
    const text = message(schema, data)
    expect(text).not.toContain("sk-PLANTED")
    expect([data, text]).toEqual([data, expected])
  }
})

test("422 text names the field and a fixed phrase", () => {
  const cat = z.strictObject({ type: z.literal("cat"), lives: z.int() })
  const dog = z.strictObject({ type: z.literal("dog"), good: z.boolean() })
  const pets = z.strictObject({ colour: z.enum(["red", "blue"]), pet: z.discriminatedUnion("type", [cat, dog]) })
  const cases: [z.ZodType, unknown, string][] = [
    [Schemas.HqLoginRequest, { handle: "x" }, "password: is required"],
    [Schemas.SetPasswordRequest, { password: "short" }, "password: is too short"],
    [Schemas.HqLoginRequest, { handle: "x", password: "p", zz: 1 }, "an extra field: isn't allowed"],
    [Schemas.Ack, [], "body: has the wrong type"],
    [Schemas.Person, fixture("invalid/Person.device-without-hash.json"), "devices: is required"],
    [Schemas.HqLoginRequest, { handle: "x", zz: 1 }, "password: is required; an extra field: isn't allowed"],
    [Schemas.Ack, {}, "ok: is required"],
    [Schemas.SetupPrompt, { text: "hi" }, "type: is required"],
    [z.strictObject({ toString: z.string() }), {}, "toString: is required"],
    [pets, { colour: SECRET, pet: { type: SECRET } }, "colour: isn't an allowed value; pet: isn't an allowed value"],
    [z.strictObject({ indices: z.array(z.int()) }), { indices: ["a", "b", "c"] }, "indices: has the wrong type"],
  ]
  for (const [schema, data, text] of cases) expect([data, message(schema, data)]).toEqual([data, text])
})

test("the shared constants keep their values", () => {
  expect(OFFICE).toBe("office")
})

test("every code a client branches on is a protocol error code", () => {
  // The client makes these itself; the office never sends them.
  const own = new Set(["office_unavailable", "timeout"])
  const branch = /\.code [!=]== "([a-z_]+)"/g
  // Guards against matching packages/tui/src/routes/session/index.tsx's `typeof code === "number"`.
  expect('typeof code === "number"'.match(branch)).toBeNull()
  const found = new Set<string>()
  for (const pkg of ["client", "cli", "app", "tui"]) {
    const src = new URL(`${pkg}/src/`, PACKAGES)
    const files = readdirSync(src, { recursive: true, encoding: "utf8" })
    for (const file of files) {
      if (file.split("/").includes("node_modules") || !/\.tsx?$/.test(file)) continue
      for (const m of readFileSync(new URL(file, src), "utf8").matchAll(branch)) found.add(m[1]!)
    }
  }
  expect(found.size).toBeGreaterThan(0)
  const codes: readonly string[] = ERROR_CODES
  expect([...found].filter((code) => !own.has(code) && !codes.includes(code))).toEqual([])
})

test("the office never says a log is still being read", () => {
  expect<readonly string[]>(ERROR_CODES).not.toContain("indexing")
})

test("the codex session codes are protocol error codes", () => {
  const codes: readonly string[] = ERROR_CODES
  for (const code of [
    "codex_refused",
    "ending",
    "live",
    "not_an_agent",
    "not_continuable",
    "not_live",
    "not_supported",
    "refused",
    "start_failed",
    "unsafe_workspace",
    "unsupported_harness",
  ])
    expect(codes).toContain(code)
})

test("a company repo mid-merge, mid-rebase or locked has a protocol error code", () => {
  expect<readonly string[]>(ERROR_CODES).toContain("company_repo_busy")
})

test("a blank message or a bad model name is refused without its value", () => {
  const model = (value: string) => ({ connection: "office", model: value })
  const cases: [z.ZodType, unknown, string, string][] = [
    [Schemas.PromptRequest, { text: " \u0000\u200b " }, "text: isn't in the right format", "\u200b"],
    [Schemas.PromptRequest, { text: "" }, "text: is too short", ""],
    [Schemas.SetModelRequest, model(" PLANTED"), "model: isn't in the right format", "PLANTED"],
    [Schemas.SetModelRequest, model("PLANTED".repeat(43)), "model: is too long", "PLANTED"],
  ]
  for (const [schema, data, expected, planted] of cases) {
    const text = message(schema, data)
    if (planted) expect(text).not.toContain(planted)
    expect([data, text]).toEqual([data, expected])
  }
})

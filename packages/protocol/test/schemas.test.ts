import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { z } from "zod"
import * as Schemas from "@opencorp/protocol/schemas"

const FIXTURES = new URL("./fixtures/", import.meta.url)
const INVALID = new URL("./fixtures/invalid/", import.meta.url)
const SOURCES = new URL("../src/schemas/", import.meta.url)

const HASH = "d07f963c2bb7a3cc74a910e51ca0075b194da412a93737881f105a55156a988f"
const PASSWORD_HASH = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$Z2lHqGqVnSkfU3gS2tlFp2Yzqm7AAw0EC5lyE4X4bMI"

/** Today's protocol defs: every one has a zod schema of the same name. */
const NAMES = [
  "Id", "Handle", "Ulid", "GitId", "DeviceName", "TokenHash", "Device", "PasswordHash", "ConnectionName",
  "Timestamp", "CompanyDefaults", "Company", "HarnessPolicy", "Sop", "Routine", "Person", "Group",
  "AssetTool", "Grant", "Asset", "WorkItem", "Comment", "Session", "HarnessUsage", "Message", "Part",
  "TextPart", "FilePart", "ToolPart", "ErrorPart", "Permission", "QuestionOption", "QuestionPage",
  "AnswerField", "DiscussionEntry", "Question", "Profile", "ProfileProposal", "FollowUp", "Debrief",
  "Feedback", "Event", "LiveEvent", "CreateSessionRequest", "PromptRequest", "Ack", "CostCapRequest",
  "RepoIssue", "CompanyView", "CommitInfo", "CompanyTreeEntry", "CompanyTree", "CompanyFile", "RunSummary",
  "RunPage", "RunUsage", "RunDetail", "RunNode", "RunDivider", "RunNodePage", "RunEvent", "RunEventPage",
  "RunUpdated", "PersonCost", "CostReport", "ApiVersion", "AppBuild", "Health", "HqTcp", "HqStatus",
  "PairCodeRequest", "PairCode", "PairRequest", "BrowserSession", "HqLoginRequest", "HireRequest",
  "HireResponse", "ApiError", "AnswerRequest", "SideChatRequest", "SendBackRequest", "ProfileWriteRequest",
  "VersionConflict", "ProfileManagerRequest", "FeedbackRequest", "ConfirmFollowUpsRequest",
  "AddDeviceRequest", "LoginRequest", "SetPasswordRequest", "Connection", "ConnectionList", "ModelOption",
  "ModelList", "SetModelRequest", "AddConnectionRequest", "SetDefaultConnectionRequest", "StartLoginRequest",
  "ConnectionLogin", "SetupPrompt", "SetupAsk", "SetupChoose", "SetupSecret", "SetupSay", "SetupStep",
  "SetupAnswer",
]

/** The zod schema exported under `name`. */
function schema(name: string): z.ZodType {
  return (Schemas as Record<string, z.ZodType>)[name]
}

/** The JSON files in `dir`, by file stem, sorted. */
function stems(dir: URL): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort()
}

/** The parsed JSON of `<stem>.json` in `dir`. */
function load(dir: URL, stem: string): unknown {
  return JSON.parse(readFileSync(new URL(`${stem}.json`, dir), "utf8"))
}

/** The exported object schemas, by name. */
function objects(): [string, z.ZodObject][] {
  return NAMES.map((name): [string, z.ZodType] => [name, schema(name)])
    .filter((entry): entry is [string, z.ZodObject] => entry[1] instanceof z.ZodObject)
}

/** The keys of `object` a value must carry: those without a default. */
function required(object: z.ZodObject): string[] {
  return Object.entries(object.shape).filter(([, field]) => !(field instanceof z.ZodDefault)).map(([key]) => key)
}

/** Every `src/schemas/*.ts` file as a `[file, text]` pair. */
function sources(): [string, string][] {
  return readdirSync(SOURCES).filter((f) => f.endsWith(".ts"))
    .map((f) => [f, readFileSync(new URL(f, SOURCES), "utf8")])
}

/** The value at `path` inside `data`. */
function valueAt(data: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>((at, key) => (at as Record<string | number, unknown>)[key], data)
}

/** A copy of `data` with the value at `path` set to `value`. */
function withValue(data: unknown, path: (string | number)[], value: unknown): unknown {
  const copy = structuredClone(data)
  const parent = valueAt(copy, path.slice(0, -1)) as Record<string | number, unknown>
  parent[path.at(-1)!] = value
  return copy
}

test.each(stems(FIXTURES))("fixture validates [%s]", (stem) => {
  const result = schema(stem).safeParse(load(FIXTURES, stem))
  expect(result.error).toBeUndefined()
  expect(result.success).toBe(true)
})

test("there are invalid fixtures", () => {
  expect(stems(INVALID).length).toBeGreaterThan(0)
  // An empty valid folder would make the test.each above run nothing.
  expect(stems(FIXTURES).length).toBeGreaterThan(0)
})

// invalid/<Def>.<case>.json
test.each(stems(INVALID))("schema rejects [%s]", (stem) => {
  const def = stem.split(".", 1)[0]
  expect(schema(def).safeParse(load(INVALID, stem)).success).toBe(false)
})

test("every def has a zod schema of the same name", () => {
  const exported = Object.keys(Schemas).filter((name) => schema(name) instanceof z.ZodType)
  expect(exported.sort()).toEqual([...NAMES].sort())
})

test.each(NAMES)("schema is valid [%s]", (name) => {
  expect(() => z.toJSONSchema(schema(name))).not.toThrow()
})

test("objects are closed and have no format", () => {
  expect(objects().filter(([, object]) => !(object.def.catchall instanceof z.ZodNever)).map(([name]) => name))
    .toEqual([])
  expect(NAMES.filter((name) => /"format"|"\$id"/.test(JSON.stringify(z.toJSONSchema(schema(name))))))
    .toEqual([])
})

const ENTITIES = [
  "Company", "Person", "Group", "Asset", "WorkItem", "Comment", "Session", "Message", "Permission", "Question",
  "Profile", "ProfileProposal", "Debrief", "Feedback", "Event", "LiveEvent",
]

test("every entity has a fixture", () => {
  expect(stems(FIXTURES)).toEqual(expect.arrayContaining(ENTITIES))
})

const BODIES = [
  "CreateSessionRequest", "PromptRequest", "Ack", "CostCapRequest", "RepoIssue", "HireRequest", "HireResponse",
  "ApiError", "AnswerRequest", "SideChatRequest", "SendBackRequest", "ProfileWriteRequest", "VersionConflict",
  "ProfileManagerRequest", "FeedbackRequest", "ConfirmFollowUpsRequest", "AddDeviceRequest", "LoginRequest",
  "SetPasswordRequest", "Connection", "ConnectionList", "ModelOption", "ModelList", "SetModelRequest",
  "AddConnectionRequest", "SetDefaultConnectionRequest", "StartLoginRequest", "ConnectionLogin", "CompanyView",
  "CostReport", "Health", "HqStatus", "PairCodeRequest", "PairCode", "PairRequest", "BrowserSession",
  "HqLoginRequest", "CompanyTree", "CompanyFile", "RunPage", "RunDetail", "RunNodePage", "RunEventPage",
  "RunEvent",
]

test("every route body has a fixture", () => {
  expect(stems(FIXTURES)).toEqual(expect.arrayContaining(BODIES))
})

const SETUP = ["SetupAsk", "SetupChoose", "SetupSecret", "SetupSay", "SetupStep", "SetupAnswer"]

test("every setup message has a fixture", () => {
  expect(stems(FIXTURES)).toEqual(expect.arrayContaining(SETUP))
})

test("optional fields default", () => {
  // Every optional field has a default (null when nothing else fits), so a parsed value is always complete.
  const optional = objects().flatMap(([name, object]) =>
    Object.entries(object.shape).filter(([, field]) => field instanceof z.ZodOptional)
      .map(([key]) => `${name}.${key}`))
  expect(optional).toEqual([])
  expect(sources().filter(([, text]) => text.includes(".optional(")).map(([file]) => file)).toEqual([])
})

test("harness session fields exist", () => {
  expect(Schemas.Question.shape.source.options).toContain("harness")
  expect(Object.keys(Schemas.Session.shape)).toEqual(
    expect.arrayContaining(["harness_model", "harness_usage", "parent_session_id"]))
  expect(Object.keys(Schemas.Message.shape)).toContain("author")
  expect(Object.keys(Schemas.QuestionPage.shape)).toContain("secret")
})

const HQ = [
  "CompanyView", "PersonCost", "CostReport", "ApiVersion", "AppBuild", "Health", "HqTcp", "HqStatus",
  "PairCodeRequest", "PairCode", "PairRequest", "BrowserSession", "HqLoginRequest",
]

test("hq defs exist and company updated is an event type", () => {
  expect(Object.keys(Schemas)).toEqual(expect.arrayContaining(HQ))
  expect(Schemas.Event.shape.type.options).toContain("company.updated")
  expect(Schemas.HqStatus.shape.socket_error.parse(undefined)).toBeNull()
})

test("a browser session never carries its secret or password fingerprint", () => {
  const keys = Object.keys(Schemas.BrowserSession.shape)
  for (const key of ["secret", "secret_sha256", "password_fp"]) expect(keys).not.toContain(key)
  expect(Schemas.BrowserSession.shape.via.options).toEqual(["pair", "login"])
})

test("a login request is closed and needs a password", () => {
  expect(Schemas.HqLoginRequest.def.catchall).toBeInstanceOf(z.ZodNever)
  expect(required(Schemas.HqLoginRequest)).toEqual(["handle", "password"])
  expect(Schemas.HqLoginRequest.shape.password.minLength).toBe(1)
})

/** The defs named by the invalid fixtures, `invalid/<Def>.<case>.json`. */
function invalidDefs(): string[] {
  return stems(INVALID).map((stem) => stem.split(".", 1)[0])
}

const SOURCE = ["CommitInfo", "CompanyTreeEntry", "CompanyTree", "CompanyFile"]

test("source defs have fixtures", () => {
  expect(stems(FIXTURES)).toEqual(expect.arrayContaining(SOURCE))
  expect(invalidDefs()).toEqual(expect.arrayContaining(SOURCE))
})

test("source entry types and file states", () => {
  expect(Schemas.CompanyTreeEntry.shape.type.options).toEqual(["file", "folder", "symlink", "submodule"])
  expect(Schemas.CompanyFile.shape.content.options).toEqual(
    ["text", "binary", "too_large", "hidden", "symlink", "submodule"])
  expect(required(Schemas.CompanyFile)).toEqual(["path", "commit", "content"])
  expect(required(Schemas.CompanyTree)).toEqual(["commit", "entries", "truncated", "skipped"])
})

test("a commit names its author without an email", () => {
  expect(required(Schemas.CommitInfo)).toEqual(["id", "subject", "author", "time"])
  expect(Object.keys(Schemas.CommitInfo.shape)).toEqual(["id", "subject", "author", "time"])
  expect(Schemas.CommitInfo.shape.time).toBe(Schemas.Timestamp)
})

const RUNS = [
  "RunSummary", "RunPage", "RunUsage", "RunDetail", "RunNode", "RunDivider", "RunNodePage", "RunEvent",
  "RunEventPage", "RunUpdated",
]
const RUN_STATUSES = ["running", "waiting", "idle", "finished", "failed", "interrupted"]

test("run defs have fixtures", () => {
  expect(stems(FIXTURES)).toEqual(expect.arrayContaining(RUNS))
  expect(invalidDefs()).toEqual(expect.arrayContaining(RUNS))
})

test("run statuses node statuses and log states", () => {
  expect<string[]>(Schemas.RunSummary.shape.status.options).toEqual(RUN_STATUSES)
  expect<string[]>(Schemas.RunUpdated.shape.status.options).toEqual(RUN_STATUSES)
  expect(Schemas.RunNode.shape.status.options).toEqual(
    ["open", "succeeded", "routed", "expanded", "failed", "restarted"])
  expect(Schemas.RunDetail.shape.log_state.options).toEqual(
    ["ok", "indexing", "missing", "not_started", "unsupported_schema"])
})

test("run updated is an event type", () => {
  expect(Schemas.Event.shape.type.options).toContain("run.updated")
})

test.each([["RunSummary", "reason"], ["RunNode", "error"]] as const)(
  "a reason and a node error are capped at 200 characters [%s]",
  (def, key) => {
    const data = load(FIXTURES, def) as object
    expect(schema(def).safeParse({ ...data, [key]: "x".repeat(200) }).success).toBe(true)
    expect(schema(def).safeParse({ ...data, [key]: "x".repeat(201) }).success).toBe(false)
  },
)

test.each([["RunNodePage", Schemas.RunNodePage], ["RunEventPage", Schemas.RunEventPage]] as const)(
  "node and record pages can say the log is still being read [%s]",
  (_, page) => {
    expect(page.shape.indexing.parse(undefined)).toBe(false)
    expect(page.shape.indexing.safeParse("yes").success).toBe(false)
    expect(Object.keys(page.shape)).toEqual(expect.arrayContaining(["bytes_done", "bytes_total"]))
  },
)

test("a node kind is nullable and optional", () => {
  const { kind: _, ...data } = load(FIXTURES, "RunNode") as Record<string, unknown>
  expect(Schemas.RunNode.parse(data).kind).toBeNull()
  expect(Schemas.RunNode.parse({ ...data, kind: null }).kind).toBeNull()
})

// Behaviour: what parsing keeps, fills in and refuses.

test.each(stems(FIXTURES))("fixture round trips [%s]", (stem) => {
  const data = load(FIXTURES, stem)
  expect(schema(stem).parse(data)).toMatchObject(data as object)
})

test.each(stems(FIXTURES))("full dump validates [%s]", (stem) => {
  // A parsed value, defaults and all, is what gets written; it must parse again unchanged.
  const parsed = schema(stem).parse(load(FIXTURES, stem))
  expect(schema(stem).parse(parsed)).toEqual(parsed)
})

const PERSON_CHANGES: Record<string, unknown>[] = [
  { handle: "a_b" }, { manager: "Minh" }, { groups: ["a--b"] }, { id: "minh" }, { colour: "blue" },
  { devices: [{ name: "macbook", token_sha256: HASH.slice(0, -1) }] },
  { devices: [{ name: "macbook", token_sha256: HASH.toUpperCase() }] },
  { devices: [{ name: "Mac Book", token_sha256: HASH }] },
  { devices: [{ name: "macbook", token_sha256: HASH, token: "x" }] },
  { password_hash: "hunter22" }, { password_hash: "" },
]

test.each(PERSON_CHANGES.map((change) => [JSON.stringify(change), change] as const))(
  "generated models keep constraints [%s]",
  (_, change) => {
    const data = load(FIXTURES, "Person") as object
    expect(Schemas.Person.safeParse({ ...data, ...change }).success).toBe(false)
  },
)

test("a person may carry a password hash as a phc string", () => {
  const data = load(FIXTURES, "Person") as object
  expect(Schemas.Person.parse({ ...data, password_hash: PASSWORD_HASH }).password_hash).toBe(PASSWORD_HASH)
  expect(Schemas.Person.parse(data).password_hash).toBeNull()
})

test("a new password has at least 8 characters", () => {
  expect(Schemas.SetPasswordRequest.safeParse({ password: "short" }).success).toBe(false)
  expect(Schemas.SetPasswordRequest.parse({ password: "12345678" }).password).toBe("12345678")
})

test("a device holds only its token hash", () => {
  const devices = [{ name: "macbook", token_sha256: HASH }, { name: "devgpu-1.cluster", token_sha256: HASH }]
  const person = Schemas.Person.parse({ ...(load(FIXTURES, "Person") as object), devices })
  expect(person.devices.map((d) => d.name)).toEqual(["macbook", "devgpu-1.cluster"])
})

test("parts are a discriminated union", () => {
  const data = load(FIXTURES, "Message") as { parts: { type: string }[] }
  data.parts[0].type = "image"
  const issues = Schemas.Message.safeParse(data).error?.issues ?? []
  expect(issues.map((issue) => issue.code)).toEqual(["invalid_union"])
  expect((issues[0] as { note?: string }).note).toBe("No matching discriminator")
})

test("setup prompts are a discriminated union", () => {
  expect(Schemas.SetupPrompt.parse(load(FIXTURES, "SetupChoose")).type).toBe("choose")
  const issues = Schemas.SetupPrompt.safeParse({ type: "shout", text: "hi" }).error?.issues ?? []
  expect(issues.map((issue) => issue.code)).toEqual(["invalid_union"])
  expect((issues[0] as { note?: string }).note).toBe("No matching discriminator")
})

test("a choice takes no typed answer unless it says so", () => {
  const choose = Schemas.SetupChoose.parse({ type: "choose", question: "Model provider", options: ["anthropic"] })
  expect(choose.typed).toBe(false)
  expect(JSON.parse(JSON.stringify(choose)).typed).toBe(false)
  expect(Schemas.SetupChoose.parse(load(FIXTURES, "SetupChoose")).typed).toBe(true)
})

test("company defaults no longer take idle end", () => {
  expect(Schemas.CompanyDefaults.safeParse({ idle_end: "2h" }).success).toBe(false)
})

/**
 * One row per pattern site: a valid fixture holding a value at `path` (or given `value` when it holds none),
 * which parses, and a `bad` value there that the pattern refuses. `invalid` lists the invalid fixtures that
 * target the site.
 */
const PATTERNS: {
  site: string; def: string; path: (string | number)[]; value?: string; bad: string; invalid: string[]
}[] = [
  { site: "Id", def: "Group", path: ["id"], bad: "a--b", invalid: ["Group.uppercase-slug"] },
  { site: "Handle", def: "Person", path: ["handle"], bad: "a_b", invalid: [] },
  {
    site: "Ulid", def: "WorkItem", path: ["id"], bad: "01JA1W0000000000000000000U", invalid: ["WorkItem.bad-ulid"],
  },
  { site: "GitId", def: "CommitInfo", path: ["id"], bad: "0123456", invalid: ["CompanyFile.short-commit"] },
  { site: "DeviceName", def: "AddDeviceRequest", path: ["name"], bad: "Mac Book", invalid: [] },
  {
    site: "TokenHash", def: "AddDeviceRequest", path: ["token_sha256"], bad: HASH.toUpperCase(),
    invalid: ["AddDeviceRequest.uppercase-hash"],
  },
  // No valid fixture holds a password hash, so Person.json takes Python's.
  {
    site: "PasswordHash", def: "Person", path: ["password_hash"], value: PASSWORD_HASH, bad: "hunter22",
    invalid: ["Person.password-not-hashed"],
  },
  {
    site: "ConnectionName", def: "SetModelRequest", path: ["connection"], bad: "Office",
    invalid: ["SetModelRequest.uppercase-connection"],
  },
  {
    site: "Timestamp", def: "Comment", path: ["created_at"], bad: "2026-09-29T10:05:00Z",
    invalid: ["Comment.timestamp-without-ms", "Comment.timestamp-not-utc-z"],
  },
  {
    site: "Grant.who", def: "Asset", path: ["grants", 0, "who"], bad: "group:Infra",
    invalid: ["Asset.uppercase-grant-group"],
  },
  {
    site: "CompanyFile.path", def: "CompanyFile", path: ["path"], bad: "/company.yaml",
    invalid: ["CompanyFile.empty-segment", "CompanyFile.leading-slash"],
  },
  {
    site: "CompanyTreeEntry.path", def: "CompanyTree", path: ["entries", 0, "path"], bad: "people/minh/",
    invalid: ["CompanyTreeEntry.trailing-slash"],
  },
  {
    site: "RunDetail.flow_fingerprint", def: "RunDetail", path: ["flow_fingerprint"], bad: "abc",
    invalid: ["RunDetail.short-fingerprint"],
  },
]

test("every pattern carries the u flag", () => {
  const text = sources().map(([, source]) => source).join("\n")
  const literals = [...text.matchAll(/\.regex\(\/((?:\\.|[^\/\\\n])+)\/([a-z]*)\)/g)]
  expect(PATTERNS.length).toBe(13)
  // Each `.regex(` site needs its own PATTERNS row.
  expect(text.split(".regex(").length - 1).toBe(PATTERNS.length)
  expect(literals.length).toBe(PATTERNS.length)
  expect(literals.filter(([, , flags]) => !flags.includes("u")).map(([, pattern]) => pattern)).toEqual([])
})

test.each(PATTERNS)("each pattern is checked against the fixtures [$site]", ({ def, path, value, bad, invalid }) => {
  let data = load(FIXTURES, def)
  if (value !== undefined) data = withValue(data, path, value)
  expect(typeof valueAt(data, path)).toBe("string")
  expect(schema(def).safeParse(data).error).toBeUndefined()
  const issues = schema(def).safeParse(withValue(data, path, bad)).error?.issues ?? []
  expect(issues.map((issue) => [issue.code, issue.path])).toEqual([["invalid_format", path]])
  expect(invalid.filter((stem) => schema(stem.split(".", 1)[0]).safeParse(load(INVALID, stem)).success))
    .toEqual([])
})

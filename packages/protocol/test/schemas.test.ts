import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { z } from "zod"
import * as Schemas from "@opencorp/protocol/schemas"

const FIXTURES = new URL("./fixtures/", import.meta.url)
const INVALID = new URL("./fixtures/invalid/", import.meta.url)

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

test.each(stems(FIXTURES))("fixture validates [%s]", (stem) => {
  const result = schema(stem).safeParse(load(FIXTURES, stem))
  expect(result.error).toBeUndefined()
  expect(result.success).toBe(true)
})

test("there are invalid fixtures", () => {
  expect(stems(INVALID).length).toBeGreaterThan(0)
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

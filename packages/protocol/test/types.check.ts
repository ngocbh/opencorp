// Type-checked by tsc, not run by bun test.
import type * as Gen from "../src/gen/protocol"
import type { AnswerRequest, HireRequest, Message, Person, Question } from "../src/index"
import type * as Zod from "../src/schemas"

export const minh: Person = {
  handle: "minh", name: "Minh", kind: "agent", title: "Engineer", manager: "ngocbh",
}

export const ceo: Person = {
  handle: "ngocbh", name: "Hong Ngoc Bui", kind: "human", title: "CEO", manager: null,
  devices: [{ name: "macbook", token_sha256: "d07f963c2bb7a3cc74a910e51ca0075b194da412a93737881f105a55156a988f" }],
  password_hash: "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$Z2lHqGqVnSkfU3gS2tlFp2Yzqm7AAw0EC5lyE4X4bMI",
}

export const badKind: Person = {
  // @ts-expect-error kind is "human" | "agent"
  handle: "x", name: "X", kind: "robot", title: "T", manager: null,
}

export const extraField: Person = {
  handle: "x", name: "X", kind: "human", title: "T", manager: null,
  // @ts-expect-error unknown fields are rejected
  colour: "blue",
}

export const message: Message = {
  id: "01JA1M0000000000000000000A", session_id: "01JA1S0000000000000000000A", role: "assistant",
  created_at: "2026-09-29T10:00:05.000Z",
  parts: [{ id: "01JA1P0000000000000000000A", type: "text", text: "hi" }],
}

export const page: Question["questions"] = [
  { question: "Which database?", header: "Database", options: [{ label: "Postgres" }], multi_select: false },
]

export const hire: HireRequest = { name: "Ava", handle: "ava", title: "Researcher", manager: "ngocbh" }

export const officeOnlyKind: AnswerRequest = {
  answer: "Postgres",
  // @ts-expect-error sent_back and interrupted are set by the office, not a client
  answer_kind: "sent_back",
}

// The zod schemas' input types agree with today's generated types, def by def.

/** The string keys of T, per union member. */
type Keys<T> = T extends unknown ? Extract<keyof T, string> : never
/** True when A and B are mutually assignable and have the same string keys. Assignability alone
 * would miss an extra or missing optional key. */
type Same<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? [Exclude<Keys<A>, Keys<B>> | Exclude<Keys<B>, Keys<A>>] extends [never] ? true : false
    : false
  : false
/** Compiles only when A and B agree (see `Same`). */
function agree<A, B>(..._: Same<A, B> extends true ? [] : [never]) {}

// @ts-expect-error an extra optional key is a difference
agree<{ a: string }, { a: string; b?: string }>()

agree<Gen.Id, Zod.Id>()
agree<Gen.Handle, Zod.Handle>()
agree<Gen.Ulid, Zod.Ulid>()
agree<Gen.GitId, Zod.GitId>()
agree<Gen.DeviceName, Zod.DeviceName>()
agree<Gen.TokenHash, Zod.TokenHash>()
agree<Gen.Device, Zod.Device>()
agree<Gen.PasswordHash, Zod.PasswordHash>()
agree<Gen.ConnectionName, Zod.ConnectionName>()
agree<Gen.Timestamp, Zod.Timestamp>()
agree<Gen.CompanyDefaults, Zod.CompanyDefaults>()
agree<Gen.Company, Zod.Company>()
agree<Gen.HarnessPolicy, Zod.HarnessPolicy>()
agree<Gen.Sop, Zod.Sop>()
agree<Gen.Routine, Zod.Routine>()
agree<Gen.Person, Zod.Person>()
agree<Gen.Group, Zod.Group>()
agree<Gen.AssetTool, Zod.AssetTool>()
agree<Gen.Grant, Zod.Grant>()
agree<Gen.Asset, Zod.Asset>()
agree<Gen.WorkItem, Zod.WorkItem>()
agree<Gen.Comment, Zod.Comment>()
agree<Gen.Session, Zod.Session>()
agree<Gen.HarnessUsage, Zod.HarnessUsage>()
agree<Gen.Message, Zod.Message>()
agree<Gen.Part, Zod.Part>()
agree<Gen.TextPart, Zod.TextPart>()
agree<Gen.FilePart, Zod.FilePart>()
agree<Gen.ToolPart, Zod.ToolPart>()
agree<Gen.ErrorPart, Zod.ErrorPart>()
agree<Gen.Permission, Zod.Permission>()
agree<Gen.QuestionOption, Zod.QuestionOption>()
agree<Gen.QuestionPage, Zod.QuestionPage>()
agree<Gen.AnswerField, Zod.AnswerField>()
agree<Gen.DiscussionEntry, Zod.DiscussionEntry>()
agree<Gen.Question, Zod.Question>()
agree<Gen.Profile, Zod.Profile>()
agree<Gen.ProfileProposal, Zod.ProfileProposal>()
agree<Gen.FollowUp, Zod.FollowUp>()
agree<Gen.Debrief, Zod.Debrief>()
agree<Gen.Feedback, Zod.Feedback>()
agree<Gen.Event, Zod.Event>()
agree<Gen.LiveEvent, Zod.LiveEvent>()
agree<Gen.CreateSessionRequest, Zod.CreateSessionRequest>()
agree<Gen.PromptRequest, Zod.PromptRequest>()
agree<Gen.Ack, Zod.Ack>()
agree<Gen.CostCapRequest, Zod.CostCapRequest>()
agree<Gen.RepoIssue, Zod.RepoIssue>()
agree<Gen.CompanyView, Zod.CompanyView>()
agree<Gen.CommitInfo, Zod.CommitInfo>()
agree<Gen.CompanyTreeEntry, Zod.CompanyTreeEntry>()
agree<Gen.CompanyTree, Zod.CompanyTree>()
agree<Gen.CompanyFile, Zod.CompanyFile>()
agree<Gen.RunSummary, Zod.RunSummary>()
agree<Gen.RunPage, Zod.RunPage>()
agree<Gen.RunUsage, Zod.RunUsage>()
agree<Gen.RunDetail, Zod.RunDetail>()
agree<Gen.RunNode, Zod.RunNode>()
agree<Gen.RunDivider, Zod.RunDivider>()
agree<Gen.RunNodePage, Zod.RunNodePage>()
agree<Gen.RunEvent, Zod.RunEvent>()
agree<Gen.RunEventPage, Zod.RunEventPage>()
agree<Gen.RunUpdated, Zod.RunUpdated>()
agree<Gen.PersonCost, Zod.PersonCost>()
agree<Gen.CostReport, Zod.CostReport>()
agree<Gen.ApiVersion, Zod.ApiVersion>()
agree<Gen.AppBuild, Zod.AppBuild>()
agree<Gen.Health, Zod.Health>()
agree<Gen.HqTcp, Zod.HqTcp>()
agree<Gen.HqStatus, Zod.HqStatus>()
agree<Gen.PairCodeRequest, Zod.PairCodeRequest>()
agree<Gen.PairCode, Zod.PairCode>()
agree<Gen.PairRequest, Zod.PairRequest>()
agree<Gen.BrowserSession, Zod.BrowserSession>()
agree<Gen.HqLoginRequest, Zod.HqLoginRequest>()
agree<Gen.HireRequest, Zod.HireRequest>()
agree<Gen.HireResponse, Zod.HireResponse>()
agree<Gen.ApiError, Zod.ApiError>()
agree<Gen.AnswerRequest, Zod.AnswerRequest>()
agree<Gen.SideChatRequest, Zod.SideChatRequest>()
agree<Gen.SendBackRequest, Zod.SendBackRequest>()
agree<Gen.ProfileWriteRequest, Zod.ProfileWriteRequest>()
agree<Gen.VersionConflict, Zod.VersionConflict>()
agree<Gen.ProfileManagerRequest, Zod.ProfileManagerRequest>()
agree<Gen.FeedbackRequest, Zod.FeedbackRequest>()
agree<Gen.ConfirmFollowUpsRequest, Zod.ConfirmFollowUpsRequest>()
agree<Gen.AddDeviceRequest, Zod.AddDeviceRequest>()
agree<Gen.LoginRequest, Zod.LoginRequest>()
agree<Gen.SetPasswordRequest, Zod.SetPasswordRequest>()
agree<Gen.Connection, Zod.Connection>()
agree<Gen.ConnectionList, Zod.ConnectionList>()
agree<Gen.ModelOption, Zod.ModelOption>()
agree<Gen.ModelList, Zod.ModelList>()
agree<Gen.SetModelRequest, Zod.SetModelRequest>()
agree<Gen.AddConnectionRequest, Zod.AddConnectionRequest>()
agree<Gen.SetDefaultConnectionRequest, Zod.SetDefaultConnectionRequest>()
agree<Gen.StartLoginRequest, Zod.StartLoginRequest>()
agree<Gen.ConnectionLogin, Zod.ConnectionLogin>()
agree<Gen.SetupPrompt, Zod.SetupPrompt>()
agree<Gen.SetupAsk, Zod.SetupAsk>()
agree<Gen.SetupChoose, Zod.SetupChoose>()
agree<Gen.SetupSecret, Zod.SetupSecret>()
agree<Gen.SetupSay, Zod.SetupSay>()
agree<Gen.SetupStep, Zod.SetupStep>()
agree<Gen.SetupAnswer, Zod.SetupAnswer>()

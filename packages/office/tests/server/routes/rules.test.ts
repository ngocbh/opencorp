/** The rules routes: a chat's rules, each with its source, the rules files that don't load, and removing a session or
 *  agent rule as the chat's approver. */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { RuleList } from "@opencorp/protocol"
import { parse, stringify } from "yaml"
import { lint } from "../../../src/company/lint.ts"
import { loadRepo } from "../../../src/company/loader.ts"
import { newToken } from "../../../src/runtime/auth/tokens.ts"
import { sessionOption } from "../../../src/runtime/questions/approval.ts"
import type { ScriptedReply } from "../../../src/testing/fake_llm.ts"
import { git } from "../../company/helpers.ts"
import { fakeLlm, type HarnessOffice, makeHarness, noWorkersLeft, running } from "../../features/chat/helpers.ts"
import { waitFor } from "../../helpers.ts"
import { addHuman, bearer, CEO, giveDevice, type Reply, request, served, ULID } from "../helpers.ts"

setDefaultTimeout(60_000)
afterAll(noWorkersLeft)

const AT = "2026-11-20T10:00:00.000Z"
const COMPANY_DENY = { effect: "deny", kind: "command", pattern: "rm -rf *" } as const
const AGENT_ALLOW = { effect: "allow", kind: "command", pattern: "git status *" } as const
const SESSION_ALLOW = { effect: "allow", kind: "command", pattern: "ls *" } as const
const FILES = {
  "rules.yaml": stringify({ rules: [COMPANY_DENY] }),
  "people/minh/rules.yaml": stringify({ rules: [{ ...AGENT_ALLOW, by: CEO, at: AT }] }),
}

/** Words only the chat's requests hold, from its system prompt. */
const CHAT = "You work in the office alongside"
/** The employee's reply once its command ran. */
const LISTED: ScriptedReply = { match: CHAT, content: "Listed." }

/** The employee's reply that runs `command` in the workspace's shell. */
function shell(command: string): ScriptedReply {
  return { match: CHAT, tool_calls: [{ name: "workspace_shell", arguments: { command } }] }
}

function post(sock: string, target: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return request(sock, "POST", target, {
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

/** The reply's error code and message. */
function errorOf(r: Reply): [number, string, string] {
  const { error, message } = r.json() as { error: string; message: string }
  return [r.status, error, message]
}

/** Session `id`'s rules as the office lists them, parsed. */
async function listed(sock: string, id: string, headers: Record<string, string> = {}) {
  const r = await request(sock, "GET", `/sessions/${id}/rules`, { headers })
  expect(r.status).toBe(200)
  return RuleList.parse(r.json())
}

/** Starts minh's chat in `h.folder` as `headers` say (the CEO by default), waits for its first turn and switches it to
 *  ask; returns its id. */
async function chat(h: HarnessOffice, sock: string, headers: Record<string, string> = {}): Promise<string> {
  const r = await post(sock, "/sessions", { person: "minh", cwd: h.folder }, headers)
  expect(r.status).toBe(200)
  const { id } = r.json() as { id: string }
  await waitFor(() => h.store.getSession(id)!.status === "idle", { what: "the first turn" })
  h.store.updateSession(id, { mode: "ask" })
  return id
}

/** Has session `id`'s agent run `ls`, and answers its card "don't ask again" for `ls *`, as the CEO. */
async function sessionRule(h: HarnessOffice, id: string): Promise<void> {
  await h.harness.prompt(id, "list it")
  const open = () => h.store.listQuestions({ sessionId: id, status: "open", source: "approval" })
  await waitFor(() => open().length === 1 && !running(h.registry, id), { what: "the approval card" })
  await h.harness.answer(open()[0]!.id, sessionOption(["ls *"]), "option", { by: CEO })
  await waitFor(() => h.store.getSession(id)!.status === "idle", { what: "the turn's end" })
}

test("a chat lists its session, agent and company rules, each with its source", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"), LISTED)
  const h = await makeHarness(fake, { files: FILES })
  const { sock } = await served(h.office)
  const id = await chat(h, sock)
  await sessionRule(h, id)
  expect(await listed(sock, id)).toEqual({
    rules: [
      { ...SESSION_ALLOW, source: "session", by: null, at: null, note: null },
      { ...AGENT_ALLOW, source: "agent", by: CEO, at: AT, note: null },
      { ...COMPANY_DENY, source: "company", by: null, at: null, note: null },
    ],
    errors: [],
  })
  const missing = await request(sock, "GET", `/sessions/${ULID}/rules`)
  expect(errorOf(missing).slice(0, 2)).toEqual([404, "not_found"])
})

test("a rules file that doesn't load is listed as an error, with the file and lint's message", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { files: { ...FILES, "rules.yaml": "rules: [\n" } })
  const { sock } = await served(h.office)
  const id = await chat(h, sock)
  const linted = (await lint(loadRepo(h.office.paths.company))).find((issue) => issue.path === "rules.yaml")!
  expect(await listed(sock, id)).toEqual({
    rules: [{ ...AGENT_ALLOW, source: "agent", by: CEO, at: AT, note: null }],
    errors: [{ source: "company", path: "rules.yaml", message: linted.message }],
  })
  expect(linted.message).toBe("isn't valid YAML (line 2)")
})

test("the approver removes a session or agent rule, and anyone else is refused", async () => {
  const fake = await fakeLlm()
  fake.script(shell("ls"), LISTED, shell("ls -a"))
  const h = await makeHarness(fake, { files: FILES })
  const company = h.office.paths.company
  addHuman(company, "ava")
  const [ava, ceo] = [newToken(), newToken()]
  giveDevice(company, "ava", "pc", ava)
  giveDevice(company, CEO, "mac", ceo)
  const { sock } = await served(h.office, { tokens: true })
  const id = await chat(h, sock, bearer(ceo))
  await sessionRule(h, id)
  const remove = (rule: Record<string, string>, token: string) => post(sock, `/sessions/${id}/rules/remove`, rule, bearer(token))

  for (const rule of [{ ...SESSION_ALLOW, source: "session" }, { ...AGENT_ALLOW, source: "agent" }]) {
    const refused = await remove(rule, ava)
    expect(errorOf(refused)).toEqual([403, "forbidden", "only @ngocbh may change this chat's rules"])
  }
  expect((await listed(sock, id, bearer(ceo))).rules.map((r) => r.source)).toEqual(["session", "agent", "company"])

  let r = await remove({ ...SESSION_ALLOW, source: "session" }, ceo)
  expect([r.status, r.json()]).toEqual([200, { ok: true }])
  r = await remove({ ...AGENT_ALLOW, source: "agent" }, ceo)
  expect([r.status, r.json()]).toEqual([200, { ok: true }])
  expect(git(company, "log", "-1", "--format=%s")).toBe('Rules: remove allow "git status *" for @minh (by @ngocbh)')
  expect(parse(git(company, "show", "HEAD:people/minh/rules.yaml"))).toEqual({ rules: [] })
  expect((await listed(sock, id, bearer(ceo))).rules.map((x) => x.source)).toEqual(["company"])

  r = await remove({ ...SESSION_ALLOW, source: "session" }, ceo)
  expect(errorOf(r).slice(0, 2)).toEqual([404, "not_found"])
  r = await remove({ ...SESSION_ALLOW, source: "everywhere" }, ceo)
  expect(errorOf(r).slice(0, 2)).toEqual([422, "invalid_body"])

  // The removal applies to the next command: ls asks again.
  await h.harness.prompt(id, "list it again")
  const open = () => h.store.listQuestions({ sessionId: id, status: "open", source: "approval" })
  await waitFor(() => open().length === 1, { what: "a new approval card" })
  expect(open()[0]!.approval!.action).toBe("ls -a")
})

test("a company rule can't be removed through the office: 409 company_rule, saying to edit rules.yaml", async () => {
  const fake = await fakeLlm()
  const h = await makeHarness(fake, { files: FILES })
  const company = h.office.paths.company
  const before = git(company, "rev-parse", "HEAD")
  const { sock } = await served(h.office)
  const id = await chat(h, sock)
  const r = await post(sock, `/sessions/${id}/rules/remove`, { ...COMPANY_DENY, source: "company" })
  expect(errorOf(r)).toEqual([409, "company_rule", "company rules change only by editing rules.yaml in the company repo"])
  expect(git(company, "rev-parse", "HEAD")).toBe(before)
  expect((await listed(sock, id)).rules.map((x) => x.source)).toEqual(["agent", "company"])
})

/** Approval cards: an agent's call held by its yian call id until the session's approver answers, and what the call
 *  returns once they have. */
import { expect, test } from "bun:test"
import { isPending } from "@ngocbh/yian/tools"
import type { Approval } from "@opencorp/protocol"
import { Answers } from "../../../src/runtime/questions/ask.ts"
import {
  alwaysOption,
  approvalOptions,
  approvalResult,
  holdApproval,
  NO_TYPED,
  readAnswer,
  sessionOption,
  YES,
} from "../../../src/runtime/questions/approval.ts"
import { INTERRUPTED } from "../../../src/runtime/questions/format.ts"
import type { Permissions } from "../../../src/runtime/permissions/policy.ts"
import { openStore, session, thrown } from "../store/helpers.ts"

const RUN = "run-1"
const RULES = ["git status *", "ls *"]
const CARD: Approval = { kind: "command", tool: "shell", action: "ls -la", reason: "Ask mode", rules: RULES }
const UNKNOWN =
  "Not run again: the owner approved this, but the office stopped before its result came back, so it may or may not " +
  "have run."

/** A store with one session, its `Answers`, and a `hold` for the session's run; `always` says whether always-rules
 *  are kept. */
function setup({ always = false }: { always?: boolean } = {}) {
  const store = openStore()
  const s = store.createSession(session())
  const answers = new Answers(store, { log: () => {} })
  const hold = holdApproval(s, RUN, (q, o) => answers.ask(q, o), { always })
  return { store, s, hold }
}

/** The call id of the `n`th call of the run's node `n`. */
const call = (n = 1) => `${RUN}/n/${n}/0`

test("an approval card offers Yes, then don't ask again this session and always, with the rules it would add", () => {
  expect(approvalOptions(RULES, true)).toEqual([
    "Yes",
    "Yes, and don't ask again this session for: git status *, ls *",
    "Yes, and always allow: git status *, ls *",
  ])
  const { store, hold } = setup({ always: true })
  hold(CARD, call())
  const card = store.getQuestionByCall(call())!
  expect([card.title, card.options]).toEqual(["@minh wants to run a command", approvalOptions(RULES, true)])
  expect(NO_TYPED).toBe("No, and tell the agent what to do instead")
})

test("a card with no rules to add offers only Yes", () => {
  expect(approvalOptions([], true)).toEqual([YES])
  expect(approvalOptions([], false)).toEqual([YES])
  const { store, hold } = setup({ always: true })
  hold({ ...CARD, rules: [] }, call())
  expect(store.getQuestionByCall(call())!.options).toEqual([YES])
})

test("a card offers always only where always-rules are kept", () => {
  expect(approvalOptions(RULES, false)).toEqual([YES, sessionOption(RULES)])
  const { store, hold } = setup({ always: false })
  hold(CARD, call())
  expect(store.getQuestionByCall(call())!.options).toEqual([YES, sessionOption(RULES)])
})

test("holding a call stores one card for its call id, asked by the agent, and replies pending", () => {
  const { store, s, hold } = setup()
  const result = hold(CARD, call())
  expect(isPending(result)).toBe(true)
  const card = store.getQuestionByCall(call())!
  expect(card.call_id).toBe("run-1/n/1/0")
  expect(card.asker).toBe(s.person)
  expect([card.source, card.session_id, card.run_id, card.node_id, card.status]).toEqual([
    "approval",
    s.id,
    RUN,
    null,
    "open",
  ])
  expect(card.approval).toEqual({
    kind: "command", tool: "shell", action: "ls -la", args: {}, why: "", reason: "Ask mode", rules: RULES,
    partial: false, into: null,
  })
  expect(card.question).toBe("ls -la")
  expect(isPending(hold(CARD, call()))).toBe(true)
  expect(store.listQuestions({ sessionId: s.id }).map((q) => q.id)).toEqual([card.id])

  hold({ kind: "input", tool: "terminal_type", action: "y", reason: "Ask mode", partial: true, into: "ssh h" }, call(2))
  const typed = store.getQuestionByCall(call(2))!
  expect(typed.title).toBe("@minh wants to type into a running command")
  expect([typed.approval?.partial, typed.approval?.into]).toEqual([true, "ssh h"])
})

test("a hold is what a session's permissions hold a gated call with", () => {
  const { store, hold } = setup()
  // The policy's card, read-only rules and all, is one a hold takes.
  const bound: Permissions["hold"] = hold
  bound({ ...CARD, args: {}, why: "", rules: RULES, partial: false, into: null }, call())
  expect(store.getQuestionByCall(call())!.approval!.action).toBe("ls -la")
})

test("a card that isn't valid is refused, naming only the bad fields", () => {
  const { store, s, hold } = setup()
  const bad = { ...CARD, kind: "file", action: "cat /secret/planted" } as unknown as Approval
  const error = thrown(() => hold(bad, call())) as Error
  expect(error).toBeInstanceOf(TypeError)
  expect(error.message).toMatch(/^approval: /)
  expect(error.message).not.toContain("planted")
  expect(store.listQuestions({ sessionId: s.id })).toEqual([])
})

test("the card shows the action numbered, with odd characters visible", () => {
  const { store, hold } = setup()
  hold({ ...CARD, action: "ls\nrm x" }, call(1))
  expect(store.getQuestionByCall(call(1))!.question).toBe("  1  ls\n  2  rm x")
  hold({ ...CARD, action: "echo ‮txt.exe" }, call(2))
  expect(store.getQuestionByCall(call(2))!.question).toBe("echo <U+202E>txt.exe")
  // The card keeps the action exactly as it would run.
  expect(store.getQuestionByCall(call(2))!.approval!.action).toBe("echo ‮txt.exe")
})

test("a typed answer is No with the approver's words; Yes, don't ask again and always read as yes, session and always", () => {
  const { store, hold } = setup({ always: true })
  const answered = (n: number, answer: string, kind: "option" | "text" | "interrupted") => {
    hold(CARD, call(n))
    const card = store.getQuestionByCall(call(n))!
    return readAnswer(store.answerQuestion(card.id, answer, kind, "ngocbh"))
  }
  expect(answered(1, "use rg instead", "text")).toEqual({ answer: "no", say: "use rg instead" })
  expect(answered(2, YES, "option")).toEqual({ answer: "yes" })
  expect(answered(3, sessionOption(RULES), "option")).toEqual({ answer: "session" })
  expect(answered(4, alwaysOption(RULES), "option")).toEqual({ answer: "always" })
  expect(answered(5, INTERRUPTED, "interrupted")).toEqual({ answer: "interrupted" })
})

test("a call held again after its card was answered never runs twice", () => {
  const { store, hold } = setup()
  const answer = (n: number, value: string, kind: "option" | "text" | "interrupted") => {
    hold(CARD, call(n))
    store.answerQuestion(store.getQuestionByCall(call(n))!.id, value, kind, "ngocbh")
    return hold(CARD, call(n))
  }
  expect(answer(1, "use rg instead", "text")).toBe("The owner said no: use rg instead")
  expect(answer(2, " \n", "text")).toBe("The owner said no.")
  expect(answer(3, YES, "option")).toBe(UNKNOWN)
  expect(answer(4, sessionOption(RULES), "option")).toBe(UNKNOWN)
  expect(answer(5, INTERRUPTED, "interrupted")).toBe("[interrupted by the user]")
  // The second hold consumed each card, and a third gets the same reply.
  expect(store.getQuestionByCall(call(1))!.status).toBe("consumed")
  expect(hold(CARD, call(1))).toBe("The owner said no: use rg instead")
  expect(approvalResult(store.getQuestionByCall(call(3))!)).toBe(UNKNOWN)
})

test("an expired card's call throws, naming only the card", () => {
  const { store, hold } = setup()
  hold({ ...CARD, action: "cat planted-secret" }, call())
  const card = store.setQuestionStatus(store.getQuestionByCall(call())!.id, "stale")
  const error = thrown(() => hold(CARD, call())) as Error
  expect(error.message).toBe(`approval card ${card.id} expired before it was answered`)
})

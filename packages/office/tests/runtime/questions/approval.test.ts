/** Approval cards: an agent's call held by its yian call id until the session's approver answers, and what a call
 *  completed with the answer returns. */
import { expect, test } from "bun:test"
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
import { openStore, session, thrown } from "../store/helpers.ts"

const RUN = "run-1"
const RULES = ["git status *", "ls *"]
const CARD: Approval = { kind: "command", tool: "terminal_run", action: "ls -la", reason: "Ask mode", rules: RULES }

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

test("a tool card asks to call a tool, shows its action and offers its tool rules", () => {
  const { store, hold } = setup({ always: true })
  const rules = ["module crm quote"]
  const action = 'crm_quote {"amount":5}'
  const tool: Approval = { kind: "tool", tool: "crm_quote", action, args: { amount: 5 }, reason: "Ask mode", rules }
  hold(tool, call())
  const card = store.getQuestionByCall(call())!
  expect([card.title, card.question, card.options]).toEqual([
    "@minh wants to call a tool",
    action,
    approvalOptions(rules, true),
  ])
  expect(card.approval).toMatchObject({ kind: "tool", tool: "crm_quote", rules })
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

test("holding a call stores one card for its call id, asked by the agent, and returns it as stored", () => {
  const { store, s, hold } = setup()
  const result = hold(CARD, call())
  const card = store.getQuestionByCall(call())!
  expect(result).toEqual(card)
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
    kind: "command", tool: "terminal_run", action: "ls -la", args: {}, why: "", reason: "Ask mode", rules: RULES,
    partial: false, into: null, target: null,
  })
  expect(card.question).toBe("ls -la")
  expect(hold(CARD, call()).id).toBe(card.id)
  expect(store.listQuestions({ sessionId: s.id }).map((q) => q.id)).toEqual([card.id])

  hold({ kind: "input", tool: "terminal_type", action: "y", reason: "Ask mode", partial: true, into: "ssh h" }, call(2))
  const typed = store.getQuestionByCall(call(2))!
  expect(typed.title).toBe("@minh wants to type into a running command")
  expect([typed.approval?.partial, typed.approval?.into]).toEqual([true, "ssh h"])
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
  expect(answered(1, "  use rg instead\n", "text")).toEqual({ answer: "no", say: "use rg instead" })
  expect(answered(2, YES, "option")).toEqual({ answer: "yes" })
  expect(answered(3, sessionOption(RULES), "option")).toEqual({ answer: "session" })
  expect(answered(4, alwaysOption(RULES), "option")).toEqual({ answer: "always" })
  expect(answered(5, INTERRUPTED, "interrupted")).toEqual({ answer: "interrupted" })
})

test("a call completed with its card's answer gets the No, with the approver's words, or the interrupt; a Yes never completes one", () => {
  const { store, hold } = setup()
  const answered = (n: number, value: string, kind: "option" | "text" | "interrupted") => {
    hold(CARD, call(n))
    return approvalResult(store.answerQuestion(store.getQuestionByCall(call(n))!.id, value, kind, "ngocbh"))
  }
  expect(answered(1, " use rg instead\n", "text")).toBe("Not run: the user said no: use rg instead")
  expect(answered(2, " \n", "text")).toBe("Not run: the user said no.")
  expect(answered(3, INTERRUPTED, "interrupted")).toBe("[interrupted by the user]")
  // A Yes releases its call where yian holds it: one completed instead never ran.
  expect(answered(4, YES, "option")).toBe("Not run: its approval didn't reach the held call.")
  expect(answered(5, sessionOption(RULES), "option")).toBe("Not run: its approval didn't reach the held call.")
})

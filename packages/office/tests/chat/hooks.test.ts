/** The chat hooks: callbacks in order, a failing one logged by type and skipped, checks' results, name checks. */
import { expect, test } from "bun:test"
import { Hooks } from "../../src/chat/hooks.ts"
import type { QuestionRecord, SessionRecord } from "../../src/store/store.ts"

const S = { id: "S" } as SessionRecord
const Q = { id: "Q" } as QuestionRecord

function explode(): never {
  throw new RangeError("sentinel-msg")
}

test("callbacks run in order with their arguments", async () => {
  const hooks = new Hooks()
  const calls: string[][] = []
  hooks.runStarted.push((s, r) => calls.push(["a", s.id, r]))
  hooks.runStarted.push((s, r) => calls.push(["b", s.id, r]))
  await hooks.notify("runStarted", S, "R")
  expect(calls).toEqual([
    ["a", "S", "R"],
    ["b", "S", "R"],
  ])
})

test("a failing callback is logged and the rest still run", async () => {
  const lines: string[] = []
  const hooks = new Hooks({ log: (line) => lines.push(line) })
  const calls: SessionRecord[] = []
  hooks.sessionEnded.push(explode, (s) => calls.push(s))
  await hooks.notify("sessionEnded", S)
  expect(calls).toEqual([S])
  expect(lines).toEqual(["sessionEnded callback explode failed: RangeError"])

  hooks.answerCheck.push(explode, () => "pick one")
  expect(hooks.fire("answerCheck", Q, "x", "text")).toEqual(["pick one"])
  expect(lines).toEqual([
    "sessionEnded callback explode failed: RangeError",
    "answerCheck callback explode failed: RangeError",
  ])
  for (const line of lines) expect(line).not.toContain("sentinel-msg")

  const nameless = (): never => explode()
  Object.defineProperty(nameless, "name", {
    get() {
      throw new Error("x")
    },
  })
  hooks.promptCheck.push(nameless)
  hooks.fire("promptCheck", S, "hi")
  expect(lines.at(-1)).toBe("promptCheck callback anonymous failed: RangeError")
})

test("fire returns results for answer checks", () => {
  const hooks = new Hooks()
  hooks.answerCheck.push(
    () => null,
    () => "pick one",
  )
  expect(hooks.fire("answerCheck", Q, "x", "text")).toEqual([null, "pick one"])
})

test("an unknown hook name is an error", () => {
  const loose = new Hooks() as unknown as { fire(name: string): unknown; notify(name: string): unknown }
  expect(() => loose.fire("nope")).toThrow("no hook named 'nope'")
  expect(() => loose.notify("nope")).toThrow("no hook named 'nope'")
  expect(() => loose.fire("runStarted")).toThrow("'runStarted' is not a check")
  expect(() => loose.notify("answerCheck")).toThrow("'answerCheck' is not a notification")
})

test("notifications are awaited in order", async () => {
  const lines: string[] = []
  const hooks = new Hooks({ log: (line) => lines.push(line) })
  const pushes: string[] = []
  hooks.runFinished.push(
    async function a() {
      await new Promise((resolve) => setTimeout(resolve, 10))
      pushes.push("a")
    },
    async function reject() {
      throw new Error("x")
    },
    function b() {
      pushes.push("b")
    },
  )
  await hooks.notify("runFinished", S, "R", null)
  expect(pushes).toEqual(["a", "b"])
  expect(lines).toEqual(["runFinished callback reject failed: Error"])
})

test("turn context gets the session the text and whether it is the first turn", () => {
  const hooks = new Hooks()
  const calls: [string, string, boolean][] = []
  hooks.turnContext.push((s, text, { first }) => {
    calls.push([s.id, text, first])
    return first ? "first" : null
  })
  expect(hooks.fire("turnContext", S, "hi", { first: true })).toEqual(["first"])
  expect(hooks.fire("turnContext", S, "again", { first: false })).toEqual([null])
  expect(calls).toEqual([
    ["S", "hi", true],
    ["S", "again", false],
  ])
})

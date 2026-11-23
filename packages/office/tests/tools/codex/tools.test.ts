/** The Codex tool group as the model sees it: five tools, their arguments read and capped, and one JSON reply. */
import { expect, test } from "bun:test"
import { parseArgs, refusalText, replyText, TOOLS, toolSpecs } from "../../../src/tools/codex/tools.ts"

test("the group has start, send, interrupt, stop and history, each taking only its own arguments", () => {
  const specs = toolSpecs()
  expect(Object.keys(specs)).toEqual([...TOOLS])
  expect(TOOLS).toEqual(["start", "send", "interrupt", "stop", "history"])
  for (const name of TOOLS) expect(specs[name].parameters).toMatchObject({ type: "object", additionalProperties: false })
  // The model is told the owner's word wins.
  expect(specs.start.description).toContain("the owner's word wins")
})

test("arguments are read, a null is left out, and a wait is capped at two minutes", () => {
  expect(parseArgs("start", { message: "Fix it.", wait: null })).toEqual({ tool: "start", message: "Fix it.", waitMs: 5_000 })
  // The model names the session `codex`; the instrument reads it as the session's name.
  expect(parseArgs("send", { codex: "codex 1", message: "More.", wait: 999 })).toEqual({
    tool: "send", session: "codex 1", message: "More.", waitMs: 120_000,
  })
  expect(parseArgs("history", { codex: "codex 1", from: 5, trace: true })).toEqual({
    tool: "history", session: "codex 1", from: 5, query: undefined, trace: true, waitMs: 5_000,
  })
  expect(parseArgs("stop", { codex: "codex 2" })).toEqual({ tool: "stop", session: "codex 2" })
})

test("an argument a tool doesn't take, or one of the wrong kind, says why", () => {
  expect(parseArgs("start", { message: "Hi.", codex: "codex 1" })).toBe('start takes no argument "codex"')
  expect(parseArgs("send", { message: "Hi." })).toBe("codex must be text")
  expect(parseArgs("send", { codex: "codex 1", message: "  " })).toBe("message must be text to tell Codex")
  expect(parseArgs("history", { codex: "codex 1", from: -1 })).toContain("from is an offset")
  expect(parseArgs("history", { codex: "codex 1", query: 7 })).toBe("query must be text to look for")
  expect(parseArgs("send", { codex: "codex 1", message: "Hi.", wait: "soon" })).toContain("wait is a number")
})

test("a reply is one JSON object naming its session codex, with error only when the session failed", () => {
  const base = { output: [{ author: "codex", text: "Done." }], next: 5, more: false }
  const reply = { ...base, session: "codex 1" }
  expect(JSON.parse(replyText({ ...reply, status: "idle", error: "old" }))).toEqual({ codex: "codex 1", ...base, status: "idle" })
  expect(JSON.parse(replyText({ ...reply, status: "failed", error: "no codex" }))).toEqual({
    codex: "codex 1", ...base, status: "failed", error: "no codex",
  })
  expect(JSON.parse(refusalText("closed"))).toEqual({ refused: "closed" })
})

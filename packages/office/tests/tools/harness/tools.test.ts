/** A harness instrument's tool group, in the words of the harness that names itself: its session named by its kind in
 *  the arguments and the reply, and its title in what the model reads. */
import { expect, test } from "bun:test"
import { type Harness, parseArgs, replyText, toolSpecs } from "../../../src/tools/harness/tools.ts"

const H: Harness = { kind: "claude", title: "Claude Code", traced: "each tool call with its result", toolText: () => "" }

test("the model names a session by the harness's kind, and the reply names it so", () => {
  expect(parseArgs(H, "send", { claude: "claude 2", message: "More." })).toEqual({
    tool: "send", session: "claude 2", message: "More.", waitMs: 5_000,
  })
  expect(parseArgs(H, "send", { codex: "codex 1", message: "More." })).toBe('send takes no argument "codex"')
  expect(parseArgs(H, "stop", {})).toBe("claude must be text")
  expect(parseArgs(H, "start", { message: " " })).toBe("message must be text to tell Claude Code")
  const reply = JSON.parse(replyText(H, { session: "claude 2", status: "idle", output: [], next: 0, more: false }))
  expect(reply).toEqual({ claude: "claude 2", status: "idle", output: [], next: 0, more: false })
})

test("an empty optional text reads as left out, as a null does; a required one is still refused", () => {
  expect(parseArgs(H, "history", { claude: "claude 1", query: "", trace: true })).toEqual({
    tool: "history", session: "claude 1", from: undefined, query: undefined, trace: true, waitMs: 5_000,
  })
  expect(parseArgs(H, "history", { claude: "claude 1", query: null })).toMatchObject({ query: undefined })
  expect(parseArgs(H, "send", { claude: "", message: "More." })).toEqual({
    tool: "send", session: "", message: "More.", waitMs: 5_000,
  })
  expect(parseArgs(H, "start", { message: "" })).toBe("message must be text to tell Claude Code")
})

test("an argument named after an inherited property, such as constructor or toString, is no argument a tool takes", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    expect(parseArgs(H, "stop", JSON.parse(`{"claude": "claude 1", "${name}": "x"}`))).toBe(`stop takes no argument "${name}"`)
  }
})

test("the descriptions name the harness, its sessions and what its trace holds", () => {
  const specs = toolSpecs(H)
  expect(specs.start.description).toContain("Start a Claude Code session")
  expect(specs.start.description).toContain("(claude 1, claude 2, …)")
  expect(specs.start.description).toContain("the owner's word wins")
  expect(specs.history.description).toContain("every message, each tool call with its result, as Claude Code did them")
  expect(specs.send.parameters).toMatchObject({ required: ["claude", "message"] })
  expect(JSON.stringify(specs)).not.toContain("Codex")
})

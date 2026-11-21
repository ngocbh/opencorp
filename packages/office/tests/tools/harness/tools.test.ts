/** A harness instrument's tool group, in the words of the harness that names itself: its session named by its kind in
 *  the arguments and the reply, and its title in what the model reads. */
import { expect, test } from "bun:test"
import { type Harness, parseArgs, replyText, toolSpecs } from "../../../src/tools/harness/tools.ts"

const H: Harness = { kind: "claude", title: "Claude Code", traced: "each tool call with its result", toolText: () => "" }

test("the model names a session by the harness's kind, and the reply names it so", () => {
  expect(parseArgs(H, "send", { claude: "claude 2", message: "More." })).toEqual({
    tool: "send", session: "claude 2", message: "More.", waitMs: 60_000,
  })
  expect(parseArgs(H, "send", { codex: "codex 1", message: "More." })).toBe('send takes no argument "codex"')
  expect(parseArgs(H, "stop", {})).toBe("claude must be text")
  expect(parseArgs(H, "start", { message: " " })).toBe("message must be text to tell Claude Code")
  const reply = JSON.parse(replyText(H, { session: "claude 2", status: "idle", output: [], next: 0, more: false }))
  expect(reply).toEqual({ claude: "claude 2", status: "idle", output: [], next: 0, more: false })
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

// The setup screen's channel in this process: a prompter writes to it as `--json-prompts` writes to stdout, and the
// screen reads the same prompts a child's would give it.
import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { SetupPrompt } from "@opencorp/protocol"
import { JsonPrompter } from "@opencorp/office/install/json_prompts"
import { inProcessChild } from "../../src/setup/in_process"
import { parsePrompt } from "../../src/setup/child"
import { until } from "../fixture/until"

/** A channel, what it sent the screen, and how often it called `interrupt` and `echo`. */
function channel() {
  const interrupts: number[] = []
  const echoed: string[] = []
  const c = inProcessChild({ interrupt: () => interrupts.push(1), echo: (text) => echoed.push(text) })
  const prompts: SetupPrompt[] = []
  c.child.onPrompt((p) => prompts.push(p))
  return { c, prompts, interrupts, echoed, prompter: new JsonPrompter(c.io.prompts, c.io.answers) }
}

const files = [{ name: "/h/hq/reach.sh, which runs on every visit", lines: ["  1  ssh login1 true"] }]

/** Every kind of prompter call, answering through `answer` whenever one waits. */
async function everyCall(p: JsonPrompter, answer: (text: string) => void): Promise<string[]> {
  p.step(1, 2, "Model", "Why\u001b[2J")
  p.say("Learning needs a model.")
  p.show({ type: "command", title: "The model wants to run a command: look", warning: "Careful", lines: ["  1  ls"] })
  p.show({ type: "result", title: "Exited 0", ok: true, lines: ["out"] })
  p.show({ type: "review", title: "Save it", files, risks: ["It runs"], warning: "" })
  const got: Promise<string>[] = []
  got.push(p.ask("The agent asks: which login node?", "login1"))
  answer("login2")
  await got[0]
  got.push(p.choose("Run this 1-line command?", ["Run it", "Don't run it"], "Don't run it"))
  answer("Run it")
  await got[1]
  got.push(p.secret("API key"))
  answer("sk-x")
  await got[2]
  const handed = p.handOver("Running the command.")
  answer("")
  await handed
  p.takeBack()
  return Promise.all(got)
}

test("the same prompter calls give the screen the same prompts as --json-prompts gives it", async () => {
  const { c, prompts, prompter } = channel()
  const said = await everyCall(prompter, (text) => c.child.answer(text))
  expect(said).toEqual(["login2", "Run it", "sk-x"])

  // The same calls on a child's stdout, as spawnSetup reads it.
  let stdout = ""
  const input = new PassThrough()
  const piped = new JsonPrompter({ write: (text: string) => (stdout += text) }, input)
  await everyCall(piped, (text) => input.write(JSON.stringify({ answer: text }) + "\n"))
  const fromStdout = stdout.trimEnd().split("\n").map(parsePrompt)
  expect(prompts).toEqual(fromStdout)
  expect(prompts.map((p) => p.type)).toEqual([
    "step", "say", "command", "result", "review", "ask", "choose", "secret", "hand_over", "take_back",
  ])
  // Control characters go, as they do from a child.
  expect(prompts[0]).toEqual({ type: "step", number: 1, total: 2, title: "Model", why: "Why[2J" })
})

test("prompts sent before the screen listens are kept for it", () => {
  const c = inProcessChild({ interrupt: () => {}, echo: () => {} })
  new JsonPrompter(c.io.prompts, c.io.answers).say("early")
  const prompts: SetupPrompt[] = []
  let ready = false
  void c.ready.then(() => (ready = true))
  c.child.onPrompt((p) => prompts.push(p))
  expect(prompts).toEqual([{ type: "say", text: "early" }])
  return until(() => ready)
})

test("Ctrl-C calls interrupt and ends the answers, so a question waiting stops; again calls it again", async () => {
  const { c, prompter, interrupts } = channel()
  const asked = prompter.ask("The agent asks: which node?").catch((e: Error) => e)
  c.child.interrupt()
  expect(interrupts).toEqual([1])
  expect(String(await asked)).toContain("no answer to 'The agent asks: which node?' (stdin closed)")
  c.child.interrupt()
  expect(interrupts).toEqual([1, 1])
  // An answer after that goes nowhere, and throws nothing.
  c.child.answer("late")
})

test("a child's output shows on the screen, except while it has the terminal or once the run ended", async () => {
  const { c, prompts, prompter, echoed } = channel()
  c.io.echo("banner\nmotd\n")
  const handed = prompter.handOver("Running the command.")
  c.child.answer("")
  await handed
  c.io.echo("Password: \n")
  prompter.takeBack()
  c.io.echo("late\u001b[2J line\n")
  c.end(0)
  c.io.echo("after\n")
  expect(echoed).toEqual(["Password: \n", "after\n"])
  expect(prompts.filter((p) => p.type === "say")).toEqual([
    { type: "say", text: "banner" },
    { type: "say", text: "motd" },
    { type: "say", text: "late[2J line" },
  ])
})

test("ending it resolves done with the code and ends the answers; closing then does nothing more", async () => {
  const { c, interrupts } = channel()
  c.end(0)
  expect(await c.child.done).toBe(0)
  expect((c.io.answers as PassThrough).writableEnded).toBe(true)
  c.child.close()
  expect(interrupts).toEqual([])
  expect(c.child.stderr()).toBe("")
})

test("the screen closing (a signal) while the run goes on interrupts it and ends the answers", async () => {
  const { c, prompter, interrupts } = channel()
  const asked = prompter.ask("Company").catch((e: Error) => e)
  c.child.close()
  expect(interrupts).toEqual([1])
  expect(c.closed).toBe(true)
  expect(String(await asked)).toContain("stdin closed")
})

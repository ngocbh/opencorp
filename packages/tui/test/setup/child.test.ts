import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { SetupPrompt } from "@opencorp/protocol"
import { spawnSetup, type SetupChild } from "../../src/setup/child"
import { until } from "../fixture/until"

const dir = mkdtempSync(path.join(os.tmpdir(), "opencorp-setup-child-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let scripts = 0
/** Runs `code` as a bun script: a fake install. */
function fake(code: string) {
  const script = path.join(dir, `fake-${++scripts}.ts`)
  writeFileSync(script, "const say = (o) => console.log(JSON.stringify(o))\n" + code)
  return spawnSetup([process.execPath, script], dir, process.env as Record<string, string>)
}

/** The prompts `child` has sent so far, kept up to date. */
function collect(child: SetupChild) {
  const prompts: SetupPrompt[] = []
  child.onPrompt((p) => prompts.push(p))
  return prompts
}

const says = (prompts: SetupPrompt[]) => prompts.flatMap((p) => (p.type === "say" ? [p.text] : []))

const conversation = `
say({ type: "step", number: 1, total: 1, title: "Model", why: "w" })
say({ type: "ask", question: "Company", default: "" })
for await (const line of console) { say({ type: "say", text: "got " + JSON.parse(line).answer }); break }
say({ type: "say", text: "last" })
console.error("to stderr")
process.exit(4)
`

test("prompts arrive in order as parsed objects, and an answer reaches the child", async () => {
  const child = fake(conversation)
  const prompts = collect(child)
  await until(() => prompts.length === 2, 5000)
  expect(prompts).toEqual([
    { type: "step", number: 1, total: 1, title: "Model", why: "w" },
    { type: "ask", question: "Company", default: "" },
  ])
  child.answer("Acme")
  await until(() => prompts.length === 4, 5000)
  expect(prompts.slice(2)).toEqual([
    { type: "say", text: "got Acme" },
    { type: "say", text: "last" },
  ])
  expect(await child.done).toBe(4)
})

test("a choice keeps whether it takes a typed answer", async () => {
  const child = fake(`
say({ type: "choose", question: "Model", options: ["a"], default: "a", typed: true })
say({ type: "choose", question: "Provider", options: ["b"] })
await Bun.sleep(10000)
`)
  const prompts = collect(child)
  try {
    await until(() => prompts.length === 2, 5000)
    expect(prompts).toEqual([
      { type: "choose", question: "Model", options: ["a"], default: "a", typed: true },
      { type: "choose", question: "Provider", options: ["b"], default: "", typed: false },
    ])
  } finally {
    child.close()
    await child.done
  }
})

test("done resolves only once the last stdout and stderr lines are in", async () => {
  for (let i = 0; i < 10; i++) {
    const child = fake(conversation)
    const prompts = collect(child)
    await until(() => prompts.length === 2, 5000)
    child.answer("Acme")
    expect(await child.done).toBe(4)
    expect(prompts.at(-1)).toEqual({ type: "say", text: "last" })
    expect(child.stderr()).toBe("to stderr\n")
  }
}, 30000)

test("prompts sent before the listener are kept for it", async () => {
  const child = fake(`say({ type: "say", text: "early" })`)
  await child.done
  expect(collect(child)).toEqual([{ type: "say", text: "early" }])
})

test("a line that isn't a prompt shows as said, without its control characters", async () => {
  const child = fake(`
console.log("usage: install [-h]")
say({ type: "nope", text: "x" })
say({ type: "ask" })
console.log("\\x1b[2Jboom")
say({ type: "say", text: "\\x1b]0;title\\x07hi" })
`)
  await child.done
  expect(collect(child)).toEqual([
    { type: "say", text: "usage: install [-h]" },
    { type: "say", text: '{"type":"nope","text":"x"}' },
    { type: "say", text: '{"type":"ask"}' },
    { type: "say", text: "[2Jboom" },
    { type: "say", text: "]0;titlehi" },
  ])
})

test("interrupt sends SIGINT", async () => {
  const child = fake(`
process.on("SIGINT", () => process.exit(130))
say({ type: "say", text: "ready" })
await Bun.sleep(10000)
`)
  const prompts = collect(child)
  await until(() => prompts.length === 1, 5000)
  child.interrupt()
  expect(await child.done).toBe(130)
})

test("a second interrupt kills a child that ignores SIGINT", async () => {
  const child = fake(`
process.on("SIGINT", () => {})
say({ type: "say", text: "ready" })
await Bun.sleep(10000)
`)
  const prompts = collect(child)
  await until(() => prompts.length === 1, 5000)
  child.interrupt()
  child.interrupt()
  expect(await child.done).toBe(137)
})

test("close ends the child's stdin and interrupts it; again after it exited does nothing", async () => {
  // One stops only on the end of stdin, one only on SIGINT: each shows close did its part.
  const ready = 'say({ type: "say", text: "ready" })'
  const scripts = {
    3: `process.on("SIGINT", () => {})\n${ready}\nfor await (const _ of console) {}\nprocess.exit(3)`,
    130: `process.on("SIGINT", () => process.exit(130))\n${ready}\nawait Bun.sleep(10000)`,
  }
  for (const [code, script] of Object.entries(scripts)) {
    const child = fake(script)
    const prompts = collect(child)
    await until(() => prompts.length === 1, 5000)
    child.close()
    expect(await child.done).toBe(Number(code))
    child.close()
  }
})

test("an answer after the child exited doesn't throw", async () => {
  const child = fake(`say({ type: "say", text: "bye" })`)
  await child.done
  child.answer("x")
})

test("the child runs in its own session with git prompts off", async () => {
  const child = spawnSetup(
    ["/bin/sh", "-c", 'echo "$$ $(ps -o pgid= -p $$ | tr -d " ") $GIT_TERMINAL_PROMPT"'],
    dir,
    process.env as Record<string, string>,
  )
  expect(await child.done).toBe(0)
  const [said] = says(collect(child))
  const [pid, pgid, prompt] = said.split(" ")
  expect(pid).toBe(pgid)
  expect(prompt).toBe("0")
})

test("the child gets exactly the env it was given, with GIT_TERMINAL_PROMPT=0", async () => {
  const child = spawnSetup(["/bin/sh", "-c", 'echo "$ONLY_THIS-$GIT_TERMINAL_PROMPT-${HOME:-none}"'], dir, {
    ONLY_THIS: "yes",
    PATH: "/usr/bin:/bin",
  })
  const prompts = collect(child)
  await until(() => says(prompts).length > 0, 20_000)
  expect(says(prompts)).toEqual(["yes-0-none"])
  expect(await child.done).toBe(0)
})

test("a grandchild holding the pipes doesn't hold up done", async () => {
  const child = spawnSetup(["/bin/sh", "-c", "sleep 30 & echo hi"], dir, process.env as Record<string, string>)
  const start = Date.now()
  expect(await child.done).toBe(0)
  expect(Date.now() - start).toBeLessThan(5000)
  expect(says(collect(child))).toEqual(["hi"])
  // The sleep is still in the child's process group.
  child.interrupt()
})

test("stderr keeps only the last 64 KB", async () => {
  const child = fake(`
for (let i = 0; i < 100; i++) process.stderr.write(String(i).padStart(1023, "-") + "\\n")
process.stderr.write("the end")
`)
  await child.done
  expect(child.stderr().length).toBeLessThanOrEqual(65536)
  expect(child.stderr().endsWith("-99\nthe end")).toBe(true)
})

// An employee's approval cards on a real office, answered in the TUI on a real terminal, in tmux: a chat starts in
// auto, Shift+Tab cycles its four modes, Auto's check's reason shows on its card, a digit only selects, Enter answers,
// Esc stops the employee, dontAsk refuses with no card, and the approver opens the employee's shell and stops its
// command. The fake model is the office's connection, so Auto's check
// runs on it too; the sandbox may be missing here, so each test checks that a call's result reached the model, never
// what it was.
import { afterAll, beforeAll, describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createOfficeClient } from "@opencorp/client"
import type { Question } from "@opencorp/protocol"
import type { ScriptedReply } from "@opencorp/office/testing/fake_llm"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import { sandboxRuns } from "@opencorp/office/testing/sandbox"
import { type Terminal, TMUX, terminal } from "./tmux"

setDefaultTimeout(120_000)

/** Words only the chat's requests hold, from its system prompt, so a check's request never takes Minh's reply. */
const CHAT = "You work in the office alongside"
/** The approval card's choices, once it has been read. */
const CHOICES = "enter confirm"

/** Minh's reply that runs `command` in a new shell of his terminal, as call `id`, waiting `wait` seconds at most. */
function shell(id: string, command: string, wait?: number): ScriptedReply {
  const args = { command, why: "as asked", ...(wait === undefined ? {} : { wait }) }
  return { match: CHAT, tool_calls: [{ id, name: "terminal_run", arguments: args }] }
}

/** The processes of this user that run `sleep <marker>`, as the sandbox's shell starts it. */
function sleeping(marker: string): number[] {
  return fs.readdirSync("/proc").flatMap((name) => {
    if (!/^[0-9]+$/.test(name)) return []
    try {
      return fs.readFileSync(`/proc/${name}/cmdline`, "utf8") === `sleep\0${marker}\0` ? [Number(name)] : []
    } catch {
      return []
    }
  })
}

/** Minh's reply once call `id`'s result reached him, whatever it was. */
function after(id: string, content: string): ScriptedReply {
  return { match: `"tool_call_id":"${id}"`, content }
}

/** Auto's check's verdict on `command`. */
function check(command: string, verdict: "run" | "ask", reason: string): ScriptedReply {
  return {
    match: `<command>\\n${command}\\n</command>`,
    tool_calls: [{ name: "Record", arguments: { verdict, reason } }],
  }
}

/** Whether process `pid` still runs `opencorp -s <sid>`. */
function running(pid: number, sid: string) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(sid)
  } catch {
    return false
  }
}

/** Waits up to 5 s for the TUI `pid` on session `sid` to end, then kills it. */
async function gone(pid: number, sid: string) {
  for (const deadline = performance.now() + 5000; running(pid, sid) && performance.now() < deadline; )
    await Bun.sleep(50)
  if (running(pid, sid)) process.kill(pid, "SIGKILL")
}

describe.skipIf(!TMUX)("an employee's approval cards on a real office, in the TUI", () => {
  let office: TestOffice
  beforeAll(async () => {
    office = await startOffice()
  }, 180_000)
  afterAll(async () => {
    await office?.stop()
  })

  /** The model's requests, as text. */
  const requests = () => office.llm.requests().map((r) => JSON.stringify(r))
  /** The requests that hold call `id`'s result. */
  const results = (id: string) => requests().filter((r) => r.includes(`"tool_call_id":"${id}"`))
  /** Call `id`'s result, as the first request that holds it gave it to the model. */
  const result = (id: string): string | undefined =>
    office.llm
      .requests()
      .flatMap((r) => (r.messages as { role: string; tool_call_id?: string; content?: string }[]) ?? [])
      .find((m) => m.role === "tool" && m.tool_call_id === id)?.content
  /** Whether any request was Auto's check's. */
  const checked = () => requests().some((r) => r.includes("<input>"))

  /** Opens a chat with @minh in a fresh folder as the CEO, and `opencorp -s` on it in a terminal of its own, with an
   *  empty env but a temp home, `PATH` and the office's home. Every scripted reply must be used by the test's end. */
  async function chat() {
    const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc888."))
    const cwd = path.join(root, "project")
    fs.mkdirSync(cwd)
    office.llm.forget()
    const client = createOfficeClient({ socket: office.socket })
    const session = await client.sessions.create({ person: "minh", cwd })
    const env = { HOME: root, PATH: "/usr/bin:/bin", OPENCORP_HOME: office.home, OPENCORP_BUN: process.execPath }
    // Its hook, registered first, kills the tmux server; the TUI may still write to its home as it ends, so the home
    // goes once the TUI has.
    const t = terminal({ env, root }, ["-s", session.id])
    let tui: number | undefined
    onTestFinished(async () => {
      if (tui !== undefined) await gone(tui, session.id)
      fs.rmSync(root, { recursive: true, force: true })
    })
    onTestFinished(() => expect(office.llm.pending()).toEqual([]))
    await t.see("@minh auto")
    tui = t.pid()
    return { t, sid: session.id, client, cwd }
  }

  /** The chat's open approval card, once it is up. */
  async function card(client: ReturnType<typeof createOfficeClient>, sid: string): Promise<Question> {
    for (const deadline = performance.now() + 60_000; ; await Bun.sleep(100)) {
      const open = await client.questions.list({ session: sid, status: "open" })
      const found = open.find((q) => q.source === "approval")
      if (found) return found
      if (performance.now() > deadline) throw new Error("no approval card")
    }
  }

  /** Waits until `done()`. */
  async function until(done: () => boolean | Promise<boolean>, what: string, ms = 60_000) {
    for (const deadline = performance.now() + ms; !(await done()); await Bun.sleep(100))
      if (performance.now() > deadline) throw new Error(`never: ${what}`)
  }

  /** Shift+Tab once for each of `modes`, waiting until the pane shows it after @minh and the office's session has
   *  it. */
  async function cycle(t: Terminal, client: ReturnType<typeof createOfficeClient>, sid: string, modes: string[]) {
    for (const mode of modes) {
      t.keys("BTab")
      await t.see(`@minh ${mode}`)
      await until(async () => (await client.sessions.get(sid)).mode === mode, `the office's session in ${mode}`)
    }
  }

  test("a new chat starts in auto, and a read-only command runs with no card", async () => {
    const { t, sid, client } = await chat()
    await t.see("shift+tab mode")
    office.llm.script(shell("call_ls", "ls"), after("call_ls", "Listed the files."))
    t.type("What is in this folder?")
    await t.see("Listed the files.")
    expect(results("call_ls")).toHaveLength(1)
    expect(checked()).toBe(false)
    expect(await client.questions.list({ session: sid })).toEqual([])
  })

  test("Shift+Tab cycles the chat through default, ask and dontAsk, and back to auto", async () => {
    const { t, sid, client } = await chat()
    await cycle(t, client, sid, ["default", "ask", "dontAsk", "auto"])
  })

  test("in auto a command the check says ask waits on a card that shows the check's reason", async () => {
    const { t, sid, client } = await chat()
    office.llm.script(
      shell("call_scancel", "scancel 42"),
      check("scancel 42", "ask", "it cancels a job on the cluster"),
      after("call_scancel", "Left the job alone."),
    )
    t.type("Cancel job 42")
    await t.see("scancel 42")
    await t.see("Asking because: Auto's check: it cancels a job on the cluster")
    await t.see(CHOICES)
    const held = await card(client, sid)
    // The selection starts on No: Enter opens its box.
    t.keys("Enter")
    await t.see("Tell @minh what to do instead")
    t.type("leave it")
    await t.see("Left the job alone.")
    expect(results("call_scancel")).toHaveLength(1)
    expect(result("call_scancel")).toBe("Not run: the user said no: leave it")
    const answered = await client.questions.get(held.id)
    expect([answered.answer, answered.answer_kind]).toEqual(["leave it", "text"])
  })

  test("in ask an employee's shell command waits on an approval card that shows it whole; a digit only selects, and Enter on Yes runs it", async () => {
    const { t, sid, client } = await chat()
    await cycle(t, client, sid, ["default", "ask"])
    office.llm.script(shell("call_echo", "echo approved-run"), after("call_echo", "It ran, as approved."))
    t.type("Run the echo")
    await t.see("echo approved-run")
    await t.see(CHOICES)
    const held = await card(client, sid)
    t.keys("1")
    await Bun.sleep(500)
    expect((await client.questions.get(held.id)).status).toBe("open")
    expect(results("call_echo")).toEqual([])
    t.keys("Enter")
    await t.see("It ran, as approved.")
    expect(results("call_echo")).toHaveLength(1)
    expect((await client.questions.get(held.id)).answer).toBe("Yes")
  })

  test("Enter on a fresh card opens the No box, and typed words reach the agent as No", async () => {
    const { t, sid, client } = await chat()
    await cycle(t, client, sid, ["default", "ask"])
    office.llm.script(shell("call_rm", "rm -rf build"), after("call_rm", "I kept the build."))
    t.type("Clean the build")
    await t.see("rm -rf build")
    await t.see(CHOICES)
    const held = await card(client, sid)
    t.keys("Enter")
    await t.see("Tell @minh what to do instead")
    expect((await client.questions.get(held.id)).status).toBe("open")
    t.type("keep the build for now")
    await t.see("I kept the build.")
    expect(result("call_rm")).toBe("Not run: the user said no: keep the build for now")
  })

  test("Esc on the card asks to stop @minh, and y stops him with nothing run", async () => {
    const { t, sid, client, cwd } = await chat()
    await cycle(t, client, sid, ["default", "ask"])
    office.llm.script(shell("call_touch", "touch stopped.txt"))
    t.type("Touch a file")
    await t.see("touch stopped.txt")
    await t.see(CHOICES)
    const held = await card(client, sid)
    t.keys("Escape")
    await t.see("Stop @minh? y/N")
    t.keys("y")
    await until(async () => (await client.questions.get(held.id)).answer_kind === "interrupted", "the card interrupted")
    await until(async () => (await client.sessions.get(sid)).status === "idle", "the chat idle")
    expect(results("call_touch")).toEqual([])
    expect(fs.existsSync(path.join(cwd, "stopped.txt"))).toBe(false)
  })

  // Its command must run, so it needs the sandbox.
  test.skipIf(!sandboxRuns())("the approver opens the employee's shell from the picker, ctrl+x o shows it full screen, and Ctrl-C stops its command", async () => {
    const { t, sid, client } = await chat()
    office.llm.script(
      shell("call_sleep", "sleep 31.41", 1),
      after("call_sleep", "It is still running."),
      // The employee is told, by the shell, that the command it left running has ended.
      { match: "shell 1: `sleep 31.41` ended", content: "The sleep was stopped." },
    )
    t.type("Wait a while")
    await t.see("It is still running.")
    // The office lists the shell under the prompt, its command running.
    await t.see("1 shell")
    const [listed] = await client.sessions.instruments(sid)
    expect(listed).toMatchObject({ kind: "terminal", name: "shell 1", status: "running", command: "sleep 31.41" })
    // ↓ opens the picker on its Shell tab; Enter opens the shell in the pane beside the chat, with the keys.
    t.keys("Down")
    await t.see("shell 1 · sleep 31.41")
    t.keys("Enter")
    await t.see("@minh is driving")
    await t.see("ctrl+x o full screen")
    // The leader, then o, shows it full screen.
    t.keys("C-x")
    t.keys("o")
    await t.see("ctrl+x o split")
    t.keys("C-c")
    await until(async () => (await client.sessions.instruments(sid))[0]?.status === "idle", "the shell idle")
    await until(() => sleeping("31.41").length === 0, "the command's end", 10_000)
    // Ctrl-C in the shell stopped its command, not the employee, who hears from the shell that it ended and answers;
    // with the pane closed, the chat shows the note's line.
    await until(() => requests().some((r) => r.includes('author=\\"shell 1\\"')), "the shell's note")
    await until(async () => (await client.sessions.get(sid)).status === "idle", "the chat idle")
    t.keys("C-x")
    t.keys("Up")
    await t.see("↳ shell")
  })

  test("in dontAsk a command the check says ask is refused with no card", async () => {
    const { t, sid, client } = await chat()
    await cycle(t, client, sid, ["default", "ask", "dontAsk"])
    office.llm.script(
      shell("call_cancel", "scancel 43"),
      check("scancel 43", "ask", "it cancels a job on the cluster"),
      after("call_cancel", "That was refused."),
    )
    t.type("Cancel job 43")
    await t.see("That was refused.")
    expect(result("call_cancel")).toStartWith("Not run: this session doesn't ask (dontAsk mode)")
    expect(t.screen()).not.toContain(CHOICES)
    expect(await client.questions.list({ session: sid })).toEqual([])
  })
})

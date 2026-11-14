// A run behind the setup screen in this process, as `opencorp hq` learns its way to HQ: the risks, the ChatGPT
// device code, the agent's question, a command to approve, the terminal handed to ssh and back, and the save view.
import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { JsonPrompter } from "@opencorp/office/install/json_prompts"
import type { ScreenIo } from "../../src/setup/run"
import { until } from "../fixture/until"

/** Runs `work` behind the screen in a 100x40 test renderer; frame helpers, what it printed, and how often it was
 *  interrupted. */
async function boot<T>(work: (io: ScreenIo) => Promise<T>) {
  const setup = await createTestRenderer({ width: 100, height: 40, useThread: false, exitOnCtrlC: false })
  setup.renderer.waitForThemeMode = async () => "dark"
  const core = await import("@opentui/core")
  const configs: { exitSignals?: string[] }[] = []
  mock.module("@opentui/core", () => ({
    ...core,
    createCliRenderer: async (config: { exitSignals?: string[] }) => {
      configs.push(config)
      return setup.renderer
    },
  }))
  const { runInProcess } = await import("../../src/setup/run")
  const printed: string[] = []
  const echoed: string[] = []
  const interrupts: number[] = []
  const task = runInProcess(work, {
    interrupt: () => interrupts.push(1),
    echo: (text) => echoed.push(text),
    out: { write: (s) => void printed.push(s) },
    command: "opencorp hq",
    title: "Learning the way to HQ",
  })
  // The task's rejection is the test's to check.
  task.catch(() => {})
  return {
    setup,
    task,
    input: setup.mockInput,
    printed: () => printed.join(""),
    configs,
    echoed,
    interrupts,
    async until(pred: (f: string) => boolean, ms = 3000) {
      for (const end = Date.now() + ms; ; await Bun.sleep(20)) {
        if (!setup.renderer.isDestroyed) await setup.renderOnce()
        const f = setup.captureCharFrame()
        if (pred(f)) return f
        if (Date.now() > end) throw new Error("frame never matched:\n" + f)
      }
    },
    async stop() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task.catch(() => {})
      mock.restore()
    },
  }
}

const RISK = "Approving a command runs it as you, with your SSH keys, and only you check it."
const DEVICE =
  "Sign in to ChatGPT: open https://auth.openai.com/codex/device in a browser, on any device, and enter the code WXYZ-1234. Waiting (Ctrl-C stops it)..."
const TO_MODEL = "Your answer goes to the model. Type passwords, passphrases and codes only at ssh's own prompts, never here."
const WARNING = "Careful: this names /h/hq, provider.json or auth.json, which hold the model's key or its ChatGPT sign-in."
const HANDED = "Running the command. SSH asks here for any password, Duo or host key."

test("a learning run's risks, device code, question, command, hand-over and save view show behind the screen", async () => {
  const app = await boot(async (io) => {
    const p = new JsonPrompter(io.prompts, io.answers)
    p.say(RISK)
    p.say(DEVICE)
    p.say(TO_MODEL)
    const node = await p.ask("The agent asks: Which login node do you use?")
    p.show({ type: "command", title: "The model wants to run a command: log in to login1", warning: WARNING, lines: ["  1  ssh login1 true"] })
    const run = await p.choose("Run this 1-line command?", ["Run it", "Don't run it"], "Don't run it")
    await p.handOver(HANDED)
    io.echo("login1 says hi\n")
    p.takeBack()
    p.show({ type: "result", title: "Exited 0", ok: true, lines: ["login1 says hi"] })
    io.echo("a banner after\n")
    p.show({
      type: "review",
      title: "The model wants to save how this machine reaches HQ.",
      files: [
        { name: "/h/hq/reach.sh, which runs on every visit", lines: ["  1  ssh login1 true"] },
        { name: "/h/hq/notes.md", lines: ["  1  Through login1."] },
      ],
      risks: ["The script runs now and on every visit."],
      warning: "",
    })
    const save = await p.choose("Save this 1-line reach.sh and the notes?", ["Test it, then save it", "Don't save it"], "Don't save it")
    return { node, run, save }
  })
  try {
    let f = await app.until((f) => f.includes("Which login node do you use?"))
    expect(f).toContain("Learning the way to HQ · opencorp hq")
    expect(f).toContain(RISK)
    expect(f).toContain("WXYZ-1234")
    expect(f).toContain("https://auth.openai.com/codex/device")
    expect(f).toContain("Your answer goes to the model.")
    await app.input.typeText("login1")
    app.input.pressEnter()
    f = await app.until((f) => f.includes("2. Don't run it"))
    expect(f).toContain("The model wants to run a command: log in to login1")
    expect(f).toContain("Careful: this names /h/hq")
    expect(f).toContain("1  ssh login1 true")
    app.input.pressArrow("up")
    app.input.pressEnter()
    f = await app.until((f) => f.includes("2. Don't save it"))
    // The screen came back: the result, the output after it, and the save view.
    expect(f).toContain("Exited 0")
    expect(f).toContain("a banner after")
    expect(f).toContain("Before you save it:")
    expect(app.printed()).toBe(`\n${HANDED}\n`)
    expect(app.echoed).toEqual(["login1 says hi\n"])
    app.input.pressArrow("up")
    app.input.pressEnter()
    expect(await app.task).toEqual({ node: "login1", run: "Run it", save: "Test it, then save it" })
    expect(app.setup.renderer.isDestroyed).toBe(true)
    // Then the transcript, after the line the hand-over printed.
    const transcript = app.printed().slice(`\n${HANDED}\n`.length)
    expect(transcript).toContain(`${RISK}\n${DEVICE}\n${TO_MODEL}\nThe agent asks: Which login node do you use?: login1\n`)
    expect(transcript).toContain("Run this 1-line command?: Run it\nExited 0\na banner after\n")
    expect(transcript.endsWith("Save this 1-line reach.sh and the notes?: Test it, then save it\n")).toBe(true)
  } finally {
    await app.stop()
  }
})

test("a SIGINT from outside is the run's to handle; the other exit signals still take the screen down", async () => {
  const app = await boot(async () => {})
  try {
    await app.task
    const signals = app.configs[0]!.exitSignals!
    expect(signals).not.toContain("SIGINT")
    expect(signals).toEqual(expect.arrayContaining(["SIGTERM", "SIGHUP", "SIGQUIT"]))
  } finally {
    await app.stop()
  }
})

test("a run that fails rejects with its error once the screen is gone", async () => {
  const app = await boot(async (io) => {
    new JsonPrompter(io.prompts, io.answers).say("Working on it")
    await Bun.sleep(50)
    throw new Error("the model stopped")
  })
  try {
    expect(String(await app.task.catch((e) => e))).toBe("Error: the model stopped")
    expect(app.setup.renderer.isDestroyed).toBe(true)
    expect(app.printed()).toBe("Working on it\n")
  } finally {
    await app.stop()
  }
})

test("Ctrl-C at a question interrupts the run and stops the question, and the screen says it is stopping", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  const app = await boot(async (io) => {
    const p = new JsonPrompter(io.prompts, io.answers)
    try {
      await p.choose("Run this 1-line command?", ["Run it", "Don't run it"], "Don't run it")
    } finally {
      await held
    }
  })
  try {
    await app.until((f) => f.includes("2. Don't run it"))
    app.input.pressCtrlC()
    await app.until((f) => f.includes("Stopping…"))
    expect(app.interrupts).toEqual([1])
    app.input.pressCtrlC()
    await until(() => app.interrupts.length === 2)
    release()
    expect(String(await app.task.catch((e) => e))).toContain("stdin closed")
  } finally {
    await app.stop()
  }
})

test("a screen that can't start rejects without starting the run", async () => {
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({
    ...core,
    createCliRenderer: async () => {
      throw new Error("no terminal")
    },
  }))
  try {
    const { runInProcess } = await import("../../src/setup/run")
    let started = false
    const task = runInProcess(
      async () => {
        started = true
      },
      { interrupt: () => {}, echo: () => {}, out: { write: () => {} } },
    )
    expect(String(await task.catch((e) => e))).toBe("Error: no terminal")
    expect(started).toBe(false)
  } finally {
    mock.restore()
  }
})

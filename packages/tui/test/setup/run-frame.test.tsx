import { expect, test } from "bun:test"
import { SPINNER_FRAMES } from "../../src/component/spinner"
import { until } from "../fixture/until"
import { bootSetup, FakeChild } from "./boot"

const spinning = (f: string) => SPINNER_FRAMES.some((c) => f.includes(c))

test("steps and lines show in the transcript; with no question the spinner says it is working", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  try {
    child.push({ type: "step", number: 1, total: 5, title: "Model", why: "The model your people think with." })
    child.push({ type: "say", text: "Checking the key…" })
    const f = await app.until((f) => f.includes("Checking the key…"))
    expect(f).toContain("Setting up AgentCorp")
    expect(f).toContain("Step 1 of 5 · Model")
    expect(f).toContain("The model your people think with.")
    expect(f).toContain("Working…")
    expect(spinning(f)).toBe(true)
  } finally {
    await app.stop()
  }
})

test("the header names the command", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child, "ac init")
  try {
    await app.until((f) => f.includes("Setting up AgentCorp · ac init"))
  } finally {
    await app.stop()
  }
})

test("one Ctrl-C shows a hint and stops nothing; a second interrupts the child, and a third again", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  try {
    await app.until((f) => f.includes("Working…"))
    app.input.pressCtrlC()
    await app.until((f) => f.includes("Press Ctrl+C again to stop"))
    await Bun.sleep(100)
    expect(child.interrupts).toBe(0)
    expect(app.frame()).toContain("Working…")
    app.input.pressCtrlC()
    await app.until((f) => f.includes("Stopping…") && !f.includes("Press Ctrl+C again to stop"))
    expect(child.interrupts).toBe(1)
    app.input.pressCtrlC()
    await until(() => child.interrupts === 2)
  } finally {
    await app.stop()
  }
})

test("Ctrl-C twice with a question open hides it and says the child is stopping", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  try {
    child.push({ type: "ask", question: "Company", default: "" })
    await app.until((f) => f.includes("Company") && f.includes("Type your answer here"))
    app.input.pressCtrlC()
    let f = await app.until((f) => f.includes("Press Ctrl+C again to stop"))
    expect(f).toContain("Type your answer here")
    expect(child.interrupts).toBe(0)
    app.input.pressCtrlC()
    f = await app.until((f) => f.includes("Stopping…"))
    expect(f).not.toContain("Type your answer here")
    expect(child.interrupts).toBe(1)
    expect(child.answers).toEqual([])
  } finally {
    await app.stop()
  }
})

test("when the child ends the screen goes, then the transcript and stderr are printed", async () => {
  const child = new FakeChild()
  child.stderrText = "a warning\n"
  const app = await bootSetup(child)
  const order: string[] = []
  app.setup.renderer.on("destroy", () => order.push("destroy"))
  void app.task.then(() => order.push("task"))
  try {
    child.push({ type: "step", number: 2, total: 5, title: "Company", why: "Who you are." })
    child.push({ type: "say", text: "Done." })
    await app.until((f) => f.includes("Done."))
    child.end(0)
    expect(await app.task).toBe(0)
    expect(order).toEqual(["destroy", "task"])
    expect(app.setup.renderer.isDestroyed).toBe(true)
    expect(app.out()).toBe("Step 2 of 5: Company\nWho you are.\nDone.\n")
    expect(app.err()).toBe("a warning\n")
  } finally {
    await app.stop()
  }
})

test("the screen destroyed from outside closes the child and waits for it", async () => {
  const child = new FakeChild()
  const app = await bootSetup(child)
  try {
    await app.until((f) => f.includes("Working…"))
    child.push({ type: "choose", question: "Remote", options: ["None for now"], default: "None for now", typed: true })
    await app.until((f) => f.includes("2. Type your answer here"))
    // As opentui's signal handler does on SIGTERM or the terminal closing.
    app.setup.renderer.destroy()
    expect(await app.task).toBe(130)
    expect(child.closed).toBe(1)
  } finally {
    await app.stop()
  }
})

test("a child that ends after the screen is gone still ends the run, touching the renderer no more", async () => {
  const child = new FakeChild()
  child.endOnClose = false
  const app = await bootSetup(child)
  const renderer = app.setup.renderer
  // Calls made once the renderer is gone: a second destroy, or a title written to a terminal it released.
  const late: string[] = []
  for (const name of ["destroy", "setTerminalTitle"] as const) {
    const original = renderer[name].bind(renderer) as (...args: any[]) => any
    renderer[name] = ((...args: any[]) => {
      if (renderer.isDestroyed) late.push(name)
      return original(...args)
    }) as any
  }
  try {
    await app.until((f) => f.includes("Working…"))
    renderer.destroy()
    await until(() => child.closed === 1)
    child.end(3)
    expect(await app.task).toBe(3)
    expect(late).toEqual([])
  } finally {
    await app.stop()
  }
})

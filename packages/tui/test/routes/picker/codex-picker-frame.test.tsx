import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createFakeOffice, createStub, seed } from "../../../script/stub"
import { Global } from "../../../src/core/global"
import { bootFrame } from "../../fixture/frame"
import { typeInto } from "./type"

// The app keeps both files under the preload's AGENT_CORP_HOME, which every test file shares.
const modelFile = () => path.join(Global.Path.state, "model.json")
const kvFile = () => path.join(Global.Path.state, "kv.json")
const kv = (): Record<string, unknown> => (existsSync(kvFile()) ? JSON.parse(readFileSync(kvFile(), "utf8")) : {})

/** Turns on starting new chats on the last pick, with azure-2/gpt-4o-mini picked; returns the undo. */
function lastPickOn() {
  mkdirSync(Global.Path.state, { recursive: true })
  writeFileSync(modelFile(), JSON.stringify({ recent: [{ connection: "azure-2", model: "gpt-4o-mini" }], favorite: [] }))
  writeFileSync(kvFile(), JSON.stringify({ ...kv(), start_on_last_pick: true }))
  return () => {
    rmSync(modelFile(), { force: true })
    const { start_on_last_pick: _, ...rest } = kv()
    writeFileSync(kvFile(), JSON.stringify(rest))
  }
}

/** The fake office, with minh using Codex as well as composer. */
function codexOffice() {
  const s = seed()
  s.people = s.people.map((p) => (p.handle === "minh" ? { ...p, harnesses: ["composer", "codex"] } : p))
  return createFakeOffice({ seed: s })
}

/** Opens the picker and picks minh's Codex row; the prompt's footer then names Codex. Returns the picker's frame. */
async function pickCodex(app: Awaited<ReturnType<typeof bootFrame>>) {
  await app.until((f) => f.includes("@minh"))
  app.input.pressKey("x", { ctrl: true })
  await app.setup.renderOnce()
  app.input.pressKey("p")
  const f = await app.until((f) => f.includes("@minh · Codex"))
  await typeInto(app, "Codex")
  app.input.pressEnter()
  await app.until((f) => !f.includes("Who do you want") && f.includes("@minh · Software engineer · Codex"))
  return f
}

test("a person who uses Codex has a Codex row, and picking it picks the harness", async () => {
  const fake = codexOffice()
  const app = await bootFrame(createStub(fake))
  try {
    const picker = await pickCodex(app)
    // One row per harness; the current one (composer, minh's first) is marked, as rows are compared by value.
    expect(picker).toContain("● @minh Minh · Software engineer")
    expect(picker).toContain("@minh · Codex Minh · Software engineer")
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("a chat started on Codex asks the office for a Codex session, without a model pick", async () => {
  // A composer chat would start on this pick; a Codex chat runs on Codex's own model.
  const undo = lastPickOn()
  const fake = codexOffice()
  const app = await bootFrame(createStub(fake))
  try {
    await pickCodex(app)
    await app.input.typeText("make hello.txt")
    app.input.pressEnter()
    await app.until(() => fake.requests.some((r) => r.path === "/sessions" && r.method === "POST"))
    const body = fake.requests.find((r) => r.path === "/sessions" && r.method === "POST")!.body as Record<string, unknown>
    expect(body).toEqual({ person: "minh", cwd: "/tmp/proj", harness: "codex" })
    // In the Codex session (its header shows the status) the footer still names Codex, not the office
    // connection's model.
    const f = await app.until(
      (f) => /@minh · (idle|busy)/.test(f) && f.includes("make hello.txt") && f.includes("@minh · Software engineer · Codex"),
    )
    expect(f).not.toContain("Software engineer · gpt-4o")
  } finally {
    await app.stop()
    fake.stop()
    undo()
  }
})

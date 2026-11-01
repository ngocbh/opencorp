import { expect, test } from "bun:test"
import { createFakeOffice, createStub } from "./fixture/fake-office"
import { bootFrame } from "./fixture/frame"

async function runCommand(app: Awaited<ReturnType<typeof bootFrame>>, title: string) {
  app.input.pressKey("p", { ctrl: true })
  await app.until((f) => f.includes("Commands"))
  // The search box takes focus a moment after it renders.
  await Bun.sleep(50)
  app.input.typeText(title)
  await app.until((f) => f.split(title).length > 2)
  app.input.pressEnter()
}

/** An office whose first session is held at its cost cap, waiting on the owner. */
function capped() {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.updateSession(s.id, { cost: 5, status: "waiting", waiting_on: ["ngocbh"], capped: true })
  return { office, s }
}

const raised = (office: ReturnType<typeof createFakeOffice>, id: string, usd: number) =>
  office.requests.some(
    (r) => r.path === `/sessions/${id}/cost-cap` && (r.body as { cost_cap_usd?: number })?.cost_cap_usd === usd,
  )

test("the cost cap command sets the open session's cap and shows the office's refusal as is", async () => {
  const { office, s } = capped()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("cost cap reached"))
    await runCommand(app, "Set the cost cap")
    await app.until((f) => f.includes("USD"))
    app.input.typeText("4")
    app.input.pressEnter()
    await app.until((f) => f.includes("the cap must be above"))
    await runCommand(app, "Set the cost cap")
    await app.until((f) => f.includes("USD"))
    app.input.typeText("20")
    app.input.pressEnter()
    await app.until(() => raised(office, s.id, 20))
    await app.until((f) => f.includes("Cost cap set to $20.00"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/cost-cap 20 typed in the prompt raises the cap and sends nothing to the model", async () => {
  const { office, s } = capped()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("cost cap reached"))
    await app.input.typeText("/cost-cap 20")
    await app.until((f) => f.includes("/cost-cap 20"))
    app.input.pressEnter()
    await app.until(() => raised(office, s.id, 20))
    await app.until((f) => f.includes("Cost cap set to $20.00") && !f.includes("/cost-cap 20"))
    expect(office.requests.some((r) => r.path === `/sessions/${s.id}/prompt`)).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/cost-cap below the current cap says the cap was set, not raised", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.updateSession(s.id, { cost: 1, cost_cap_usd: 10 })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("of $10.00"))
    await app.input.typeText("/cost-cap 6")
    await app.until((f) => f.includes("/cost-cap 6"))
    app.input.pressEnter()
    await app.until(() => raised(office, s.id, 6))
    const frame = await app.until((f) => f.includes("Cost cap set to $6.00"))
    expect(frame).not.toContain("raised")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/cost-cap under a cent shows the cap it set to the hundredth of a cent", async () => {
  const office = createFakeOffice()
  const s = office.state.sessions[0]
  office.updateSession(s.id, { cost: 0.0001, cost_cap_usd: 10 })
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("of $10.00"))
    await app.input.typeText("/cost-cap 0.0006")
    await app.until((f) => f.includes("/cost-cap 0.0006"))
    app.input.pressEnter()
    await app.until(() => raised(office, s.id, 0.0006))
    await app.until((f) => f.includes("Cost cap set to $0.0006"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/cost-cap with an amount that isn't one opens the dialog with it, and sends nothing", async () => {
  const { office, s } = capped()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("cost cap reached"))
    await app.input.typeText("/cost-cap lots")
    await app.until((f) => f.includes("/cost-cap lots"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Set the cost cap") && f.includes("lots"))
    expect(office.requests.some((r) => r.path === `/sessions/${s.id}/prompt`)).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/cost-cap on the home screen asks for a session and sends nothing", async () => {
  const office = createFakeOffice()
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("Ask anything"))
    await app.input.typeText("/cost-cap 20")
    await app.until((f) => f.includes("/cost-cap 20"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Open a session to raise its cost cap"))
    expect(office.requests.filter((r) => r.method === "POST")).toEqual([])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("/cost-cap on a Codex session shows the office's refusal and sends nothing to Codex", async () => {
  const office = createFakeOffice()
  const s = office.newSession({ person: "minh", cwd: "/tmp/proj", harness: "codex" })
  office.state.messages[s.id] = []
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("@minh ·"))
    await app.input.typeText("/COST-CAP 20")
    await app.until((f) => f.includes("/COST-CAP 20"))
    app.input.pressEnter()
    await app.until((f) => f.includes("a Codex session runs on Codex's own model and login"))
    expect(office.requests.some((r) => r.path === `/sessions/${s.id}/cost-cap`)).toBe(true)
    expect(office.requests.some((r) => r.path === `/sessions/${s.id}/prompt`)).toBe(false)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a message to a capped session says it waits for the cap", async () => {
  const { office, s } = capped()
  const app = await bootFrame(createStub(office), { sessionID: s.id })
  try {
    await app.until((f) => f.includes("cost cap reached"))
    await app.input.typeText("please go on")
    app.input.pressEnter()
    await app.until((f) => f.includes("waits until the cost cap is raised"))
  } finally {
    await app.stop()
    office.stop()
  }
})

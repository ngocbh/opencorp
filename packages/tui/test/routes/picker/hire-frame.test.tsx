import { expect, test } from "bun:test"
import { createFakeOffice, createStub, OFFICE_501_ROUTES } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"
import { typeInto } from "./type"

/** Boots in a folder nobody has worked in, so the picker opens, and picks "Hire new…". */
async function openHire(office: ReturnType<typeof createFakeOffice>) {
  const app = await bootFrame({ ...createStub(office), cwd: "/tmp/new" })
  await app.until((f) => f.includes("Hire new…"))
  await typeInto(app, "hire")
  // The picker's filter keeps focus until the form focuses its first field a tick later.
  const filter = app.setup.renderer.currentFocusedRenderable
  app.input.pressEnter()
  await app.until(
    (f) => f.includes("Hire a new person") && f.includes("@ngocbh") && app.setup.renderer.currentFocusedRenderable !== filter,
  )
  return app
}

async function fill(app: Awaited<ReturnType<typeof bootFrame>>, name: string, handle: string, title: string) {
  await typeInto(app, name)
  app.input.pressTab()
  await typeInto(app, handle)
  app.input.pressTab()
  await typeInto(app, title)
}

test("Enter previews the hire, Enter again hires and selects the new person", async () => {
  const office = createFakeOffice()
  const app = await openHire(office)
  try {
    await fill(app, "Lan Tran", "lan", "QA engineer")
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("+handle: lan") && f.includes("person.yaml"))
    expect(f).toContain("enter hire")
    expect(office.state.people.some((p) => p.handle === "lan")).toBe(false)
    app.input.pressEnter()
    await app.until((f) => !f.includes("Hire a new person") && f.includes("@lan · QA engineer") && f.includes("Hired @lan"))
    const [preview, confirm] = office.requests.filter((r) => r.method === "POST").map((r) => r.body as any)
    expect(preview).toEqual({ name: "Lan Tran", handle: "lan", title: "QA engineer", manager: "ngocbh", confirm: false })
    expect(confirm).toEqual({ ...preview, id: office.state.people.find((p) => p.handle === "lan")!.id, confirm: true })
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a taken handle shows the lint error and blocks the hire; editing previews again", async () => {
  const office = createFakeOffice()
  const app = await openHire(office)
  try {
    await fill(app, "Minh Two", "minh", "Engineer")
    app.input.pressEnter()
    await app.until((f) => f.includes("@minh is already used by minh") && f.includes("edit to fix"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Fix the errors above"))
    expect(office.requests.filter((r) => r.method === "POST")).toHaveLength(1)
    // Title → Manager → Name: the edit lands in the name and makes the preview stale.
    app.input.pressTab()
    app.input.pressTab()
    await typeInto(app, "2")
    await app.until((f) => !f.includes("@minh is already used by minh") && f.includes("enter preview"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("the form says what to fix before asking the office; office errors show inline", async () => {
  const office = createFakeOffice({ notImplemented: OFFICE_501_ROUTES })
  const app = await openHire(office)
  try {
    await fill(app, "Lan", "Lan!", "QA")
    app.input.pressEnter()
    await app.until((f) => f.includes("Handle: lowercase letters"))
    expect(office.requests.some((r) => r.method === "POST")).toBe(false)
    // Title → Manager → Name → Handle.
    app.input.pressTab()
    app.input.pressTab()
    app.input.pressTab()
    for (let i = 0; i < 4; i++) app.input.pressBackspace()
    await typeInto(app, "lan")
    app.input.pressEnter()
    await app.until((f) => f.includes("POST /people is not implemented yet"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("an edit while the preview is in flight drops that preview; the next Enter previews the new fields", async () => {
  const office = createFakeOffice()
  const app = await openHire(office)
  try {
    await fill(app, "Lan", "lan", "QA")
    const release = office.hold("POST /people")
    app.input.pressEnter()
    await app.until((f) => f.includes("Asking the office"))
    app.input.pressEnter()
    await app.input.typeText("X")
    release()
    await app.until((f) => !f.includes("Asking the office") && f.includes("enter preview"))
    await Bun.sleep(50)
    expect(await app.until(() => true)).not.toContain("+handle: lan")
    app.input.pressEnter()
    await app.until((f) => f.includes("+title: QAX") && f.includes("enter hire"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Hired @lan"))
    const posts = office.requests.filter((r) => r.method === "POST").map((r) => r.body as any)
    expect(posts.map((b) => [b.title, b.confirm])).toEqual([
      ["QA", false],
      ["QAX", false],
      ["QAX", true],
    ])
    expect(office.state.people.find((p) => p.handle === "lan")?.title).toBe("QAX")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a failed confirm drops the preview, so the next Enter previews again", async () => {
  const office = createFakeOffice()
  const app = await openHire(office)
  try {
    await fill(app, "Lan", "lan", "QA")
    app.input.pressEnter()
    await app.until((f) => f.includes("enter hire"))
    // Someone else takes @lan between the preview and the confirm.
    office.state.people.push({ id: "lan2", handle: "lan", name: "L", kind: "agent", title: "x", manager: "ngocbh" })
    app.input.pressEnter()
    const f = await app.until((f) => f.includes("@lan is already used by lan2") && f.includes("enter preview"))
    expect(f).not.toContain("+handle: lan")
    app.input.pressEnter()
    await app.until((f) => f.includes("+handle: lan") && f.includes("edit to fix"))
    expect(office.requests.filter((r) => r.method === "POST").map((r) => (r.body as any).confirm)).toEqual([false, true, false])
  } finally {
    await app.stop()
    office.stop()
  }
})

test("once the office hires, the form closes even if re-reading people fails", async () => {
  const office = createFakeOffice()
  const app = await openHire(office)
  try {
    await fill(app, "Lan", "lan", "QA")
    app.input.pressEnter()
    await app.until((f) => f.includes("enter hire"))
    const release = office.hold("POST /people")
    app.input.pressEnter()
    await app.until((f) => f.includes("Asking the office"))
    office.notImplemented.add("GET /people")
    release()
    const f = await app.until((f) => !f.includes("Hire a new person") && f.includes("Hired @lan"))
    // @lan isn't loaded, so the person stays as it was rather than warning "No such person".
    expect(f).toContain("@minh · Software engineer")
    expect(f).not.toContain("No such person")
    expect(office.state.people.some((p) => p.handle === "lan")).toBe(true)
    expect(office.requests.filter((r) => r.method === "POST")).toHaveLength(2)
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Esc during a confirm leaves whatever opened next alone; the hire still lands", async () => {
  const office = createFakeOffice()
  const app = await openHire(office)
  try {
    await fill(app, "Lan", "lan", "QA")
    app.input.pressEnter()
    await app.until((f) => f.includes("enter hire"))
    const release = office.hold("POST /people")
    app.input.pressEnter()
    await app.until((f) => f.includes("Asking the office"))
    app.input.pressEscape()
    await app.until((f) => !f.includes("Hire a new person"))
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressKey("p")
    await app.until((f) => f.includes("Who do you want to talk to?"))
    release()
    // The picker stays open and lists the hire once people are re-read.
    const f = await app.until((f) => f.includes("Hired @lan") && f.includes("@lan"))
    expect(f).toContain("Who do you want to talk to?")
    for (let i = 0; i < 5; i++) await app.setup.renderOnce()
    expect(await app.until(() => true)).toContain("Who do you want to talk to?")
  } finally {
    await app.stop()
    office.stop()
  }
})

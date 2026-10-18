import { expect, test } from "bun:test"
import { createFakeOffice, createStub, seed, type FakeOffice } from "../script/stub"
import { bootFrame } from "./fixture/frame"

test("the home screen against a running office shows the logo, the prompt, and the person", async () => {
  const office = createFakeOffice()
  const app = await bootFrame(createStub(office))
  try {
    const f = await app.until((f) => f.includes("Ask anything") && f.includes("@minh"))
    expect(f).toContain("█  █ █▀▀█ █▀▀█ █▀▀▄ █    █▀▀█ █▀▀ █▀▀█")
    expect(f).toContain("▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀ █▀▀▀")
    expect(f).toContain("Software engineer")
    expect(f).not.toContain("Office is not running")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("Tab cycles through agents, skipping humans; --person picks one at start", async () => {
  const s = seed()
  s.people.push({ handle: "lan", name: "Lan", kind: "agent", title: "QA engineer", manager: "ngocbh" })
  const office = createFakeOffice({ seed: s })
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("@minh"))
    app.input.pressTab()
    await app.until((f) => f.includes("@lan") && f.includes("QA engineer"))
    app.input.pressTab()
    await app.until((f) => f.includes("@minh") && f.includes("Software engineer"))
    app.input.pressTab({ shift: true })
    await app.until((f) => f.includes("@lan") && f.includes("QA engineer"))
  } finally {
    await app.stop()
  }
  const picked = await bootFrame(createStub(office), { person: "ngocbh" })
  try {
    await picked.until((f) => f.includes("@ngocbh"))
  } finally {
    await picked.stop()
    office.stop()
  }
})

test("the person stays put when a newer session in the folder belongs to someone else", async () => {
  const office = createFakeOffice()
  const app = await bootFrame(createStub(office))
  try {
    await app.until((f) => f.includes("@minh") && f.includes("Software engineer"))
    const s = office.state.sessions[0]
    const later = {
      ...s,
      id: office.nextId(),
      person: "ngocbh",
      updated_at: new Date(Date.now() + 60_000).toISOString(),
    }
    office.emit({
      id: office.nextId(),
      type: "session.created",
      at: later.updated_at,
      subject_id: later.id,
      data: later,
    })
    await Bun.sleep(300)
    const f = await app.until((f) => f.includes("Ask anything"))
    expect(f).toContain("@minh")
    expect(f).not.toContain("@ngocbh")
  } finally {
    await app.stop()
    office.stop()
  }
})

test("a --person that matches nobody says so", async () => {
  const office = createFakeOffice()
  const app = await bootFrame(createStub(office), { person: "nobody" })
  try {
    await app.until((f) => f.includes("No one here matches --person nobody") && f.includes("@minh"))
  } finally {
    await app.stop()
    office.stop()
  }
})

test("without an office the home screen says so, then recovers when it starts", async () => {
  const socket = `/tmp/act-home-${process.pid}.sock`
  const app = await bootFrame({ ...createStub(), socket })
  let office: FakeOffice | undefined
  try {
    const f = await app.until((f) => f.includes("Ask anything") && f.includes("Office is not running"))
    expect(f).toContain(`Waiting for ${socket}`)
    office = createFakeOffice({ socket })
    await app.until((f) => !f.includes("Office is not running") && f.includes("@minh"), 8000)
  } finally {
    await app.stop()
    office?.stop()
  }
})

test("an office whose state can't be read shows why, then recovers", async () => {
  const office = createFakeOffice({ notImplemented: ["GET /people"] })
  const app = await bootFrame(createStub(office))
  try {
    const f = await app.until((f) => f.includes("can't be read"))
    expect(f).toContain("not implemented")
    office.notImplemented.clear()
    await app.until((f) => !f.includes("can't be read") && f.includes("@minh"), 8000)
  } finally {
    await app.stop()
    office.stop()
  }
})

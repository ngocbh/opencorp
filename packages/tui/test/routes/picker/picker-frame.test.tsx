import { expect, test } from "bun:test"
import type { Person } from "@opencorp/protocol"
import { createFakeOffice, createStub, seed } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"
import { typeInto } from "./type"

const agent = (handle: string, title: string): Person => ({
  handle,
  name: handle[0].toUpperCase() + handle.slice(1),
  kind: "agent",
  title,
  manager: "ngocbh",
})

/** Renders a few more frames, well past the flush where the picker would open, and returns the last. */
async function settled(app: Awaited<ReturnType<typeof bootFrame>>) {
  for (let i = 0; i < 10; i++) {
    await app.setup.renderOnce()
    await Bun.sleep(20)
  }
  return app.until(() => true)
}

/** @minh worked in /tmp/proj; @lan has a main session elsewhere; @kai has neither. */
function office() {
  const s = seed()
  s.people.push(agent("lan", "QA engineer"), agent("kai", "Designer"))
  s.sessions.unshift({ ...s.sessions[0], id: "01JA0000000000000000000LAN", person: "lan", cwd: "/tmp/other" })
  return createFakeOffice({ seed: s })
}

test("<leader>p lists this folder's people, then recent people, then everyone, then hire; picking one switches", async () => {
  const fake = office()
  const app = await bootFrame(createStub(fake))
  try {
    await app.until((f) => f.includes("@minh"))
    app.input.pressKey("x", { ctrl: true })
    await app.setup.renderOnce()
    app.input.pressKey("p")
    const f = await app.until((f) => f.includes("Who do you want to talk to?") && f.includes("Hire new…"))
    const at = (s: string) => f.indexOf(s)
    expect(at("This folder")).toBeLessThan(at("@minh"))
    expect(at("@minh")).toBeLessThan(at("Recent"))
    expect(at("Recent")).toBeLessThan(at("@lan"))
    expect(at("@lan")).toBeLessThan(at("Everyone"))
    expect(at("Everyone")).toBeLessThan(at("@kai"))
    expect(at("@kai")).toBeLessThan(at("Hire new…"))
    expect(f).not.toContain("@ngocbh")
    await typeInto(app, "kai")
    await app.until((f) => f.includes("@kai") && !f.includes("@lan"))
    app.input.pressEnter()
    await app.until((f) => !f.includes("Who do you want") && f.includes("@kai") && f.includes("Designer"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("/people opens the picker too", async () => {
  const fake = office()
  const app = await bootFrame(createStub(fake))
  try {
    await app.until((f) => f.includes("@minh"))
    await app.input.typeText("/people")
    await app.until((f) => f.includes("Switch person"))
    app.input.pressEnter()
    await app.until((f) => f.includes("Who do you want to talk to?"))
  } finally {
    await app.stop()
    fake.stop()
  }
})

test("in a folder nobody has worked in, the picker opens at start; not with --person", async () => {
  const fake = office()
  const app = await bootFrame({ ...createStub(fake), cwd: "/tmp/new" })
  try {
    const f = await app.until((f) => f.includes("Who do you want to talk to?"))
    expect(f).not.toContain("This folder")
    app.input.pressEscape()
    await app.until((f) => !f.includes("Who do you want") && f.includes("Ask anything"))
  } finally {
    await app.stop()
  }
  const chosen = await bootFrame({ ...createStub(fake), cwd: "/tmp/new" }, { person: "lan" })
  try {
    await chosen.until((f) => f.includes("@lan"))
    expect(await settled(chosen)).not.toContain("Who do you want")
  } finally {
    await chosen.stop()
    fake.stop()
  }
})

const seeded = seed().sessions[0].id
for (const [flag, args, started] of [
  ["--continue", { continue: true }, "GET /folders"],
  ["--session", { sessionID: seeded }, `GET /sessions/${seeded}/messages`],
  ["--prompt", { prompt: "hello" }, "POST /sessions"],
] as const) {
  test(`${flag} keeps the picker shut in a new folder`, async () => {
    const fake = office()
    const app = await bootFrame({ ...createStub(fake), cwd: "/tmp/new" }, args)
    try {
      await app.until(() => fake.requests.some((r) => `${r.method} ${r.path}`.startsWith(started)))
      expect(await settled(app)).not.toContain("Who do you want")
    } finally {
      await app.stop()
      fake.stop()
    }
  })
}

test("the picker opens when the office first comes online, and not again after a reconnect", async () => {
  const socket = `/tmp/act-pick-${process.pid}.sock`
  const app = await bootFrame({ ...createStub(), socket, cwd: "/tmp/new" })
  let fake: ReturnType<typeof office> | undefined
  try {
    await app.until((f) => f.includes("Office is not running"))
    fake = createFakeOffice({ socket })
    await app.until((f) => f.includes("Who do you want to talk to?"), 8000)
    app.input.pressEscape()
    await app.until((f) => !f.includes("Who do you want"))
    fake.stop()
    await app.until((f) => f.includes("Office is not running"), 8000)
    fake = createFakeOffice({ socket })
    const back = fake
    await app.until((f) => !f.includes("Office is not running") && back.requests.some((r) => r.path.startsWith("/folders")), 8000)
    expect(await settled(app)).not.toContain("Who do you want")
  } finally {
    await app.stop()
    fake?.stop()
  }
}, 30000)

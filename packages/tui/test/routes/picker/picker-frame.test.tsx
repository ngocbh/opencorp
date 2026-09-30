import { expect, test } from "bun:test"
import type { Person } from "@agent-corp/protocol"
import { createFakeOffice, createStub, seed } from "../../../script/stub"
import { bootFrame } from "../../fixture/frame"
import { typeInto } from "./type"

const agent = (handle: string, title: string): Person => ({
  id: handle,
  handle,
  name: handle[0].toUpperCase() + handle.slice(1),
  kind: "agent",
  title,
  manager: "ngocbh",
})

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

import { expect, test } from "bun:test"
import { createFakeOffice, createStub, type FakeOffice } from "../script/stub"
import { bootFrame } from "./fixture/frame"

test("the home screen against a running office shows the logo and the prompt", async () => {
  const office = createFakeOffice()
  const app = await bootFrame(createStub(office))
  try {
    const f = await app.until((f) => f.includes("Ask anything"))
    expect(f).toContain("█▀▀█ █▀▀█ █▀▀█ █▀▀▄")
    expect(f).not.toContain("Office is not running")
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
    await app.until((f) => !f.includes("Office is not running"), 8000)
  } finally {
    await app.stop()
    office?.stop()
  }
})

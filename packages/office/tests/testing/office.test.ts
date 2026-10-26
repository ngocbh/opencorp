/** The real office on a temp home that the client packages' tests start: it answers on its socket, sends a device's
 *  token when asked to, and stops leaving no process or folder behind. */
import fs from "node:fs"
import path from "node:path"
import { expect, onTestFinished, test } from "bun:test"
import { startOffice } from "../../src/testing/office.ts"
import { request } from "../daemon/helpers.ts"

const TIMEOUT = 60_000

/** Whether a process `pid` exists. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

test(
  "a started office answers on its socket and stop leaves no process or home",
  async () => {
    const office = await startOffice()
    onTestFinished(() => office.stop())
    const health = await request(office.socket, "GET", "/health")
    expect(health.status).toBe(200)
    expect(health.json()).toEqual({ ok: true })
    const people = await request(office.socket, "GET", "/people")
    expect(people.status).toBe(200)
    const handles = (people.json() as { handle: string }[]).map((person) => person.handle)
    expect(handles).toEqual(expect.arrayContaining(["minh", "ngocbh"]))
    const pid = Number.parseInt(fs.readFileSync(path.join(office.home, "office", "office.pid"), "utf8"), 10)
    expect(running(pid)).toBe(true)
    await office.stop()
    expect(running(pid)).toBe(false)
    expect(fs.existsSync(office.root)).toBe(false)
  },
  TIMEOUT,
)

test(
  "a device office sends its token",
  async () => {
    const office = await startOffice({ device: true })
    onTestFinished(() => office.stop())
    expect(typeof office.token).toBe("string")
    expect(office.token).not.toBe("")
    const headers = { authorization: `Bearer ${office.token}` }
    const reply = await request(office.socket, "GET", "/whoami", { headers })
    expect(reply.status).toBe(200)
    expect((reply.json() as { person: string }).person).toBe("ngocbh")
  },
  TIMEOUT,
)

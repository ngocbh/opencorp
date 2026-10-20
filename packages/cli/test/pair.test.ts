import { expect, test } from "bun:test"
import type { PairCode } from "@opencorp/protocol"
import { canOpen, pairOutput } from "../src/commands/pair"

const code = (over: Partial<PairCode> = {}): PairCode => ({
  path: "/pair#CODE1234567890abcdefgh",
  url: "http://127.0.0.1:49380/pair#CODE1234567890abcdefgh",
  socket: "/home/u/.opencorp/office/hq.sock",
  port: 49380,
  expires_at: "2026-10-19T10:05:00.000Z",
  open_file: "/home/u/.opencorp/office/pair-1a2b.html",
  ...over,
})
const opts = { host: "misha", noOpen: false, hqJson: "/home/u/.opencorp/office/hq.json", tcp: null }
const tcpOff = { enabled: false, port: 49380, listening: false, error: null, next_retry_at: null }
const taken = { enabled: true, port: 49380, listening: false, error: "Address already in use", next_retry_at: null }

test("a desktop session not over SSH can open a browser", () => {
  expect(canOpen({}, "darwin")).toBe(true)
  expect(canOpen({ DISPLAY: ":0" }, "linux")).toBe(true)
  expect(canOpen({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true)
  expect(canOpen({}, "linux")).toBe(false)
  expect(canOpen({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBe(false)
})

test("locally with TCP listening, it opens the redirect file and prints the URL", () => {
  const out = pairOutput(code(), { ...opts, env: {}, platform: "darwin" })
  expect(out.open).toBe("/home/u/.opencorp/office/pair-1a2b.html")
  expect(out.lines.join("\n")).toContain("http://127.0.0.1:49380/pair#CODE1234567890abcdefgh")
})

test("--no-open only prints", () => {
  expect(pairOutput(code(), { ...opts, noOpen: true, env: {}, platform: "darwin" }).open).toBeUndefined()
})

test("over SSH with TCP listening, it prints a forward of the same port", () => {
  const out = pairOutput(code({ port: 50001, url: "http://127.0.0.1:50001/pair#X", open_file: null }), {
    ...opts,
    env: { SSH_CONNECTION: "1 2 3 4" },
    platform: "linux",
  })
  expect(out.open).toBeUndefined()
  expect(out.lines).toContain("  ssh -N -L 50001:127.0.0.1:50001 misha")
  expect(out.lines).toContain("  http://127.0.0.1:50001/pair#X")
})

test("with TCP off, it prints a forward of hq.sock, and locally how to turn TCP on", () => {
  const off = code({ url: null, open_file: null })
  const local = pairOutput(off, { ...opts, tcp: tcpOff, env: {}, platform: "linux" }).lines
  expect(local).toContain("HQ's web port is off here.")
  expect(local).toContain("  ssh -N -L 49380:/home/u/.opencorp/office/hq.sock misha")
  expect(local).toContain("  http://127.0.0.1:49380/pair#CODE1234567890abcdefgh")
  expect(local.join("\n")).toContain("any free local port works")
  expect(local.join("\n")).toContain('"tcp": true to /home/u/.opencorp/office/hq.json')
  const ssh = { SSH_CONNECTION: "1 2 3 4" }
  const remote = pairOutput(off, { ...opts, tcp: tcpOff, env: ssh, platform: "linux" }).lines
  expect(remote.join("\n")).not.toContain('"tcp": true')
})

test("with TCP on but its port taken, it says so, forwards hq.sock, and doesn't say to turn TCP on", () => {
  const off = code({ url: null, open_file: null })
  const out = pairOutput(off, { ...opts, tcp: taken, env: {}, platform: "darwin" }).lines
  expect(out).toContain("HQ's web port 49380 is taken (Address already in use); `opencorp doctor` says more.")
  expect(out).toContain("  ssh -N -L 49380:/home/u/.opencorp/office/hq.sock misha")
  expect(out.join("\n")).not.toContain('"tcp": true')
})

test("when HQ's status can't be read, it says so rather than guess, and forwards hq.sock", () => {
  const off = code({ url: null, open_file: null })
  const out = pairOutput(off, { ...opts, tcp: null, env: {}, platform: "darwin" }).lines
  expect(out).toContain("Couldn't read the web port's status.")
  expect(out.join("\n")).not.toContain("is off")
  expect(out.join("\n")).not.toContain('"tcp": true')
  expect(out).toContain("  ssh -N -L 49380:/home/u/.opencorp/office/hq.sock misha")
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { PairCode } from "@opencorp/protocol"
import { createFakeOffice, type FakeOffice } from "../../tui/script/stub"
import { canOpen, pair, pairOutput, type PairDeps } from "../src/commands/pair"

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
const SOCKET_FORWARD = "  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49381:/home/u/.opencorp/office/hq.sock misha"
const taken = {
  enabled: true,
  port: 49380,
  listening: false,
  error: "Address already in use" as string | null,
  next_retry_at: null,
}

test("a desktop session not over SSH can open a browser", () => {
  expect(canOpen({}, "darwin")).toBe(true)
  expect(canOpen({ DISPLAY: ":0" }, "linux")).toBe(true)
  expect(canOpen({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true)
  expect(canOpen({}, "linux")).toBe(false)
  expect(canOpen({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBe(false)
  expect(canOpen({ SSH_CLIENT: "1 2 3" }, "darwin")).toBe(false)
  expect(canOpen({ SSH_TTY: "/dev/ttys001" }, "darwin")).toBe(false)
})

test("locally with TCP listening, it opens the redirect file and prints the URL", () => {
  const out = pairOutput(code(), { ...opts, env: {}, platform: "darwin" })
  expect(out.open).toBe("/home/u/.opencorp/office/pair-1a2b.html")
  expect(out.lines).toContain("Opening it in your browser. If the page doesn't open or load, use:")
  expect(out.lines.join("\n")).toContain("http://127.0.0.1:49380/pair#CODE1234567890abcdefgh")
})

test("the expiry reads as minutes from now, then the clock time", () => {
  const now = Date.parse("2026-10-19T10:00:00.000Z")
  const first = pairOutput(code(), { ...opts, now, env: {}, platform: "darwin" }).lines[0]
  expect(first).toMatch(/^This link signs a browser in once, in the next 5 minutes \(until \d\d?:\d\d.*\)\.$/)
  const late = pairOutput(code(), { ...opts, now: now + 250_000, env: {}, platform: "darwin" }).lines[0]
  expect(late).toContain("in the next 1 minute (until")
})

test("SSH_CLIENT or SSH_TTY count as over SSH too", () => {
  for (const env of [{ SSH_CLIENT: "1 2 3" }, { SSH_TTY: "/dev/pts/1" }])
    expect(pairOutput(code(), { ...opts, env, platform: "darwin" }).lines).toContain(
      "  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49380:127.0.0.1:49380 misha",
    )
})

test("--no-open only prints", () => {
  expect(pairOutput(code(), { ...opts, noOpen: true, env: {}, platform: "darwin" }).open).toBeUndefined()
})

test("over SSH with TCP listening, it forwards the same port, or hq.sock if that port is in use", () => {
  const out = pairOutput(code({ port: 50001, url: "http://127.0.0.1:50001/pair#X", open_file: null }), {
    ...opts,
    env: { SSH_CONNECTION: "1 2 3 4" },
    platform: "linux",
  })
  expect(out.open).toBeUndefined()
  expect(out.lines).toContain("  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:50001:127.0.0.1:50001 misha")
  expect(out.lines).toContain("  http://127.0.0.1:50001/pair#X")
  expect(out.lines).toContain(
    "If port 50001 is in use on your machine (an office runs there), forward HQ's socket instead:",
  )
  expect(out.lines).toContain(SOCKET_FORWARD)
  expect(out.lines).toContain("  http://127.0.0.1:49381/pair#CODE1234567890abcdefgh")
})

test("with TCP off, it prints a forward of hq.sock, and locally how to turn TCP on", () => {
  const off = code({ url: null, open_file: null })
  const local = pairOutput(off, { ...opts, tcp: tcpOff, env: {}, platform: "linux" }).lines
  expect(local).toContain("HQ's web port is off here.")
  expect(local).toContain(SOCKET_FORWARD)
  expect(local).toContain("  http://127.0.0.1:49381/pair#CODE1234567890abcdefgh")
  expect(local.join("\n")).toContain("any free local port works")
  expect(local.join("\n")).toContain('"tcp": true to /home/u/.opencorp/office/hq.json')
  const ssh = { SSH_CONNECTION: "1 2 3 4" }
  const remote = pairOutput(off, { ...opts, tcp: tcpOff, env: ssh, platform: "linux" }).lines
  expect(remote.join("\n")).not.toContain('"tcp": true')
})

test("with TCP on but not listening, it says why, forwards hq.sock, and doesn't say to turn TCP on", () => {
  const off = code({ url: null, open_file: null })
  const lines = (tcp: typeof taken) => pairOutput(off, { ...opts, tcp, env: {}, platform: "darwin" }).lines
  expect(lines({ ...taken, error: null })).toContain("HQ's web port 49380 isn't listening yet.")
  expect(lines({ ...taken, port: 0, error: null })).toContain("HQ's web port isn't listening yet.")
  expect(lines({ ...taken, port: 0 })).toContain(
    "HQ's web port isn't listening (Address already in use); `opencorp doctor` says more.",
  )
  const out = lines(taken)
  expect(out).toContain("HQ's web port 49380 isn't listening (Address already in use); `opencorp doctor` says more.")
  expect(out).toContain(SOCKET_FORWARD)
  expect(out.join("\n")).not.toContain('"tcp": true')
})

test("when HQ's status can't be read, it says so rather than guess, and forwards hq.sock", () => {
  const off = code({ url: null, open_file: null })
  const out = pairOutput(off, { ...opts, tcp: null, env: {}, platform: "darwin" }).lines
  expect(out).toContain("Couldn't read the web port's status.")
  expect(out.join("\n")).not.toContain("is off")
  expect(out.join("\n")).not.toContain('"tcp": true')
  expect(out).toContain(SOCKET_FORWARD)
})

test("a socket or hq.json path with spaces or quotes is shell-quoted", () => {
  const off = code({ url: null, open_file: null, socket: "/home/u v/it's/hq.sock" })
  const out = pairOutput(off, { ...opts, hqJson: "/home/u v/hq.json", tcp: tcpOff, env: {}, platform: "linux" }).lines
  expect(out).toContain(`  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49381:'/home/u v/it'\\''s/hq.sock' misha`)
  expect(out.join("\n")).toContain(`"tcp": true to '/home/u v/hq.json'`)
})

let office: FakeOffice | undefined
let home: string
const saved = process.env.OPENCORP_HOME
beforeEach(() => {
  home = fs.mkdtempSync("/tmp/ocp-")
  fs.mkdirSync(path.join(home, "office"))
  process.env.OPENCORP_HOME = home
})
afterEach(() => {
  office?.stop()
  office = undefined
  process.env.OPENCORP_HOME = saved
  fs.rmSync(home, { recursive: true, force: true })
})

/** A fake office on the home's socket, with HQ's TCP listener as `hq` says. */
const start = (hq: NonNullable<Parameters<typeof createFakeOffice>[0]>["hq"], missing: string[] = []) =>
  (office = createFakeOffice({ socket: path.join(home, "office", "office.sock"), hq, missing }))

/** The body of the last POST /hq/pair the fake office got. */
const pairBody = () => office!.requests.findLast((r) => r.method === "POST" && r.path === "/hq/pair")?.body

function deps(env: Record<string, string> = {}, platform = "darwin") {
  const spawned: string[][] = []
  const printed: string[] = []
  const d: PairDeps = {
    env,
    platform,
    hostname: () => "mac",
    spawn: (argv) => void spawned.push(argv),
    print: (l) => void printed.push(l),
  }
  return { d, spawned, printed }
}

test("on a Mac it asks for a redirect file and opens it; the opener gets only the file's path", async () => {
  start({ tcp: true, listening: true })
  const { d, spawned, printed } = deps()
  expect(await pair([], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: null, open_file: true })
  const code = printed.join("\n").match(/pair#([A-Za-z0-9_-]+)/)![1]
  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toHaveLength(2)
  expect(spawned[0][0]).toBe("open")
  expect(spawned[0][1]).toMatch(new RegExp(`^${home}/office/pair-[0-9a-f]+\\.html$`))
  expect(spawned[0].join(" ")).not.toContain(code)
})

test("on a Linux desktop it opens the file with xdg-open", async () => {
  start({ tcp: true, listening: true })
  const { d, spawned } = deps({ DISPLAY: ":0" }, "linux")
  expect(await pair([], d)).toBe(0)
  expect(spawned.map((argv) => argv[0])).toEqual(["xdg-open"])
})

test("--no-open and --handle", async () => {
  start({ tcp: true, listening: true })
  const { d, spawned } = deps()
  expect(await pair(["--no-open", "--handle", "ngocbh"], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: "ngocbh", open_file: false })
  expect(spawned).toEqual([])
})

test("over SSH it never asks for a file or opens anything", async () => {
  start({ tcp: true, listening: true })
  const { d, spawned, printed } = deps({ SSH_CONNECTION: "1 2 3 4" }, "linux")
  expect(await pair([], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: null, open_file: false })
  expect(spawned).toEqual([])
  expect(printed).toContain("  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49380:127.0.0.1:49380 mac")
})

test("with the web port taken it reads GET /hq and says so", async () => {
  start({ tcp: true, listening: false, error: "Address already in use" })
  const { d, printed, spawned } = deps()
  expect(await pair([], d)).toBe(0)
  expect(office!.requests.some((r) => r.method === "GET" && r.path === "/hq")).toBe(true)
  expect(printed).toContain(
    "HQ's web port 49380 isn't listening (Address already in use); `opencorp doctor` says more.",
  )
  expect(spawned).toEqual([])
})

test("with TCP off it says how to turn it on", async () => {
  start({ tcp: false })
  const { d, printed } = deps()
  expect(await pair([], d)).toBe(0)
  expect(printed).toContain("HQ's web port is off here.")
  expect(printed.join("\n")).toContain(`"tcp": true to ${path.join(home, "office", "hq.json")}`)
})

test("when GET /hq can't be read it says so, not that the web port is off", async () => {
  start({ tcp: false }, ["GET /hq"])
  const { d, printed } = deps()
  expect(await pair([], d)).toBe(0)
  expect(printed).toContain("Couldn't read the web port's status.")
  expect(printed.join("\n")).not.toContain("is off")
})

test("an office without HQ's routes says to update", async () => {
  start({ tcp: true }, ["POST /hq/pair"])
  expect(await pair([], deps().d)).toBe(1)
})

test("without an office it says so and exits 3", async () => {
  expect(await pair([], deps().d)).toBe(3)
})

test("an unknown option is a usage error", async () => {
  expect(await pair(["--nope"], deps().d)).toBe(2)
})

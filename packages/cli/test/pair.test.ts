import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { PairCode } from "@opencorp/protocol"
import { createFakeOffice, type FakeOffice } from "@opencorp/tui/fake-office"
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
const opts = { host: "misha", noOpen: false, hqJson: "/home/u/.opencorp/office/hq.json", tcp: null, warnings: [] }
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

test("with TCP off because hq.json was ignored, it says why and to fix the file, not to add tcp", () => {
  const off = code({ url: null, open_file: null })
  const warning = "settings ignored, so the web port stays off until hq.json is fixed (restart to apply): x"
  const local = pairOutput(off, { ...opts, tcp: tcpOff, warnings: [warning], env: {}, platform: "darwin" }).lines
  expect(local).toContain("HQ's web port is off here.")
  expect(local).toContain(`  ${warning}`)
  expect(local).toContain(
    'To open it here instead, fix /home/u/.opencorp/office/hq.json so it has "tcp": true, then run `opencorp restart`.',
  )
  expect(local.join("\n")).not.toContain('add "tcp": true')
  expect(local).toContain(SOCKET_FORWARD)
  const ssh = { SSH_CONNECTION: "1 2 3 4" }
  const remote = pairOutput(off, { ...opts, tcp: tcpOff, warnings: [warning], env: ssh, platform: "darwin" }).lines
  expect(remote).toContain(`  ${warning}`)
  expect(remote.join("\n")).not.toContain("To open it here")
})

test("with TCP off and a warning that isnt about hq.json, it still says to add tcp", () => {
  const off = code({ url: null, open_file: null })
  const warning = "some other warning"
  const local = pairOutput(off, { ...opts, tcp: tcpOff, warnings: [warning], env: {}, platform: "darwin" }).lines
  expect(local).toContain(`  ${warning}`)
  expect(local.join("\n")).toContain('add "tcp": true to /home/u/.opencorp/office/hq.json')
  expect(local.join("\n")).not.toContain("fix /home/u/.opencorp/office/hq.json")
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

test("with the port taken here, it says how to pick another port before the hq.sock forward", () => {
  const off = code({ url: null, open_file: null })
  const out = pairOutput(off, { ...opts, tcp: taken, env: {}, platform: "darwin" }).lines
  const advice = out.findIndex((l) => l.startsWith("If another program holds port 49380"))
  expect(out[advice]).toBe(
    'If another program holds port 49380, set "port" in /home/u/.opencorp/office/hq.json to a free one, for ' +
      'example {"port": 49390}, or 0 for any free port (its URL then changes with each restart).',
  )
  expect(out[advice + 1]).toBe(
    "Create the file if it doesn't exist; keep any keys it already has. Then run `opencorp restart`.",
  )
  expect(advice).toBeGreaterThan(0)
  expect(advice).toBeLessThan(out.indexOf(SOCKET_FORWARD))
  const ssh = { SSH_CONNECTION: "1 2 3 4" }
  const remote = pairOutput(off, { ...opts, tcp: taken, env: ssh, platform: "darwin" }).lines
  expect(remote.join("\n")).not.toContain("If another program holds")
  const binding = pairOutput(off, { ...opts, tcp: { ...taken, error: null }, env: {}, platform: "darwin" }).lines
  expect(binding.join("\n")).not.toContain("If another program holds")
  const local = pairOutput(off, { ...opts, tcp: tcpOff, env: {}, platform: "darwin" }).lines
  expect(local.join("\n")).not.toContain("If another program holds")
  const anyPort = { ...taken, port: 0, error: "its server ended (it failed: x)" }
  const ended = pairOutput(off, { ...opts, tcp: anyPort, env: {}, platform: "darwin" }).lines
  expect(ended.join("\n")).not.toContain("If another program holds")
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

type FakeOpts = NonNullable<Parameters<typeof createFakeOffice>[0]>
/** A fake office on the home's socket, with HQ's TCP listener as `hq` says. */
const start = (hq: FakeOpts["hq"], more: Omit<FakeOpts, "hq" | "socket"> = {}) =>
  (office = createFakeOffice({ socket: path.join(home, "office", "office.sock"), hq, ...more }))

/** The body of the last POST /hq/pair the fake office got. */
const pairBody = () => office!.requests.findLast((r) => r.method === "POST" && r.path === "/hq/pair")?.body

function deps(env: Record<string, string> = {}, platform = "darwin") {
  const spawned: string[][] = []
  const printed: string[] = []
  const errors: string[] = []
  const d: PairDeps = {
    env,
    platform,
    hostname: () => "mac",
    spawn: (argv) => void spawned.push(argv),
    print: (l) => void printed.push(l),
    error: (l) => void errors.push(l),
  }
  return { d, spawned, printed, errors }
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
  start({ tcp: false }, { missing: ["GET /hq"] })
  const { d, printed } = deps()
  expect(await pair([], d)).toBe(0)
  expect(printed).toContain("Couldn't read the web port's status.")
  expect(printed.join("\n")).not.toContain("is off")
})

test("an office without HQ's routes, or that answers 501 for them, says to update", async () => {
  for (const more of [{ missing: ["POST /hq/pair"] }, { notImplemented: ["POST /hq/pair"] }]) {
    start({ tcp: true }, more)
    const { d, errors } = deps()
    expect(await pair([], d)).toBe(1)
    expect(errors).toEqual(["opencorp pair: this office has no HQ yet; update the checkout and run `opencorp restart`"])
    office!.stop()
    office = undefined
  }
})

test("a missing opener prints why and still exits 0: the link is already printed", async () => {
  start({ tcp: true, listening: true })
  const { d, printed, errors } = deps({ DISPLAY: ":0" }, "linux")
  d.spawn = () => {
    throw new Error('Executable not found in $PATH: "xdg-open"')
  }
  expect(await pair([], d)).toBe(0)
  expect(printed.join("\n")).toMatch(/http:\/\/127\.0\.0\.1:49380\/pair#/)
  expect(errors).toEqual([
    `Couldn't start xdg-open (Executable not found in $PATH: "xdg-open"); open the link above.`,
  ])
})

test("without an office it says so and exits 3", async () => {
  const { d, errors } = deps()
  expect(await pair([], d)).toBe(3)
  expect(errors).toEqual(["The office isn't running. Run `opencorp doctor`."])
})

test("an unknown option is a usage error", async () => {
  const { d, errors } = deps()
  expect(await pair(["--nope"], d)).toBe(2)
  expect(errors.join("\n")).toContain("usage: opencorp pair [--handle HANDLE] [--no-open]")
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { HqStatus, type HqTcp, PairCode } from "@opencorp/protocol"
import { createFakeOffice, type FakeOffice } from "@opencorp/tui/fake-office"
import { canOpen, hq, pairOutput, type HqDeps, socketPort } from "../src/commands/hq"
import { staleSocket } from "./sockets"

/** What a client says when no office answers at `home`. */
const notRunningAt = (home: string) =>
  `The office at ${home} isn't running. Run \`opencorp start\` (or \`opencorp doctor\` if it won't start);` +
  " set $OPENCORP_HOME if your office is elsewhere."

const code = (over: Partial<PairCode> = {}): PairCode => ({
  path: "/pair#CODE1234567890abcdefgh",
  url: "http://127.0.0.1:49380/pair#CODE1234567890abcdefgh",
  socket: "/home/u/.opencorp/office/hq.sock",
  port: 49380,
  expires_at: "2026-10-19T10:05:00.000Z",
  open_file: "/home/u/.opencorp/office/pair-1a2b.html",
  ...over,
})
const opts = { host: "misha", noOpen: false, hqJson: "/home/u/.opencorp/office/hq.json", status: null }
const tcpOff = { enabled: false, port: 49380, listening: false, error: null, next_retry_at: null }
const tcpListening = { enabled: true, port: 49380, listening: true, error: null, next_retry_at: null }
/** HQ's status with `tcp`, hq.sock listening and the app built, as `over` doesn't say otherwise. */
const st = (tcp: HqTcp, over: Partial<HqStatus> = {}): HqStatus => ({
  socket: "/home/u/.opencorp/office/hq.sock",
  tcp,
  url: null,
  health: { ok: true, office: { api: "x" }, app: { build: "b", api: "x" } },
  socket_error: null,
  warnings: [],
  ...over,
})
const APP_MISSING = "HQ's web app isn't built, so the link won't load yet; `opencorp doctor` says why."
const NO_SOCKET = "(HQ's socket isn't listening here, so there's no fallback through it; `opencorp doctor` says why.)"
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

test("the socket forward's local port moves off HQ's own TCP port", () => {
  expect(socketPort(49380)).toBe(49381)
  expect(socketPort(49381)).toBe(49382)
})

test("over SSH with HQ's TCP port on 49381, the socket fallback uses 49382", () => {
  const out = pairOutput(code({ port: 49381, url: "http://127.0.0.1:49381/pair#X", open_file: null }), {
    ...opts,
    env: { SSH_CONNECTION: "1 2 3 4" },
    platform: "linux",
  })
  expect(out.lines).toContain("  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49381:127.0.0.1:49381 misha")
  expect(out.lines).toContain(
    "  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49382:/home/u/.opencorp/office/hq.sock misha",
  )
  expect(out.lines).toContain("  http://127.0.0.1:49382/pair#CODE1234567890abcdefgh")
  expect(out.lines.join("\n")).not.toContain("127.0.0.1:49381:/home")
})

test("with no URL and HQ's port on 49381, the socket forward and its hint use 49382", () => {
  const off = code({ url: null, open_file: null, port: 49381 })
  const out = pairOutput(off, { ...opts, status: st({ ...tcpOff, port: 49381 }), env: {}, platform: "linux" }).lines
  expect(out).toContain(
    "  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49382:/home/u/.opencorp/office/hq.sock misha",
  )
  expect(out).toContain("  http://127.0.0.1:49382/pair#CODE1234567890abcdefgh")
  expect(out.join("\n")).toContain("in place of 49382")
})

test("with TCP off, it prints a forward of hq.sock, and locally how to turn TCP on", () => {
  const off = code({ url: null, open_file: null })
  const local = pairOutput(off, { ...opts, status: st(tcpOff), env: {}, platform: "linux" }).lines
  expect(local).toContain("HQ's web port is off here.")
  expect(local).toContain(SOCKET_FORWARD)
  expect(local).toContain("  http://127.0.0.1:49381/pair#CODE1234567890abcdefgh")
  expect(local.join("\n")).toContain("any free local port works")
  expect(local.join("\n")).toContain('"tcp": true to /home/u/.opencorp/office/hq.json')
  const ssh = { SSH_CONNECTION: "1 2 3 4" }
  const remote = pairOutput(off, { ...opts, status: st(tcpOff), env: ssh, platform: "linux" }).lines
  expect(remote.join("\n")).not.toContain('"tcp": true')
})

test("with TCP off because hq.json was ignored, it says why and to fix the file, not to add tcp", () => {
  const off = code({ url: null, open_file: null })
  const warning = "settings ignored, so the web port stays off until hq.json is fixed (restart to apply): x"
  const status = st(tcpOff, { warnings: [warning] })
  const local = pairOutput(off, { ...opts, status, env: {}, platform: "darwin" }).lines
  expect(local).toContain("HQ's web port is off here.")
  expect(local).toContain(`  ${warning}`)
  expect(local).toContain(
    'To open it here instead, fix /home/u/.opencorp/office/hq.json so it has "tcp": true, then run `opencorp restart`.',
  )
  expect(local.join("\n")).not.toContain('add "tcp": true')
  expect(local).toContain(SOCKET_FORWARD)
  const ssh = { SSH_CONNECTION: "1 2 3 4" }
  const remote = pairOutput(off, { ...opts, status, env: ssh, platform: "darwin" }).lines
  expect(remote).toContain(`  ${warning}`)
  expect(remote.join("\n")).not.toContain("To open it here")
})

test("with TCP off and a warning that isnt about hq.json, it still says to add tcp", () => {
  const off = code({ url: null, open_file: null })
  const warning = "some other warning"
  const status = st(tcpOff, { warnings: [warning] })
  const local = pairOutput(off, { ...opts, status, env: {}, platform: "darwin" }).lines
  expect(local).toContain(`  ${warning}`)
  expect(local.join("\n")).toContain('add "tcp": true to /home/u/.opencorp/office/hq.json')
  expect(local.join("\n")).not.toContain("fix /home/u/.opencorp/office/hq.json")
})

test("with TCP on but not listening, it says why, forwards hq.sock, and doesn't say to turn TCP on", () => {
  const off = code({ url: null, open_file: null })
  const lines = (tcp: typeof taken) => pairOutput(off, { ...opts, status: st(tcp), env: {}, platform: "darwin" }).lines
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
  const out = pairOutput(off, { ...opts, status: st(taken), env: {}, platform: "darwin" }).lines
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
  const remote = pairOutput(off, { ...opts, status: st(taken), env: ssh, platform: "darwin" }).lines
  expect(remote.join("\n")).not.toContain("If another program holds")
  const binding = pairOutput(off, { ...opts, status: st({ ...taken, error: null }), env: {}, platform: "darwin" }).lines
  expect(binding.join("\n")).not.toContain("If another program holds")
  const local = pairOutput(off, { ...opts, status: st(tcpOff), env: {}, platform: "darwin" }).lines
  expect(local.join("\n")).not.toContain("If another program holds")
  const anyPort = { ...taken, port: 0, error: "its server ended (it failed: x)" }
  const ended = pairOutput(off, { ...opts, status: st(anyPort), env: {}, platform: "darwin" }).lines
  expect(ended.join("\n")).not.toContain("If another program holds")
})

test("when HQ's status can't be read, it says so rather than guess, and forwards hq.sock", () => {
  const off = code({ url: null, open_file: null })
  const out = pairOutput(off, { ...opts, status: null, env: {}, platform: "darwin" }).lines
  expect(out).toContain("Couldn't read the web port's status.")
  expect(out.join("\n")).not.toContain("is off")
  expect(out.join("\n")).not.toContain('"tcp": true')
  expect(out).toContain(SOCKET_FORWARD)
})

test("a socket or hq.json path with spaces or quotes is shell-quoted", () => {
  const off = code({ url: null, open_file: null, socket: "/home/u v/it's/hq.sock" })
  const hqJson = "/home/u v/hq.json"
  const out = pairOutput(off, { ...opts, hqJson, status: st(tcpOff), env: {}, platform: "linux" }).lines
  expect(out).toContain(`  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49381:'/home/u v/it'\\''s/hq.sock' misha`)
  expect(out.join("\n")).toContain(`"tcp": true to '/home/u v/hq.json'`)
})

test("over SSH with hq.sock not listening, it forwards the TCP port and offers no socket fallback", () => {
  const out = pairOutput(code({ port: 50001, url: "http://127.0.0.1:50001/pair#X", open_file: null }), {
    ...opts,
    status: st({ ...tcpListening, port: 50001 }, { socket_error: "EADDRINUSE" }),
    env: { SSH_CONNECTION: "1 2 3 4" },
    platform: "linux",
  })
  expect(out.lines).toContain("  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:50001:127.0.0.1:50001 misha")
  expect(out.lines).toContain("  http://127.0.0.1:50001/pair#X")
  expect(out.lines.join("\n")).not.toContain("forward HQ's socket instead")
  expect(out.lines.join("\n")).not.toContain("hq.sock misha")
  expect(out.lines).toContain(NO_SOCKET)
})

test("a status from an older office, with no socket_error, keeps the socket fallback", () => {
  const s = st(tcpListening)
  delete s.socket_error
  const out = pairOutput(code({ open_file: null }), {
    ...opts,
    status: s,
    env: { SSH_CONNECTION: "1 2 3 4" },
    platform: "linux",
  })
  expect(out.lines).toContain(SOCKET_FORWARD)
  expect(out.lines).not.toContain(NO_SOCKET)
})

test("locally with the app not built, it doesn't open the link, says why, and still prints it", () => {
  const status = st(tcpListening, { health: { ok: true, office: { api: "x" }, app: null } })
  const out = pairOutput(code(), { ...opts, status, env: {}, platform: "darwin" })
  expect(out.open).toBeUndefined()
  expect(out.lines[1]).toBe(APP_MISSING)
  expect(out.lines).toContain("Open it in your browser:")
  expect(out.lines).toContain("  http://127.0.0.1:49380/pair#CODE1234567890abcdefgh")
})

test("over SSH, or with no URL, the app not being built is said too", () => {
  const unbuilt = { ok: true as const, office: { api: "x" }, app: null }
  const ssh = pairOutput(code({ open_file: null }), {
    ...opts,
    status: st(tcpListening, { health: unbuilt }),
    env: { SSH_CONNECTION: "1 2 3 4" },
    platform: "linux",
  })
  expect(ssh.lines).toContain(APP_MISSING)
  const off = pairOutput(code({ url: null, open_file: null }), {
    ...opts,
    status: st(tcpOff, { health: unbuilt }),
    env: {},
    platform: "linux",
  })
  expect(off.lines).toContain(APP_MISSING)
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
  const d: HqDeps = {
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
  expect(await hq([], d)).toBe(0)
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
  expect(await hq([], d)).toBe(0)
  expect(spawned.map((argv) => argv[0])).toEqual(["xdg-open"])
})

test("--no-open and --handle", async () => {
  start({ tcp: true, listening: true })
  const { d, spawned } = deps()
  expect(await hq(["--no-open", "--handle", "ngocbh"], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: "ngocbh", open_file: false })
  expect(spawned).toEqual([])
})

test("--handle takes a handle with its @", async () => {
  start({ tcp: true, listening: true })
  const { d } = deps()
  expect(await hq(["--no-open", "--handle", "@ngocbh"], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: "ngocbh", open_file: false })
})

test("--sign-in on HQ's machine signs in as plain hq does", async () => {
  start({ tcp: true, listening: true })
  const { d, spawned } = deps()
  expect(await hq(["--sign-in"], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: null, open_file: true })
  expect(spawned).toHaveLength(1)
})

test("--json mints a link and prints it as one line of JSON, opening nothing", async () => {
  start({ tcp: true, listening: true })
  const { d, spawned, printed, errors } = deps()
  expect(await hq(["--json"], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: null, open_file: false })
  expect(printed).toHaveLength(1)
  const minted = PairCode.parse(JSON.parse(printed[0]!))
  expect(minted.open_file).toBeNull()
  expect(minted.path).toMatch(/^\/pair#/)
  expect(spawned).toEqual([])
  expect(errors).toEqual([])
})

test("--json takes --handle", async () => {
  start({ tcp: true, listening: true })
  const { d } = deps()
  expect(await hq(["--json", "--handle", "@ngocbh"], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: "ngocbh", open_file: false })
})

test("--json without an office exits 3, says why on stderr and prints nothing", async () => {
  const { d, printed, errors } = deps()
  expect(await hq(["--json"], d)).toBe(3)
  expect(errors).toEqual([notRunningAt(home)])
  expect(printed).toEqual([])
})

test("--json with hq.sock dead and TCP off mints nothing and exits 1", async () => {
  start({ tcp: false, socketError: "x" })
  const { d, printed, errors } = deps()
  expect(await hq(["--json"], d)).toBe(1)
  expect(office!.requests.some((r) => r.method === "POST" && r.path === "/hq/pair")).toBe(false)
  expect(printed).toEqual([])
  expect(errors.join("\n")).toContain("HQ can't be reached")
})

test("--check --json prints HQ's status as one line of JSON and mints nothing", async () => {
  start({ tcp: true, listening: true })
  const { d, printed, errors, spawned } = deps()
  expect(await hq(["--check", "--json"], d)).toBe(0)
  expect(printed).toHaveLength(1)
  const status = HqStatus.parse(JSON.parse(printed[0]!))
  expect(status.socket).toBe(path.join(home, "office", "hq.sock"))
  expect(office!.requests.some((r) => r.method === "GET" && r.path === "/hq")).toBe(true)
  expect(office!.requests.some((r) => r.method === "POST" && r.path === "/hq/pair")).toBe(false)
  expect(errors).toEqual([])
  expect(spawned).toEqual([])
})

test("--check without --json, or with another flag, is a usage error", async () => {
  start({ tcp: true, listening: true })
  for (const argv of [
    ["--check"],
    ["--check", "--json", "--no-open"],
    ["--check", "--json", "--handle", "x"],
    ["--check", "--json", "--sign-in"],
  ]) {
    const { d, printed, errors } = deps()
    expect({ argv, code: await hq(argv, d) }).toEqual({ argv, code: 2 })
    expect(errors.join("\n")).toContain(
      "usage: opencorp hq [--handle HANDLE] [--no-open] [--sign-in] [--json] [--check --json]",
    )
    expect(printed).toEqual([])
  }
  expect(office!.requests).toEqual([])
})

test("--check --json without an office exits 3 and says why", async () => {
  const { d, printed, errors } = deps()
  expect(await hq(["--check", "--json"], d)).toBe(3)
  expect(errors).toEqual([notRunningAt(home)])
  expect(printed).toEqual([])
})

test("--check --json against an office without HQ's routes exits 1 and says to update", async () => {
  start({ tcp: true }, { missing: ["GET /hq"] })
  const { d, printed, errors } = deps()
  expect(await hq(["--check", "--json"], d)).toBe(1)
  expect(errors).toEqual(["opencorp hq: this office has no HQ yet; update the checkout and run `opencorp restart`"])
  expect(printed).toEqual([])
})

test("over SSH it never asks for a file or opens anything", async () => {
  start({ tcp: true, listening: true })
  const { d, spawned, printed } = deps({ SSH_CONNECTION: "1 2 3 4" }, "linux")
  expect(await hq([], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: null, open_file: false })
  expect(spawned).toEqual([])
  expect(printed).toContain("  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49380:127.0.0.1:49380 mac")
})

test("with the web port taken it reads GET /hq and says so", async () => {
  start({ tcp: true, listening: false, error: "Address already in use" })
  const { d, printed, spawned } = deps()
  expect(await hq([], d)).toBe(0)
  expect(office!.requests.some((r) => r.method === "GET" && r.path === "/hq")).toBe(true)
  expect(printed).toContain(
    "HQ's web port 49380 isn't listening (Address already in use); `opencorp doctor` says more.",
  )
  expect(spawned).toEqual([])
})

test("with TCP off it says how to turn it on", async () => {
  start({ tcp: false })
  const { d, printed } = deps()
  expect(await hq([], d)).toBe(0)
  expect(printed).toContain("HQ's web port is off here.")
  expect(printed.join("\n")).toContain(`"tcp": true to ${path.join(home, "office", "hq.json")}`)
})

test("when GET /hq can't be read it says so, not that the web port is off", async () => {
  start({ tcp: false }, { missing: ["GET /hq"] })
  const { d, printed } = deps()
  expect(await hq([], d)).toBe(0)
  expect(printed).toContain("Couldn't read the web port's status.")
  expect(printed.join("\n")).not.toContain("is off")
})

test("an office without HQ's routes, or that answers 501 for them, says to update", async () => {
  for (const more of [{ missing: ["POST /hq/pair"] }, { notImplemented: ["POST /hq/pair"] }]) {
    start({ tcp: true }, more)
    const { d, errors } = deps()
    expect(await hq([], d)).toBe(1)
    expect(errors).toEqual(["opencorp hq: this office has no HQ yet; update the checkout and run `opencorp restart`"])
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
  expect(await hq([], d)).toBe(0)
  expect(printed.join("\n")).toMatch(/http:\/\/127\.0\.0\.1:49380\/pair#/)
  expect(errors).toEqual([
    `Couldn't start xdg-open (Executable not found in $PATH: "xdg-open"); open the link above.`,
  ])
})

for (const env of [{}, { SSH_CONNECTION: "1 2 3 4" }] as Record<string, string>[])
  test(`with hq.sock dead and TCP off, it says why, mints nothing and exits 1 [${Object.keys(env)}]`, async () => {
    start({ tcp: false, socketError: "AF_UNIX path too long" })
    const { d, printed, errors } = deps(env)
    expect(await hq([], d)).toBe(1)
    expect(office!.requests.some((r) => r.method === "POST" && r.path === "/hq/pair")).toBe(false)
    expect(printed.join("\n")).not.toContain("ssh -N")
    const said = errors.join("\n")
    expect(said).toContain("AF_UNIX path too long")
    expect(said).toContain("`opencorp doctor`")
    expect(said).toContain(`"tcp": true to ${path.join(home, "office", "hq.json")}`)
    expect(said).not.toContain("pair#")
  })

test("with hq.sock dead and the web port taken or not up yet, it says why and exits 1", async () => {
  start({ tcp: true, listening: false, error: "Address already in use", socketError: "x" })
  let { d, errors } = deps()
  expect(await hq([], d)).toBe(1)
  expect(office!.requests.some((r) => r.method === "POST" && r.path === "/hq/pair")).toBe(false)
  expect(errors.join("\n")).toContain("HQ's web port 49380 isn't listening (Address already in use)")
  expect(errors.join("\n")).not.toContain('"tcp": true')
  office!.stop()
  start({ tcp: true, listening: false, socketError: "x" })
  ;({ d, errors } = deps())
  expect(await hq([], d)).toBe(1)
  expect(errors.join("\n")).toContain("Run `opencorp hq` again once the web port is listening.")
  expect(errors.join("\n")).not.toContain("pair#")
})

for (const env of [{}, { SSH_CONNECTION: "1 2 3 4" }] as Record<string, string>[])
  test(`with hq.sock dead and hq.json ignored, it says to fix the file [${Object.keys(env)}]`, async () => {
    const warning = "settings ignored, so the web port stays off until hq.json is fixed (restart to apply): x"
    start({ tcp: false, socketError: "x", warnings: [warning] })
    const { d, errors } = deps(env)
    expect(await hq([], d)).toBe(1)
    const said = errors.join("\n")
    expect(errors).toContain(`  ${warning}`)
    expect(said).toContain(`fix ${path.join(home, "office", "hq.json")} so it has "tcp": true`)
    expect(said).not.toContain('add "tcp": true')
  })

for (const env of [{}, { SSH_CONNECTION: "1 2 3 4" }] as Record<string, string>[])
  test(`with hq.sock dead and the web port taken, it says how to pick another port [${Object.keys(env)}]`, async () => {
    start({ tcp: true, listening: false, error: "Address already in use", socketError: "x" })
    const { d, errors } = deps(env)
    expect(await hq([], d)).toBe(1)
    expect(errors).toContain(
      `If another program holds port 49380, set "port" in ${path.join(home, "office", "hq.json")} to a free one, ` +
        'for example {"port": 49390}, or 0 for any free port (its URL then changes with each restart).',
    )
    expect(errors).toContain(
      "Create the file if it doesn't exist; keep any keys it already has. Then run `opencorp restart`.",
    )
  })

test("with hq.sock dead but TCP listening, it prints the URL locally and the TCP forward over SSH", async () => {
  start({ tcp: true, listening: true, socketError: "x" })
  let { d, printed } = deps()
  expect(await hq([], d)).toBe(0)
  expect(printed.join("\n")).toMatch(/http:\/\/127\.0\.0\.1:49380\/pair#/)
  ;({ d, printed } = deps({ SSH_CONNECTION: "1 2 3 4" }, "linux"))
  expect(await hq([], d)).toBe(0)
  expect(printed).toContain("  ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:49380:127.0.0.1:49380 mac")
  expect(printed.join("\n")).not.toContain("hq.sock mac")
})

test("if the web port stops listening while the code is minted, with hq.sock dead, it shows no code", async () => {
  start({ tcp: true, listening: true, socketError: "x" })
  const release = office!.hold("POST /hq/pair")
  const { d, printed, errors, spawned } = deps()
  const run = hq([], d)
  const deadline = Date.now() + 2000
  while (!office!.requests.some((r) => r.method === "POST" && r.path === "/hq/pair")) {
    if (Date.now() > deadline) throw new Error("POST /hq/pair never came")
    await Bun.sleep(5)
  }
  office!.hq.listening = false
  release()
  expect(await run).toBe(1)
  expect([...printed, ...errors].join("\n")).not.toContain("pair#")
  expect(spawned).toEqual([])
  expect(errors.join("\n")).toContain("stopped listening")
})

test("with the app not built, it asks for no file, opens nothing, warns and still prints the link", async () => {
  start({ tcp: true, listening: true, app: false })
  const { d, printed, spawned } = deps()
  expect(await hq([], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: null, open_file: false })
  expect(spawned).toEqual([])
  expect(printed).toContain(APP_MISSING)
  expect(printed.join("\n")).toMatch(/http:\/\/127\.0\.0\.1:49380\/pair#/)
})

test("it reads HQ's status before it mints the code", async () => {
  start({ tcp: true, listening: true })
  const { d } = deps()
  expect(await hq([], d)).toBe(0)
  const at = (method: string, p: string) => office!.requests.findIndex((r) => r.method === method && r.path === p)
  expect(at("GET", "/hq")).toBeGreaterThanOrEqual(0)
  expect(at("GET", "/hq")).toBeLessThan(at("POST", "/hq/pair"))
})

test("when HQ's status can't be read, it opens the link as before", async () => {
  start({ tcp: true, listening: true }, { missing: ["GET /hq"] })
  const { d, spawned } = deps()
  expect(await hq([], d)).toBe(0)
  expect(pairBody()).toEqual({ handle: null, open_file: true })
  expect(spawned).toHaveLength(1)
})

test("without an office it says so and exits 3", async () => {
  const { d, errors } = deps()
  expect(await hq([], d)).toBe(3)
  expect(errors).toEqual([notRunningAt(home)])
})

test("with a socket nothing answers on, it says so and exits 3", async () => {
  const socket = path.join(home, "office", "office.sock")
  await staleSocket(socket)
  const { d, errors } = deps()
  expect(await hq([], d)).toBe(3)
  expect(errors).toEqual([
    `The office can't be reached: nothing answers on ${socket}; the office may have stopped or crashed. Run \`opencorp doctor\`.`,
  ])
})

test("an unknown option is a usage error", async () => {
  const { d, errors } = deps()
  expect(await hq(["--nope"], d)).toBe(2)
  expect(errors.join("\n")).toContain("usage: opencorp hq [--handle HANDLE] [--no-open] [--sign-in] [--json] [--check --json]")
})

test("--help prints the usage and exits 0 without the office", async () => {
  const { d, printed, errors } = deps()
  expect(await hq(["--help"], d)).toBe(0)
  expect(printed).toEqual(["usage: opencorp hq [--handle HANDLE] [--no-open] [--sign-in] [--json] [--check --json]"])
  expect(errors).toEqual([])
})

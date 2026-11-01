/** HQ on a real office: `opencorp pair` and password sign-in over TCP, hq.sock with TCP off and the SSH forwards
 *  `opencorp pair` prints, the company and the event stream, signing out, and what `opencorp doctor` says about HQ. */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { type Check, report } from "../../src/install/doctor.ts"
import { ps } from "../helpers.ts"
import { Browser, openOffice, type RunningOffice, URL_RE, waitListening } from "./helpers.ts"

const TIMEOUT = 240_000
const CODE = /\/pair#([A-Za-z0-9_-]+)/
/** The local port `opencorp pair` prints for an hq.sock forward. */
const LOCAL_PORT = 49381
const PASSWORD = "correct horse battery"

/** A running office with HQ's TCP listener on a free port. */
const webOffice = () => openOffice({ hq: { tcp: true, port: 0 } })

/** A running office with HQ's TCP listener off: hq.sock only. */
const sockOffice = () => openOffice({ hq: { tcp: false } })

/** A browser stand-in reaching hq.sock through an SSH forward whose local end makes the Host header `host`. */
function overHqSock(office: RunningOffice, host: string): Browser {
  return new Browser(`http://${host}`, { socket: path.join(office.paths.office, "hq.sock") })
}

/** One line of `opencorp doctor`'s report. */
function doctorLine(status: Check["status"], name: string, detail: string): string {
  return report([{ name, status, detail }])
}

/** A fresh folder in the test's root to run the CLI in. */
function scratch(office: RunningOffice): string {
  const dir = path.join(office.root, "t")
  fs.mkdirSync(dir)
  return dir
}

/** The office's log. */
const officeLog = (office: RunningOffice) => fs.readFileSync(path.join(office.paths.office, "office.log"), "utf8")

test(
  "pair sign in read the company and sign out",
  async () => {
    const office = await webOffice()
    const cwd = scratch(office)
    const status = await waitListening(office)
    const out = (await office.opencorp(["pair", "--no-open"], { cwd })).stdout
    const [, port, code] = out.match(URL_RE)!
    expect(status.url).toBe(`http://127.0.0.1:${port}/`)
    const origin = `http://127.0.0.1:${port}`
    const browser = new Browser(origin)
    expect((await browser.get("/api/health")).json().ok).toBe(true)
    expect((await browser.get("/api/company")).status).toBe(401)
    const session = (await browser.post("/api/pair", { code, label: "e2e" })).json()
    expect([session.person, session.via, session.issued_by]).toEqual(["ngocbh", "pair", "ngocbh"])
    const company = (await browser.get("/api/company")).json()
    expect(company.company.name).toBe("Acme")
    const handles = company.people.map((p: { handle: string }) => p.handle)
    expect(handles).toContain("ngocbh")
    expect(handles).toContain("minh")
    expect((await browser.get("/api/whoami")).json().person).toBe("ngocbh")
    expect(await browser.firstLine("/api/events")).toBe(": connected")
    const listed = (await office.opencorp(["devices", "list"], { cwd })).stdout
    expect(listed).toContain("Browsers (this office):")
    expect(listed).toContain(session.id)
    expect(listed).toContain("(e2e)")
    await office.opencorp(["devices", "remove-browser", session.id], { cwd })
    expect((await browser.get("/api/whoami")).status).toBe(401)
    expect((await browser.post("/api/pair", { code })).status).toBe(400) // single use
    const doctor = (await office.opencorp(["doctor"], { cwd, check: false })).stdout
    expect(doctor).toContain(doctorLine("ok", "hq", `web app at ${origin}/, and on ${status.socket}`))
  },
  TIMEOUT,
)

test(
  "a session holds eight streams and signing it out ends them all",
  async () => {
    const office = await webOffice()
    const cwd = scratch(office)
    await waitListening(office)
    const [, port, code] = (await office.opencorp(["pair", "--no-open"], { cwd })).stdout.match(URL_RE)!
    const browser = new Browser(`http://127.0.0.1:${port}`)
    const session = (await browser.post("/api/pair", { code })).json()
    const streams = []
    for (let i = 0; i < 10; i++) {
      const stream = browser.stream("/api/events")
      expect(await stream.connected).toBe(": connected")
      streams.push(stream)
    }
    // The cap ends the oldest, so a browser that comes back always gets its stream.
    await Promise.all(streams.slice(0, 2).map((s) => s.ended))
    await office.opencorp(["devices", "remove-browser", session.id], { cwd })
    await Promise.all(streams.slice(2).map((s) => s.ended))
  },
  TIMEOUT,
)

test(
  "password sign in the one refusal and the lock",
  async () => {
    const office = await webOffice()
    const cwd = scratch(office)
    const origin = (await waitListening(office)).url.replace(/\/+$/, "")
    await office.put("/people/ngocbh/password", { password: PASSWORD })
    const browser = new Browser(origin)
    expect((await browser.get("/api/company")).status).toBe(401)
    const signed = await browser.post("/api/login", { handle: "ngocbh", password: PASSWORD, label: "e2e" })
    expect(signed.status, signed.text).toBe(200)
    expect([signed.json().person, signed.json().via]).toEqual(["ngocbh", "login"])
    const name = new RegExp(`^opencorp_hq_${origin.slice(origin.lastIndexOf(":") + 1)}_[0-9a-f]{32}$`)
    expect(browser.cookies().filter((c) => name.test(c))).toHaveLength(1)
    const company = (await browser.get("/api/company")).json()
    expect(company.company.name).toBe("Acme")
    expect(company.people.some((p: { password_hash?: string }) => p.password_hash)).toBe(false)
    expect((await browser.get("/api/whoami")).json().person).toBe("ngocbh")

    const stranger = new Browser(origin)
    const signIn = (handle: string, password: string) => stranger.post("/api/login", { handle, password })
    // One answer for an unknown handle, an agent and a wrong password, so none of them tells which it was.
    const refusals = [
      await signIn("nobody", PASSWORD),
      await signIn("minh", PASSWORD),
      await signIn("ngocbh", "wrong horse battery"),
    ]
    expect(refusals.map((r) => [r.status, r.json()])).toEqual(
      Array(3).fill([401, { error: "bad_credentials", message: "wrong handle or password" }]),
    )
    // Five failures for (127.0.0.1, ngocbh) lock it.
    for (let i = 0; i < 4; i++) expect((await signIn("ngocbh", "wrong horse battery")).status).toBe(401)
    const locked = await signIn("ngocbh", PASSWORD) // even the right password waits now
    expect([locked.status, locked.json().error]).toEqual([429, "too_many_attempts"])
    const retryAfter = Number(locked.headers["retry-after"])
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(Number.isInteger(retryAfter)).toBe(true)
    expect(locked.json().message).toContain("opencorp pair")
    // The lock is per handle: another handle's refusals still say only "wrong handle or password".
    expect((await signIn("nobody", PASSWORD)).status).toBe(401)

    // Pairing never goes through the password check, so the lock doesn't keep the owner out.
    const code = (await office.opencorp(["pair", "--no-open"], { cwd })).stdout.match(URL_RE)![2]
    expect((await stranger.post("/api/pair", { code })).status).toBe(200)
    expect((await stranger.get("/api/company")).status).toBe(200)
    expect(officeLog(office)).not.toContain(PASSWORD)
  },
  TIMEOUT,
)

test(
  "a throttled sign in reaches the office log",
  async () => {
    // The positive side of the "not in office.log" checks above: HQ's sign-in lines do reach the log.
    const office = await webOffice()
    const origin = (await waitListening(office)).url.replace(/\/+$/, "")
    const stranger = new Browser(origin)
    for (let i = 0; i < 5; i++)
      expect((await stranger.post("/api/login", { handle: "ngocbh", password: PASSWORD })).status).toBe(401)
    expect((await stranger.post("/api/login", { handle: "ngocbh", password: PASSWORD })).status).toBe(429)
    const log = officeLog(office)
    expect(log).toContain("sign-in for @ngocbh from 127.0.0.1 throttled")
    expect(log).not.toContain(PASSWORD)
  },
  TIMEOUT,
)

test(
  "over ssh pair prints the same port forward and the hq sock one",
  async () => {
    const office = await webOffice()
    const cwd = scratch(office)
    const status = await waitListening(office)
    const port = status.tcp.port
    const hqSock = status.socket
    const out = (await office.opencorp(["pair", "--no-open"], { cwd, ssh: true })).stdout
    expect(out).toContain(`ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${port}:127.0.0.1:${port} `)
    expect(out).toContain(`ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${LOCAL_PORT}:${hqSock} `)
    expect(out).toContain(`http://127.0.0.1:${port}/pair#`)
    const code = out.match(new RegExp(`http://127\\.0\\.0\\.1:${LOCAL_PORT}/pair#([A-Za-z0-9_-]+)`))![1]
    // The hq.sock alternative works with the printed local port, while TCP listens too.
    const browser = overHqSock(office, `127.0.0.1:${LOCAL_PORT}`)
    expect((await browser.post("/api/pair", { code })).status).toBe(200)
    expect((await browser.get("/api/company")).json().company.name).toBe("Acme")
  },
  TIMEOUT,
)

test(
  "with tcp off pair prints the socket forward and hq sock serves any local port",
  async () => {
    const office = await sockOffice()
    const cwd = scratch(office)
    const out = (await office.opencorp(["pair", "--no-open"], { cwd })).stdout
    const hqSock = path.join(office.paths.office, "hq.sock")
    expect(out).toContain(`ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${LOCAL_PORT}:${hqSock} `)
    expect(out).toContain(`http://127.0.0.1:${LOCAL_PORT}/pair#`)
    expect(out).toContain('"tcp": true')
    const code = out.match(CODE)![1]
    const browser = overHqSock(office, "127.0.0.1:61234") // any local port: hq.sock takes them all
    expect((await browser.post("/api/pair", { code })).status).toBe(200)
    expect((await browser.get("/api/company")).json().company.name).toBe("Acme")
    expect((await browser.get("/api/company", { headers: { host: "misha.example:61234" } })).status).toBe(403)
    expect(fs.statSync(hqSock).mode & 0o777).toBe(0o600)
    const doctor = (await office.opencorp(["doctor"], { cwd, check: false })).stdout
    expect(doctor).toContain(
      doctorLine("ok", "hq", `on ${hqSock} only (the web port is off); \`opencorp pair\` prints the SSH forward`),
    )
  },
  TIMEOUT,
)

test(
  "the code never reaches a process list or the log",
  async () => {
    // The code is in no running process's arguments, the daemon's and its children's included (the CLI that
    // printed it has exited by now), and not in the office's log.
    const office = await sockOffice()
    const cwd = scratch(office)
    const out = (await office.opencorp(["pair", "--no-open"], { cwd })).stdout
    const code = out.match(CODE)![1]!
    const commands = execFileSync(ps(), ["-wwaxo", "command="], { env: {}, encoding: "utf8", timeout: 5000 })
    expect(commands.split("\n").filter((line) => line.includes(code))).toEqual([])
    expect(officeLog(office)).not.toContain(code)
  },
  TIMEOUT,
)

test(
  "doctor names what keeps hq off hq sock",
  async () => {
    const office = await openOffice({ onboard: false })
    const cwd = scratch(office)
    const hqSock = path.join(office.paths.office, "hq.sock")
    fs.writeFileSync(hqSock, "not a socket\n")
    await office.onboard()
    expect((await office.hqStatus()).socket_error).toBe(`${hqSock} exists and is not a socket`)
    const doctor = (await office.opencorp(["doctor"], { cwd, check: false })).stdout
    expect(doctor).toContain(
      doctorLine(
        "warn",
        "hq",
        `not listening on ${hqSock}: ${hqSock} exists and is not a socket; run \`opencorp restart\` once that's fixed`,
      ),
    )
  },
  TIMEOUT,
)

/** HQ's lines for doctor: reading HQ's status from the office, and the checks it gives. */
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import type { HqStatus } from "@opencorp/protocol"
import { VERSION } from "@opencorp/protocol/version"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { Identity, identityPath, readIdentity, writeIdentity } from "../../../src/runtime/auth/identity.ts"
import { newToken } from "../../../src/runtime/auth/tokens.ts"
import { attach } from "../../../src/server/hq/core.ts"
import { type Check, report } from "../../../src/features/doctor/doctor.ts"
import { hqChecks, hqPortChecks, hqStatus } from "../../../src/server/hq/checks.ts"
import { CEO, giveDevice, makeOffice, served } from "../helpers.ts"
import { shortDir, tempDir } from "../../helpers.ts"

// A status read can wait 10 s for the office, past bun's default test timeout.
setDefaultTimeout(30_000)

test("hq status is read with this devices token", async () => {
  const office = makeOffice()
  const home = tempDir()
  const token = newToken()
  giveDevice(office.paths.company, CEO, "mac", token) // enforced from now on
  await writeIdentity(identityPath(home), new Identity(CEO, "mac", token))
  attach(office, { log: () => {}, listen: false })
  const { sock } = await served(office, { tokens: true })
  const status = await hqStatus(sock, await readIdentity(identityPath(home)), 10_000)
  if (typeof status === "string") throw new Error(`unread: ${status}`)
  expect(status.socket.endsWith("hq.sock")).toBe(true)
  expect(report(hqChecks(status, home, home))).not.toContain(token)
  fs.unlinkSync(identityPath(home))
  const gone = await readIdentity(identityPath(home))
  expect(gone).toBeUndefined()
  expect(await hqStatus(sock, gone, 10_000)).toBe("refused") // 401
})

test("an office without hq or no office at all is unreachable", async () => {
  const { sock } = await served(makeOffice()) // HQ not attached: 501
  expect(await hqStatus(sock, undefined)).toBe("unreachable")
  expect(await hqStatus(path.join(shortDir(), "nothing.sock"), undefined)).toBe("unreachable")
})

/** A stand-in office on a unix socket answering every request with `status` and `body`, or never when `body` is
 *  undefined; closed when the test finishes. */
async function answering(status: number, body?: string): Promise<string> {
  const server = http.createServer((_req, res) => {
    if (body !== undefined) res.writeHead(status, { "content-type": "application/json" }).end(body)
  })
  // Registered before shortDir's removal, so the server is closed first.
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const sock = path.join(shortDir(), "o.sock")
  await new Promise<void>((resolve) => server.listen(sock, resolve))
  return sock
}

test("an office from before hq is unreachable", async () => {
  const sock = await answering(404, JSON.stringify({ error: "no_route" }))
  expect(await hqStatus(sock, undefined)).toBe("unreachable")
})

test("an office that doesnt answer in time is unreachable", async () => {
  const sock = await answering(200)
  expect(await hqStatus(sock, undefined, 200)).toBe("unreachable")
})

/** An HQ status listening on its web port with a current app, with `tcp` over its TCP fields. */
function status(tcp: Partial<HqStatus["tcp"]> = {}): HqStatus {
  return {
    socket: "/h/office/hq.sock",
    tcp: { enabled: true, port: 49380, listening: true, error: null, next_retry_at: null, ...tcp },
    url: "http://127.0.0.1:49380/",
    health: { ok: true, office: { api: "0.0.1+aaa" }, app: { build: "b", api: "0.0.1+aaa" } },
    warnings: [],
  }
}

test("an answer that isnt an hq status is unreadable", async () => {
  const bodies = [
    "<html>",
    '{"ok": true}',
    '{"socket": "/s", "tcp": [], "url": null, "health": {}}',
    "[1]",
    JSON.stringify({ ...status(), warnings: [1] }),
  ]
  for (const body of bodies) {
    const sock = await answering(200, body)
    expect(await hqStatus(sock, undefined, 10_000), body).toBe("unreadable")
  }
  const sock = await answering(200, JSON.stringify(status()))
  expect(await hqStatus(sock, undefined, 10_000)).toEqual(status())
})

function byName(found: Check[]): Record<string, Check> {
  return Object.fromEntries(found.map((c) => [c.name, c]))
}

test("hq listening and a current app", () => {
  const dir = tempDir()
  const got = byName(hqChecks(status(), dir, path.join(dir, "repo")))
  expect(got.hq!.status).toBe("ok")
  expect(got.hq!.detail).toContain("http://127.0.0.1:49380/")
  expect(got["web app"]!.status).toBe("ok")
})

test("a taken port names the fix", () => {
  const dir = tempDir()
  const got = byName(hqChecks(status({ listening: false, error: "Address already in use" }), dir, dir))
  expect(got.hq!.status).toBe("warn")
  expect(got.hq!.detail).toContain("Address already in use")
  expect(got.hq!.detail).toContain("hq.json")
})

test("a port not bound yet says so without a fix", () => {
  const dir = tempDir()
  const got = byName(hqChecks(status({ listening: false }), dir, dir)).hq!
  expect(got.status).toBe("warn")
  expect(got.detail).toContain("isn't listening yet (HQ is binding it)")
  expect(got.detail).not.toContain("hq.json")
  expect(got.detail).not.toContain("restart")
})

test("a web port server that ended is told to restart", () => {
  const dir = tempDir()
  const s = status({ listening: false, error: "its server ended (it stopped)" })
  const got = byName(hqChecks(s, dir, dir)).hq!
  expect(got.status).toBe("warn")
  expect(got.detail).toContain("server ended (it stopped)")
  expect(got.detail).toContain("`opencorp restart`")
  expect(got.detail).not.toContain("hq.json")
  expect(got.detail).not.toContain("isn't free")
})

test("tcp off points at hq", () => {
  const dir = tempDir()
  const got = byName(hqChecks(status({ enabled: false, listening: false }), dir, dir))
  expect(got.hq!.status).toBe("ok")
  expect(got.hq!.detail).toContain("opencorp hq")
})

test("an unbuilt or stale app warns", () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, "packages", "app"), { recursive: true })
  const s = status()
  s.health.app = null
  expect(byName(hqChecks(s, dir, dir))["web app"]!.detail).toContain("bun run build")
  s.health.app = { build: "b", api: "0.0.1+bbb" }
  expect(byName(hqChecks(s, dir, dir))["web app"]!.detail).toContain("doesn't match")
})

test("an install without the apps sources says it has no web app", () => {
  const dir = tempDir()
  const s = status()
  s.health.app = null
  const got = byName(hqChecks(s, dir, path.join(dir, "site-packages")))["web app"]!
  expect(got.status).toBe("warn")
  expect(got.detail).toContain("this install has no web app")
  expect(got.detail).toContain(`"app_dir" in ${path.join(dir, "hq.json")}`)
  expect(got.detail).toContain(`v${VERSION}`)
  expect(got.detail).not.toContain("bun")
})

for (const enabled of [true, false]) {
  test(`hq sock not listening warns and says to restart [${enabled}]`, () => {
    const dir = tempDir()
    const s = { ...status({ enabled, listening: enabled }), socket_error: "AF_UNIX path too long" }
    const got = byName(hqChecks(s, dir, dir))
    expect(got.hq!.status).toBe("warn")
    expect(got.hq!.detail.startsWith("not listening on /h/office/hq.sock: AF_UNIX")).toBe(true)
    expect(got.hq!.detail).toContain("`opencorp restart`")
    if (enabled) {
      // The web port is a separate line, so its own state isn't lost.
      expect(got["hq port"]!.status).toBe("ok")
      expect(got["hq port"]!.detail).toContain("http://127.0.0.1:49380/")
    } else {
      expect(got).not.toHaveProperty("hq port")
    }
  })
}

for (const enabled of [true, false]) {
  test(`a socket file gone from under the office warns and says to restart [${enabled}]`, () => {
    const dir = tempDir()
    const gone = "the socket file is gone; run `opencorp restart`"
    const got = byName(hqChecks(status({ enabled, listening: enabled }), dir, dir, gone))
    expect(got.hq).toEqual({ name: "hq", status: "warn", detail: `not listening on /h/office/hq.sock: ${gone}` })
    if (enabled) {
      expect(got["hq port"]).toEqual({ name: "hq port", status: "ok", detail: "web app at http://127.0.0.1:49380/" })
    } else {
      expect(got).not.toHaveProperty("hq port")
    }
  })
}

test("the offices own socket error comes before what doctor found at the path", () => {
  const dir = tempDir()
  const s = { ...status(), socket_error: "AF_UNIX path too long" }
  const got = byName(hqChecks(s, dir, dir, "the socket file is gone; run `opencorp restart`"))
  expect(got.hq!.detail).toContain("AF_UNIX path too long")
  expect(got.hq!.detail).not.toContain("gone")
})

test("hq sock and a taken port are two warnings", () => {
  const dir = tempDir()
  const s = { ...status({ listening: false, error: "Address already in use" }), socket_error: "Permission denied" }
  const got = byName(hqChecks(s, dir, dir))
  expect(got.hq!.status).toBe("warn")
  expect(got.hq!.detail).toContain("Permission denied")
  expect(got["hq port"]!.status).toBe("warn")
  expect(got["hq port"]!.detail).toContain("Address already in use")
})

test("the offices warnings are shown", () => {
  const dir = tempDir()
  const s = { ...status(), warnings: ["the web port is on and this host has other users (ann): ..."] }
  const shown = hqChecks(s, dir, dir).filter((c) => c.name === "hq warning")
  expect(shown.map((c) => c.detail)).toEqual(s.warnings)
  expect(shown.every((c) => c.status === "warn")).toBe(true)
})

test("the port checks say where the web port is and never mention the web app", () => {
  const dir = tempDir()
  const listening = hqPortChecks(status(), dir)
  expect(listening.map((c) => [c.name, c.status])).toEqual([["hq", "ok"]])
  const [taken, ...rest] = hqPortChecks(status({ listening: false, error: "Address already in use" }), dir)
  expect(rest).toEqual([])
  expect(taken!.status).toBe("warn")
  expect(taken!.detail).toStartWith("port 49380 isn't free (Address already in use)")
  expect(taken!.detail).toContain(`set another "port" in ${path.join(dir, "hq.json")}`)
  const both = { ...status({ listening: false, error: "Address already in use" }), socket_error: "Permission denied" }
  expect(hqPortChecks(both, dir).map((c) => [c.name, c.status])).toEqual([
    ["hq", "warn"],
    ["hq port", "warn"],
  ])
  const unbuilt = status()
  unbuilt.health.app = null
  expect(hqPortChecks(unbuilt, dir).some((c) => c.name === "web app")).toBe(false)
})

test("the port checks say when the socket file is gone from under the office", () => {
  const dir = tempDir()
  const gone = "the socket file is gone; run `opencorp restart`"
  expect(hqPortChecks(status(), dir, gone)).toEqual([
    { name: "hq", status: "warn", detail: `not listening on /h/office/hq.sock: ${gone}` },
    { name: "hq port", status: "ok", detail: "web app at http://127.0.0.1:49380/" },
  ])
})

test("a taken port gives the json to write", () => {
  const dir = tempDir()
  const got = byName(hqChecks(status({ listening: false, error: "Address already in use" }), dir, dir))
  expect(got.hq!.detail).toContain('for example {"port": 49390}')
  expect(got.hq!.detail).toContain("create the file if it doesn't exist; keep any keys it already has")
})

test("a refused device is told to log in", () => {
  const dir = tempDir()
  const [got, ...rest] = hqChecks("refused", dir, dir)
  expect(rest).toEqual([])
  expect(got!.status).toBe("warn")
  expect(got!.detail).toContain("`opencorp login`")
  expect(got!.detail).not.toContain("restart")
})

test("an unreachable hq is told to restart", () => {
  const dir = tempDir()
  const [got, ...rest] = hqChecks("unreachable", dir, dir)
  expect(rest).toEqual([])
  expect(got!.status).toBe("warn")
  expect(got!.detail).toContain("`opencorp restart`")
  expect(got!.detail).not.toContain("login")
})

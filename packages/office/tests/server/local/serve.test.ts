/** Serving the no-office host: a private socket in a fresh 0700 folder, a token per start held in memory, and the folder
 *  gone when the host stops, a crashed host's swept at the next start. The TUI's client reading it is in
 *  `tests/e2e/local_host.test.ts`, where the client package typechecks. */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { serveLocal } from "../../../src/server/local/serve.ts"
import { listenUnix } from "../../../src/util/sockets.ts"
import { fakeLlm } from "../../features/chat/helpers.ts"
import { shortDir } from "../../helpers.ts"
import { bearer, request } from "../helpers.ts"
import { startHost } from "./helpers.ts"

setDefaultTimeout(90_000)

/** The `opencorp-local-*` folders in `dir`. */
const folders = (dir: string) => fs.readdirSync(dir).filter((name) => name.startsWith("opencorp-local-"))

test("the local host serves on a socket in a 0700 folder, refuses a request without its token, and removes the socket when it stops", async () => {
  const tmp = shortDir()
  // What a crashed host left: its folder, with a socket nobody listens on.
  const crashed = path.join(tmp, "opencorp-local-Xq7Tz1")
  fs.mkdirSync(crashed, { mode: 0o700 })
  const dead = net.createServer()
  await listenUnix(dead, path.join(crashed, "s"))
  await new Promise<void>((resolve) => dead.close(() => resolve()))
  expect(fs.lstatSync(path.join(crashed, "s")).isSocket()).toBe(true)
  // Someone else's file of that name is left alone.
  fs.writeFileSync(path.join(tmp, "opencorp-local-notdir"), "")

  const fake = await fakeLlm()
  const { host } = await startHost(fake)
  const served = await serveLocal(host, { tmpdir: tmp })
  onTestFinished(() => served.close())
  expect(fs.existsSync(crashed)).toBe(false)
  expect(fs.existsSync(path.join(tmp, "opencorp-local-notdir"))).toBe(true)

  const dir = path.dirname(served.socket)
  expect(path.dirname(dir)).toBe(tmp)
  expect(path.basename(served.socket)).toBe("s")
  expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700)
  const socket = fs.lstatSync(served.socket)
  expect(socket.isSocket()).toBe(true)
  expect(socket.mode & 0o777).toBe(0o600)
  expect(fs.readdirSync(dir)).toEqual(["s"])
  // The token is in no file of the folder, nor in this process's argv or env.
  expect(served.token).toMatch(/^act_[A-Za-z0-9_-]{43}$/)
  expect(process.argv.join(" ")).not.toContain(served.token)
  expect(JSON.stringify(process.env)).not.toContain(served.token)

  const refused = await request(served.socket, "GET", "/sessions")
  expect(refused.status).toBe(401)
  expect((refused.json() as { error: string }).error).toBe("unauthenticated")
  const listed = await request(served.socket, "GET", "/sessions", { headers: bearer(served.token) })
  expect(listed.status).toBe(200)
  expect((listed.json() as { id: string }[]).map((s) => s.id)).toEqual([host.id])

  // A second host's folder is its own, and a live one isn't swept.
  const second = await serveLocal(host, { tmpdir: tmp })
  expect(second.socket).not.toBe(served.socket)
  expect(second.token).not.toBe(served.token)
  expect(folders(tmp)).toHaveLength(3)
  await second.close()
  expect(fs.existsSync(path.dirname(second.socket))).toBe(false)

  await served.close()
  expect(fs.existsSync(served.socket)).toBe(false)
  expect(fs.existsSync(dir)).toBe(false)
  expect(folders(tmp)).toEqual(["opencorp-local-notdir"])
})

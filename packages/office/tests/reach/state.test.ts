/** The visit's lock, `access.json`, the redirect files and the clean-up a visit starts with. */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { redirectPage, TTL } from "../../src/hq/pairing.ts"
import { startTime } from "../../src/install/proc.ts"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import { isSocket, runChild, sshEnv, startMaster, waitForSocket } from "../../src/reach/ssh.ts"
import {
  type Access,
  AccessError,
  cleanUp,
  codeFrom,
  DEFAULT_PORT,
  readAccess,
  removeAtExpiry,
  STATUS_STALE_MS,
  sha256,
  sweepRedirects,
  takeLock,
  writeAccess,
  writeRedirect,
} from "../../src/reach/state.ts"
import { PrivateFileError } from "../../src/secrets.ts"
import { fakeControlName } from "../../src/testing/fake_ssh.ts"
import { isGone, shortDir, waitFor } from "../helpers.ts"
import { fakeHome, reachCtx } from "./helpers.ts"

setDefaultTimeout(30_000)

const STATE = fileURLToPath(new URL("../../src/reach/state.ts", import.meta.url))

/** A fresh home with the hq folders made. */
function reachPaths(): ReachPaths {
  const paths = new ReachPaths(path.join(shortDir(), "h"))
  makeDirs(paths)
  return paths
}

const ACCESS: Access = {
  port: DEFAULT_PORT,
  sha256: "a".repeat(64),
  learned_at: "2026-11-11T10:00:00.000Z",
  last_used_at: null,
  signed_in_at: null,
}

test("a second takeLock gets null while the first holds it", () => {
  const paths = reachPaths()
  const first = takeLock(paths)
  expect(first).not.toBeNull()
  expect(takeLock(paths)).toBeNull()
  expect(fs.statSync(paths.lock).mode & 0o777).toBe(0o600)
  first!.release()
  const again = takeLock(paths)
  expect(again).not.toBeNull()
  again!.release()
})

test("the lock is free once its holder dies, even by SIGKILL, and a child it started never holds it", async () => {
  const paths = reachPaths()
  const script = [
    `import { spawn } from "node:child_process"`,
    `import { ReachPaths } from ${JSON.stringify(path.join(path.dirname(STATE), "paths.ts"))}`,
    `import { takeLock } from ${JSON.stringify(STATE)}`,
    `const lock = takeLock(new ReachPaths(${JSON.stringify(paths.home)}))`,
    `if (lock === null) process.exit(3)`,
    `const sleep = spawn("/bin/sleep", ["30"], { stdio: "ignore" })`,
    `console.log("held " + sleep.pid)`,
    `setInterval(() => {}, 1000)`,
  ].join("\n")
  const holder = spawn(process.execPath, ["--no-install", "--no-env-file", "--config=/dev/null", "-e", script], {
    cwd: path.dirname(STATE),
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "inherit"],
  })
  onTestFinished(() => holder.kill("SIGKILL"))
  const line = await createInterface({ input: holder.stdout! })[Symbol.asyncIterator]().next()
  const [word, pid] = String(line.value).split(" ")
  expect(word).toBe("held")
  const sleep = Number(pid)
  const started = startTime(sleep)
  onTestFinished(() => {
    if (!isGone(sleep, started)) process.kill(sleep, "SIGKILL")
  })
  expect(takeLock(paths)).toBeNull()
  const exited = new Promise((resolve) => holder.on("exit", resolve))
  holder.kill("SIGKILL")
  await exited
  expect(isGone(sleep, started)).toBe(false)
  const lock = takeLock(paths)
  expect(lock).not.toBeNull()
  lock!.release()
})

test("access.json round-trips at 0600, reads null when missing, and is an AccessError when invalid", async () => {
  const paths = reachPaths()
  expect(await readAccess(paths)).toBeNull()
  await writeAccess(paths, ACCESS)
  expect(fs.statSync(paths.access).mode & 0o777).toBe(0o600)
  expect(await readAccess(paths)).toEqual(ACCESS)
  const signedIn = { ...ACCESS, last_used_at: "2026-11-11T11:00:00.000Z", signed_in_at: "2026-11-11T11:00:01.000Z" }
  await writeAccess(paths, signedIn)
  expect(await readAccess(paths)).toEqual(signedIn)
  await expect(writeAccess(paths, { ...ACCESS, port: 80 })).rejects.toThrow()
  for (const bad of ["not json", JSON.stringify({ ...ACCESS, port: 80 }), JSON.stringify({ ...ACCESS, extra: 1 })]) {
    fs.writeFileSync(paths.access, bad, { mode: 0o600 })
    await expect(readAccess(paths)).rejects.toBeInstanceOf(AccessError)
  }
  fs.chmodSync(paths.access, 0o644)
  await expect(readAccess(paths)).rejects.toBeInstanceOf(PrivateFileError)
})

test("sha256 is the hex digest of the bytes", () => {
  expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  expect(sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})

const CODE = "AbCdEfGhIjKlMnOpQrSt_-"

/** A remote `opencorp hq --json`'s answer with `path`. */
const pairCode = (p: string) => ({
  path: p,
  url: null,
  socket: "/h/office/hq.sock",
  port: 0,
  expires_at: "2026-11-11T10:05:00.000Z",
  open_file: null,
})

test("only a 22-character base64url code from /pair# is taken", () => {
  expect(CODE).toHaveLength(22)
  expect(codeFrom(pairCode(`/pair#${CODE}`))).toBe(CODE)
  expect(codeFrom({ ...pairCode(`/pair#${CODE}`), url: `http://evil/pair#${CODE}` })).toBe(CODE)
  for (const bad of [CODE.slice(1), CODE + "a", CODE.slice(1) + '"', CODE.slice(1) + "<"])
    expect([bad, codeFrom(pairCode(`/pair#${bad}`))]).toEqual([bad, null])
  expect(codeFrom(pairCode(`/other#${CODE}`))).toBeNull()
  expect(codeFrom({ ...pairCode(`/pair#${CODE}`), extra: 1 })).toBeNull()
  expect(codeFrom({ path: `/pair#${CODE}` })).toBeNull()
  expect(codeFrom(undefined)).toBeNull()
})

test("the redirect file is 0600 and links to 127.0.0.1 at our port, holding no remote text", async () => {
  const paths = reachPaths()
  const file = await writeRedirect(paths, DEFAULT_PORT, CODE)
  expect(path.dirname(file)).toBe(paths.dir)
  expect(path.basename(file)).toMatch(/^pair-[0-9a-f]{16}\.html$/)
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  expect(fs.readFileSync(file, "utf8")).toBe(redirectPage(`http://127.0.0.1:49381/pair#${CODE}`))
  await expect(writeRedirect(paths, DEFAULT_PORT, '"><script>')).rejects.toThrow()
})

test("redirect files stay until their code expires, and a sweep removes only expired ones", async () => {
  const paths = reachPaths()
  const old = await writeRedirect(paths, DEFAULT_PORT, CODE)
  const fresh = await writeRedirect(paths, DEFAULT_PORT, CODE)
  const tmp = path.join(paths.dir, ".pair-x.html.1.tmp")
  fs.writeFileSync(tmp, "")
  const other = path.join(paths.dir, "notes.md")
  fs.writeFileSync(other, "")
  const now = Date.now()
  const sixMinutesAgo = new Date(now - 6 * 60_000)
  for (const f of [old, tmp, other]) fs.utimesSync(f, sixMinutesAgo, sixMinutesAgo)
  sweepRedirects(paths, now)
  expect([fs.existsSync(old), fs.existsSync(tmp), fs.existsSync(fresh), fs.existsSync(other)]).toEqual([false, false, true, true])
  expect(TTL).toBe(5 * 60_000)
  removeAtExpiry(fresh, 50)
  expect(fs.existsSync(fresh)).toBe(true)
  await waitFor(() => !fs.existsSync(fresh), { timeout: 2000, what: "the file to go at its expiry" })
})

test("start-up cleanup ends leftover masters and removes expired files and stale status files", async () => {
  const { dir, fake } = fakeHome()
  const ctx = await reachCtx(dir, fake)
  const hop = await runChild([ctx.paths.wrapper, "login1", "true"], { env: sshEnv(ctx), cwd: ctx.paths.dir, timeoutMs: 10_000 })
  expect(hop.code).toBe(0)
  const node = startMaster(ctx, { host: "node1", jump: ["login1"], opencorp: "/o/opencorp" }, { quiet: true })
  expect(await waitForSocket(node, 5000)).toBe("up")
  const expired = await writeRedirect(ctx.paths, DEFAULT_PORT, CODE)
  const live = await writeRedirect(ctx.paths, DEFAULT_PORT, CODE)
  const staleStatus = ctx.paths.status(1)
  const freshStatus = ctx.paths.status(2)
  for (const f of [staleStatus, freshStatus, ctx.paths.candidate]) fs.writeFileSync(f, "255\n", { mode: 0o600 })
  const now = Date.now()
  const longAgo = new Date(now - STATUS_STALE_MS - 1000)
  for (const f of [expired, staleStatus, ctx.paths.candidate]) fs.utimesSync(f, longAgo, longAgo)
  await cleanUp(ctx, now)
  expect(await node.exited).toBe(0)
  expect(fs.readdirSync(ctx.paths.cm)).toEqual([])
  expect(isSocket(path.join(ctx.paths.cm, fakeControlName("login1")))).toBe(false)
  await waitFor(() => fake.masters().length === 0, { timeout: 3000, what: "every master to end" })
  expect([expired, live, staleStatus, freshStatus, ctx.paths.candidate].map((f) => fs.existsSync(f))).toEqual([
    false,
    true,
    false,
    true,
    false,
  ])
  // A fresh candidate stays: a learning run may still be writing it.
  fs.writeFileSync(ctx.paths.candidate, "")
  await cleanUp(ctx, Date.now())
  expect(fs.existsSync(ctx.paths.candidate)).toBe(true)
})

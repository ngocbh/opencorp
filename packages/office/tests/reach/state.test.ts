/** The visit's lock and `access.json`. */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { startTime } from "../../src/install/proc.ts"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import { type Access, AccessError, DEFAULT_PORT, readAccess, sha256, takeLock, writeAccess } from "../../src/reach/state.ts"
import { PrivateFileError } from "../../src/secrets.ts"
import { isGone, shortDir } from "../helpers.ts"

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

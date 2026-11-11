/** Helpers shared by the reach tests. */
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { onTestFinished } from "bun:test"
import { makeDirs, ReachPaths } from "../../src/reach/paths.ts"
import { type ReachContext, writeSshFiles } from "../../src/reach/ssh.ts"
import { type FakeSsh, type FakeSshBehavior, installFakeSsh } from "../../src/testing/fake_ssh.ts"

/** Limits short enough that a test which hits one still finishes. */
export const SHORT_LIMITS = Object.freeze({ promptMs: 5000, stepMs: 5000 })

/** A short home folder with a fake ssh in `<dir>/fake`. When the test finishes, every fake master is killed, then
 *  the folder removed (in that order, so no master outlives its state). */
export function fakeHome(behavior?: FakeSshBehavior): { dir: string; fake: FakeSsh } {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const fake = installFakeSsh(path.join(dir, "fake"), behavior)
  onTestFinished(() => {
    for (const pid of fake.masters()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, fake }
}

/** A context whose home is `dir` and whose ssh is `fake`, with the hq folders made and the ssh files written (no
 *  includes); children get only a system PATH and `dir` as HOME. */
export async function reachCtx(dir: string, fake: FakeSsh, more: Partial<ReachContext> = {}): Promise<ReachContext> {
  const paths = new ReachPaths(dir)
  makeDirs(paths)
  await writeSshFiles(paths, fake.ssh, [])
  return {
    paths,
    ssh: fake.ssh,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    batch: false,
    echo: () => {},
    limits: SHORT_LIMITS,
    ...more,
  }
}

/** Leaves a socket file at `file` that no server holds: moved aside while its server closes, then put back. */
export async function staleSocket(file: string) {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(file, resolve))
  fs.renameSync(file, `${file}.x`)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.renameSync(`${file}.x`, file)
}

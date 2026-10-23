/** Test helpers shared by the office's tests (Python's conftest fixtures). */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { onTestFinished } from "bun:test"

/** Polls `predicate` every 20 ms until it returns something truthy, and returns that; throws
 *  `timed out waiting for <what>` after `timeout` ms (Python's `wait_for`). */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  { timeout = 30_000, what = "condition" } = {},
): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Makes a directory with `prefix`, returns its real path, and removes it when the current test finishes. */
function dirForThisTest(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(prefix))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A fresh directory (real path) removed when the current test finishes. Call inside a test. */
export function tempDir(): string {
  return dirForThisTest(path.join(os.tmpdir(), "opencorp-"))
}

/** A directory with a short path, for unix sockets (macOS limits their paths to 104 bytes);
 *  removed when the current test finishes. Call inside a test. */
export function shortDir(): string {
  return dirForThisTest("/tmp/oc-")
}

/** A Codex session the owner drives: load, turns, steers, interrupts, end, office stop. */
import fs from "node:fs"
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { type CodexProcess, CodexStartError } from "../../src/harness/codex.ts"
import { CodexSessions } from "../../src/harness/sessions.ts"
import { workerEnv } from "../../src/worker/spawn.ts"
import { envNames } from "../helpers.ts"
import { allGone, makeCodex } from "./helpers.ts"

setDefaultTimeout(30_000)
afterAll(allGone)

/** What `CodexSessions.launch` needs of a session. */
function live(sessionId: string, cwd: string, stopped = false) {
  return {
    sessionId,
    cwd,
    stopped,
    launching: null as CodexProcess | null,
    launchingAs(process: CodexProcess) {
      if (!this.stopped) this.launching = process
      return !this.stopped
    },
    notified() {},
    requested() {},
    exited() {},
  }
}

test("launch registers the app server before it starts and refuses once stopped", async () => {
  const { office, store, hooks, sessions, workspace, fake } = makeCodex()
  const s1 = live("S1", workspace)
  const p = await sessions.launch(s1)
  expect(s1.launching).toBe(p)
  expect(p.alive).toBe(true)
  expect(store.listWorkers().map((r) => r.key)).toEqual(["harness:S1"])
  expect(fs.statSync(office.paths.runDir("S1")).mode & 0o777).toBe(0o700)
  await p.close(1000)
  await expect(sessions.launch(live("S2", workspace, true))).rejects.toBeInstanceOf(CodexStartError)
  expect(store.listWorkers()).toEqual([])
  // With no env given, an app-server gets the worker environment and CODEX_HOME, nothing else.
  const plain = new CodexSessions(office, hooks, { command: () => fake.command() })
  const p3 = await plain.launch(live("S3", workspace))
  const allowed = [...Object.keys(workerEnv(process.env)), "CODEX_HOME"]
  const names = envNames(p3.pid)
  expect(names.filter((name) => !allowed.includes(name))).toEqual([])
  expect(names).toContain("PATH")
  await p3.close(1000)
})

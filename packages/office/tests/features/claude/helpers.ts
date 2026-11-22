/** Claude Code test helpers: an office whose minh may use Claude Code, its Claude Code sessions over the fake Claude
 *  Code (`installFakeClaude`), scripted per test, and a main chat of minh's whose instrument they are. */
import fs from "node:fs"
import path from "node:path"
import type { LiveEvent, Message } from "@opencorp/protocol"
import { onTestFinished, spyOn } from "bun:test"
import { type ClaudeSessionsOptions, ClaudeSessions } from "../../../src/features/claude/sessions.ts"
import type { SessionRecord, Store } from "../../../src/runtime/store/store.ts"
import type { HarnessEvent } from "../../../src/tools/harness/adapter.ts"
import type { ThreadEvents, ThreadState } from "../../../src/tools/harness/instrument.ts"
import { type FakeClaudeScript, installFakeClaude } from "../../../src/testing/fake_claude.ts"
import { killGroup, sameProcess } from "../../../src/util/proc.ts"
import { person } from "../../company/helpers.ts"
import { makeOffice } from "../../server/helpers.ts"
import { isGone, tempDir, waitFor } from "../../helpers.ts"
import { session as sessionRow } from "../../runtime/store/helpers.ts"

/** minh, allowed the composer and Claude Code harnesses. */
export const CLAUDE_PERSON = { "people/minh/person.yaml": person("minh", { harnesses: ["composer", "claude"] }) }

/** Every Claude Code any test of a file recorded, for `allGone`. */
const spawned: { pid: number; started: number | null }[] = []

/** Waits until every Claude Code the file's tests recorded is gone (10 s each); each test file's `afterAll`. */
export async function allGone(): Promise<void> {
  for (const { pid, started } of spawned)
    await waitFor(() => isGone(pid, started), { timeout: 10_000, what: `process ${pid} to go` })
}

/** When the test finishes, each group `store` recorded whose leader still has its start time is killed. */
function tracked(store: Store): void {
  const spy = spyOn(store, "recordWorker")
  onTestFinished(() => {
    for (const [, { pid, startTime: started }] of spy.mock.calls) {
      spawned.push({ pid, started })
      if (started && sameProcess(pid, started)) killGroup(pid)
    }
  })
}

/** An office whose minh may use Claude Code (plus `files`), and its `ClaudeSessions` running the fake (2.1.325 and
 *  `script`) with a fixed environment, a temp owner's home and a stand-in socat; `options` replace the sessions'
 *  others. `lines` gets
 *  the sessions' log lines, `events` every live event the bus got. Call inside a test: the office's stop closes the
 *  sessions before the store closes, and every Claude Code still running is then killed. */
export function makeClaude({
  files = {},
  script = {},
  ...options
}: { files?: Record<string, unknown>; script?: FakeClaudeScript } & ClaudeSessionsOptions = {}) {
  const home = tempDir()
  const tmpBase = tempDir()
  fs.mkdirSync(path.join(home, ".claude"))
  const office = makeOffice({ files: { ...CLAUDE_PERSON, ...files }, guards: { home } })
  const store = office.store
  tracked(store)
  const events: LiveEvent[] = []
  const publish = office.bus.publishLive.bind(office.bus)
  spyOn(office.bus, "publishLive").mockImplementation((event) => {
    events.push(event)
    publish(event)
  })
  const lines: string[] = []
  const fake = installFakeClaude(path.join(tempDir(), "fake"), { version: "2.1.325", ...script })
  const socat = path.join(tempDir(), "socat")
  fs.writeFileSync(socat, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const sessions = new ClaudeSessions(office, {
    claude: fake.claude,
    socat,
    env: () => ({ PATH: "/usr/bin:/bin", HOME: home }),
    environ: {},
    tmpBase,
    closeGraceMs: 500,
    log: (line) => lines.push(line),
    ...options,
  })
  office.claude = sessions
  office.onStop.push(() => sessions.closeAll())
  return { office, store, sessions, fake, workspace: fs.realpathSync(tempDir()), home, tmpBase, lines, events }
}

export type Claude = ReturnType<typeof makeClaude>

/** minh's main chat in `h.workspace`, opened by ngocbh, at the company's head. */
export async function chatOf(h: Claude): Promise<SessionRecord> {
  const head = await h.office.git.head()
  return h.store.createSession(sessionRow({ cwd: h.workspace, repo_commit: head, opened_by: "ngocbh", connection: "office" }))
}

/** What an instrument hears of its session: each event and each state, in order. */
export class Heard implements ThreadEvents {
  readonly events: HarnessEvent[] = []
  readonly states: ThreadState[] = []

  event(e: HarnessEvent): void {
    this.events.push(e)
  }

  state(state: ThreadState): void {
    this.states.push(state)
  }

  /** The user and assistant messages heard, as their texts joined, in order. */
  said(): string[] {
    const messages = new Map<string, Message>()
    for (const e of this.events) {
      if (e.type === "message") messages.set(e.message.id, structuredClone(e.message))
      else if (e.type === "part") {
        const message = messages.get(e.messageId)
        if (message === undefined) continue
        const at = message.parts.findIndex((p) => p.id === e.part.id)
        if (at === -1) message.parts.push(e.part)
        else message.parts[at] = e.part
      }
    }
    return [...messages.values()].map((m) =>
      m.parts.flatMap((p) => (p.type === "text" ? [p.text] : p.type === "error" ? [`[error] ${p.message}`] : [])).join(""),
    )
  }
}

/** The owner's label and anyone else's, as the instrument's speakers name them. */
export const label = (author: string | null) => (author === "minh" ? "@minh" : "Hong Ngoc Bui (owner)")

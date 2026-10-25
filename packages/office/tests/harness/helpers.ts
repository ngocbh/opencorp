/** Codex test helpers (Python's `tests/harness/conftest.py`): an office whose minh may use Codex, its Codex sessions,
 *  and a fake app-server scripted per test. */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { LiveEvent, Message, Part } from "@opencorp/protocol"
import { onTestFinished, spyOn } from "bun:test"
import { Ajv } from "ajv"
import { Hooks } from "../../src/chat/hooks.ts"
import { type CodexSessionsOptions, CodexSessions } from "../../src/harness/sessions.ts"
import { killGroup, sameProcess } from "../../src/install/proc.ts"
import type { SessionRecord, Store } from "../../src/store/store.ts"
import { person } from "../company/helpers.ts"
import { CEO, makeOffice } from "../daemon/helpers.ts"
import { isGone, tempDir, waitFor } from "../helpers.ts"
import { recordEvents, session, workItem } from "../store/helpers.ts"

/** minh, allowed the composer and Codex harnesses. */
export const CODEX_PERSON = { "people/minh/person.yaml": person("minh", { harnesses: ["composer", "codex"] }) }

const ajv = new Ajv({ strict: false, validateFormats: false })
const CLIENT = ajv.compile(
  JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../fixtures/codex/schema/ClientRequest.json"), "utf8")),
)
const FAKE = fileURLToPath(new URL("../../src/testing/fake_codex.ts", import.meta.url))

/** A JSON object from the fake's log: `any`, since the assertions read whatever was written. */
type Entry = Record<string, any>

/** The fake app-server's script and log for one test; the script is read when an app-server starts. */
export class FakeCodex {
  readonly path: string
  readonly log: string

  constructor(root: string) {
    fs.mkdirSync(root)
    this.path = path.join(root, "script.json")
    this.log = path.join(root, "rpc.jsonl")
    this.script()
  }

  /** Writes the script: thread `thr_1` on `gpt-5.5-codex`, `turns`, and `extra`'s keys. */
  script(turns: unknown[] = [], extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(this.path, JSON.stringify({ thread: { id: "thr_1", model: "gpt-5.5-codex" }, turns, ...extra }))
  }

  /** The command that runs the fake on this script and log. */
  command(): string[] {
    const bun = ["--no-install", "--no-env-file", "--config=/dev/null"]
    return [process.execPath, ...bun, FAKE, "--script", this.path, "--log", this.log]
  }

  /** The log's entries in direction `dir` (`in`, `out` or `spawn`). */
  entries(dir: string): Entry[] {
    const lines = fs.existsSync(this.log) ? fs.readFileSync(this.log, "utf8").split("\n").filter(Boolean) : []
    return lines.map((line) => JSON.parse(line)).filter((e) => e.dir === dir)
  }

  /** The messages read (`in`) or written (`out`). */
  messages(dir = "in"): Entry[] {
    return this.entries(dir).map((e) => e.msg)
  }

  /** The params of each request the office sent with `method`. */
  calls(method: string): unknown[] {
    return this.messages()
      .filter((m) => m.method === method)
      .map((m) => m.params)
  }

  /** The office's replies to the fake's requests: `{request id: result or error}`. */
  replies(): Record<string, unknown> {
    const replies: Record<string, unknown> = {}
    for (const m of this.messages()) if (!("method" in m)) replies[m.id] = "result" in m ? m.result : m.error
    return replies
  }

  /** The pids of the children the fake started (`{"spawn": seconds}` steps). */
  spawned(): number[] {
    return this.entries("spawn").map((e) => e.pid)
  }
}

/** Checks every request the office sent against the pinned `ClientRequest.json`; throws on the first that fails. */
export function requestsValid(fake: FakeCodex): void {
  for (const m of fake.messages())
    if ("method" in m && "id" in m && !CLIENT(m)) throw new Error(ajv.errorsText(CLIENT.errors))
}

/** A process the tests started, and its start time. */
type Spawned = { pid: number; started: number | null }

// Every app-server any test of this file recorded, for allGone.
const spawned: Spawned[] = []

/** Waits until every app-server the file's tests recorded is gone (10 s each); each test file's `afterAll`. */
export async function allGone(): Promise<void> {
  for (const { pid, started } of spawned)
    await waitFor(() => isGone(pid, started), { timeout: 10_000, what: `process ${pid} to go` })
}

/** Watches what `store` records: when the test finishes, each recorded group whose leader still has its start time
 *  is killed (by pid and start time, never by name). */
function tracked(store: Store): void {
  const spy = spyOn(store, "recordWorker")
  onTestFinished(() => {
    for (const [, { pid, startTime: started }] of spy.mock.calls) {
      spawned.push({ pid, started })
      if (started && sameProcess(pid, started)) killGroup(pid)
    }
  })
}

/** An office whose minh may use Codex (plus `files`), and its `CodexSessions` running `fake` with a fixed
 *  environment; `options` replace the sessions' others. `lines` gets the sessions' and hooks' log lines, `events`
 *  every live event the bus got, `storeEvents` every event the store delivered. Call inside a test: when it finishes
 *  the office stops (closing the sessions before the store closes), then every app-server it recorded that is still
 *  running is killed. */
export function makeCodex({ files = {}, ...options }: { files?: Record<string, unknown> } & CodexSessionsOptions = {}) {
  const office = makeOffice({ files: { ...CODEX_PERSON, ...files } })
  const store = office.store
  // After makeOffice, so its stop runs first: onTestFinished runs callbacks in registration order.
  tracked(store)
  const storeEvents = recordEvents(store)
  const events: LiveEvent[] = []
  const publish = office.bus.publishLive.bind(office.bus)
  spyOn(office.bus, "publishLive").mockImplementation((event) => {
    events.push(event)
    publish(event)
  })
  const lines: string[] = []
  const log = (line: string) => lines.push(line)
  const home = tempDir()
  const fake = new FakeCodex(path.join(home, "fake-codex"))
  const hooks = new Hooks({ log })
  const sessions = new CodexSessions(office, hooks, {
    command: () => fake.command(),
    env: () => ({ PATH: "/usr/bin:/bin", HOME: home }),
    closeGraceMs: 500,
    log,
    ...options,
  })
  office.onStop.push(() => sessions.closeAll())
  return { office, store, hooks, sessions, fake, workspace: tempDir(), lines, events, storeEvents }
}

/** What `makeCodex` returns. */
export type Codex = ReturnType<typeof makeCodex>

/** Stores `handle`'s Codex session in `cwd` (starting, with its work item in progress, at the company's head) and
 *  starts it, as the chat harness's `startSession` does; returns the stored row. `openedBy` null makes the sessions
 *  look the opener up. */
export async function startSession(
  h: Codex,
  handle: string,
  cwd: string,
  { openedBy = null }: { openedBy?: string | null } = {},
): Promise<SessionRecord> {
  const head = await h.office.git.head()
  const item = h.store.createWorkItem(workItem({ status: "in_progress", requester: openedBy ?? CEO, assignee: handle }))
  const row = h.store.createSession(
    session({
      person: handle,
      harness: "codex",
      cwd: fs.realpathSync(cwd),
      repo_commit: head,
      status: "starting",
      kind: "main",
      work_item_id: item.id,
      opened_by: openedBy,
      connection: "office",
    }),
  )
  await h.sessions.start(row)
  return row
}

/** Starts minh's Codex session in `workspace` as `by`, waits for its load, and returns its id. */
export async function start(h: Codex, workspace: string, by = "ngocbh"): Promise<string> {
  const { id } = await startSession(h, "minh", workspace, { openedBy: by })
  await waitFor(() => status(h, id) === "idle", { what: "the Codex session to load" })
  return id
}

/** The session's stored status. */
export function status(h: Codex, sid: string): SessionRecord["status"] | undefined {
  return h.store.getSession(sid)?.status
}

/** The messages `events` build, in order: a `part.updated` replaces the part with its id or adds it, and a
 *  `part.delta` appends to its part's text. */
export function fold(events: readonly LiveEvent[]): Message[] {
  const messages = new Map<string, Message>()
  for (const { type, data } of events) {
    if (type === "message.updated") {
      const message = structuredClone(data) as Message
      messages.set(message.id, message)
      continue
    }
    const message = messages.get(data.message_id as string)
    if (message === undefined) continue
    if (type === "part.updated") {
      const part = structuredClone(data.part) as Part
      const at = message.parts.findIndex((p) => p.id === part.id)
      if (at === -1) message.parts.push(part)
      else message.parts[at] = part
    } else {
      const part = message.parts.find((p) => p.id === data.part_id)
      if (part?.type === "text") part.text += data.text as string
    }
  }
  return [...messages.values()]
}

/** The session's messages, from the live events. */
export function messages(h: Codex, sid: string): Message[] {
  return fold(h.events.filter((e) => e.session_id === sid))
}

/** The text parts of the session's messages with `role`, in order. */
export function texts(h: Codex, sid: string, role = "assistant"): string[] {
  return messages(h, sid)
    .filter((m) => m.role === role)
    .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
}

/** The error parts' messages of the session, in order. */
export function errors(h: Codex, sid: string): string[] {
  return messages(h, sid).flatMap((m) => m.parts.flatMap((p) => (p.type === "error" ? [p.message] : [])))
}

/** The `part.delta` texts the bus got, in order. */
export function deltas(h: Codex): string[] {
  return h.events.filter((e) => e.type === "part.delta").map((e) => e.data.text as string)
}

/** Everything the office keeps or sent of a session, as text: its row, every live event, and every store event's
 *  data. */
export function stored(h: Codex, sid: string): string {
  return [
    JSON.stringify(h.store.getSession(sid)),
    ...h.events.map((e) => JSON.stringify(e)),
    ...h.storeEvents.map((e) => JSON.stringify(e.data)),
  ].join("\n")
}

/** The session's codex.log: its app-servers' stderr. */
export function codexLog(h: Codex, sid: string): string {
  return fs.readFileSync(path.join(h.office.paths.runDir(sid), "codex.log"), "utf8")
}

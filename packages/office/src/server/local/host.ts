/** The no-office host: one session of a built-in agent, served as the office serves its sessions, with no office
 *  running. Its flow runs in a kept `opencorp __worker`, as an office chat's does (only the worker hosts yian runs);
 *  its held calls wait on cards for the owner, in the four modes; Auto's check is a worker job of its own; and the
 *  session's shells are its live instruments. Everything lives in memory, with the session's files in its folder. */
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { type FileLock, FileLockError, lockFile } from "@ngocbh/yian/platform"
import { pending } from "@ngocbh/yian/tools"
import {
  type Event,
  type Message,
  type Person,
  Person as PersonSchema,
  Question,
  type RemoveRuleRequest,
  type RuleList,
  Session,
  now,
  validationMessage,
} from "@opencorp/protocol"
import { MAIN_CHAT } from "../../company/chat_flow.ts"
import { LiveRelay } from "../../features/chat/live.ts"
import { Transcript, userMessage } from "../../features/chat/transcript.ts"
import { Bus } from "../../runtime/bus.ts"
import { Check, type CheckRecord, type CheckWorkers, inWorker } from "../../runtime/permissions/classifier.ts"
import {
  type ApprovalCard,
  decide,
  dontAskRefusal,
  type Mode,
  type Permissions,
  RuleBook,
  type Where,
} from "../../runtime/permissions/policy.ts"
import { approvalResult, holdApproval, readAnswer, YES } from "../../runtime/questions/approval.ts"
import { makeAskUser } from "../../runtime/questions/ask.ts"
import { checkAnswer, InvalidAnswer } from "../../runtime/questions/checker.ts"
import { formatAnswer, INTERRUPTED } from "../../runtime/questions/format.ts"
import type {
  BuiltinSession,
  BuiltinTools,
  CardAct,
  QuestionAct,
  QuestionCard,
  SessionBinding,
} from "../../runtime/sessions/builtin.ts"
import type { AnswerKind } from "../../runtime/sessions/harness.ts"
import { Instruments, type LiveInstrument } from "../../runtime/sessions/instruments.ts"
import { HarnessError } from "../../runtime/sessions/state.ts"
import type { QuestionRecord, SessionRecord } from "../../runtime/store/store.ts"
import type { Frame } from "../../runtime/worker/channel.ts"
import { type Delivery, groupSpecs, type Job, parseJob } from "../../runtime/worker/job.ts"
import {
  type AskRequest,
  BaseHandlers,
  errorName,
  type OfficeTool,
  type WorkerHandlers,
} from "../../runtime/worker/rpc.ts"
import { spawnProcess, Worker, workerEnv } from "../../runtime/worker/spawn.ts"
import { shellInstrument } from "../../tools/terminal/instrument.ts"
import { recoverRecords } from "../../tools/terminal/record.ts"
import type { Terminal } from "../../tools/terminal/terminal.ts"
import type { Env } from "../../util/env.ts"
import { newId } from "../../util/ids.ts"
import { makePrivateFolder, replaceFile } from "../../util/private_files.ts"
import { killGroup } from "../../util/proc.ts"

/** The owner's fixed handle on this host: the session's opener and approver, and who every request acts as. */
export const OWNER = "owner"

/** Where a shell with no sandbox starts, as far as the host knows: nowhere it can name, on the SSH-only profile, which
 *  takes nothing on trust. The terminal says where its shells run. */
const NO_FOLDER: Where = { profile: "ssh", cwd: null, writable: [] }
/** A flow's name: the pin's file name, `<name>.yaml`. */
const FLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** How long, in ms, End waits for the run and its worker to end before it asks the worker's run to stop. */
export const END_STOP_MS = 5_000
/** How long, in ms after End, a worker that hasn't ended is killed: the longest End waits for it. */
export const END_KILL_MS = 8_000
/** How long, in ms, a card's stop waits for the interrupt to close its call. */
const STOP_WAIT_MS = 5_000

/** Resolves once `done()` holds, polling every 20 ms, or after `ms`. */
async function waitUntil(done: () => boolean, ms: number): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20))
}

/** How long, in ms, a worker has to end after it is asked to stop, before its group is killed. */
const STOP_MS = END_KILL_MS - END_STOP_MS

/** What the host is given beside the session. */
export interface LocalHostOptions {
  /** The environment workers start from: `workerEnv` keeps what they may have, the model's env goes on top.
   *  `process.env` by default. */
  readonly environ?: Env
  /** Gets the host's log lines: never a key, the owner's keys or a message's text. */
  readonly log?: (line: string) => void
  /** How long, in ms, Auto's check may take before it asks. */
  readonly checkTimeoutMs?: number
  /** Starts a worker process (`spawnProcess`); tests count them. */
  readonly spawn?: typeof spawnProcess
}

/** The host's workers: the session's kept worker and Auto's checks, each a `Worker` over `spawnProcess`, closed by its
 *  job's session id. The registry's `CheckWorkers` shape, with no store to record them in: a worker whose channel
 *  closes exits, so none outlives the host's process for long. */
class HostWorkers implements CheckWorkers {
  readonly #workers = new Map<string, Worker>()
  #closed = false

  constructor(
    private readonly environ: Env,
    private readonly start: typeof spawnProcess,
    private readonly log: (line: string) => void,
  ) {}

  /** Starts a worker in `dir` running `job` with `handlers`, with the model's `env` on top of the workers' own. Throws
   *  once the host has closed, and when it can't start; nothing is left behind then. */
  async spawn(
    job: Job,
    dir: string,
    handlers: WorkerHandlers<Worker>,
    { env }: { env: Record<string, string> },
  ): Promise<Worker> {
    if (this.#closed) throw new Error("the host has closed; no new workers")
    const { child, channel } = this.start(dir, { ...workerEnv(this.environ), ...env })
    let worker: Worker
    try {
      worker = new Worker(job, child, channel, handlers, (gone) => this.#exited(gone), {
        log: (level, line) => this.log(`${level} ${line}`),
      })
    } catch (error) {
      if (child.pid !== undefined) killGroup(child.pid)
      channel.close()
      throw error
    }
    this.#workers.set(job.session_id, worker)
    try {
      await worker.start()
    } catch (error) {
      await worker.abandon()
      this.#exited(worker)
      throw error
    }
    return worker
  }

  /** Stops the worker of `sessionId`: asks its run to stop, and after `ms` closes its channel and kills its group.
   *  Its return code, or null when it has none. */
  async close(sessionId: string, ms = STOP_MS): Promise<number | null> {
    const worker = this.#workers.get(sessionId)
    if (worker === undefined) return null
    void worker.stop().catch(() => {})
    if ((await worker.wait(ms)) === null) {
      worker.closeChannel()
      worker.kill()
      await worker.wait(ms)
    }
    return worker.returncode
  }

  /** Stops every worker; later spawns are refused. */
  async closeAll(): Promise<void> {
    this.#closed = true
    await Promise.all([...this.#workers.keys()].map((id) => this.close(id)))
  }

  #exited(worker: Worker): void {
    if (this.#workers.get(worker.sessionId) === worker) this.#workers.delete(worker.sessionId)
  }
}

/** One held card: its question as it is now, what its Yes runs (approval cards), whether the session's permissions
 *  held it (`gated`), so a new session rule may decide it again, and, for a feature's question card, what its answer
 *  runs and why it asks. A card a feature holds itself (`hold`, `ask`) is the owner's to answer, always. */
interface Held {
  question: QuestionRecord
  readonly act?: CardAct
  readonly gated: boolean
  readonly answered?: QuestionAct
  readonly reason?: string
}

/** A host's sessions folder is another live host's: only one runs the sessions of a folder at a time. */
export class SessionsBusy extends Error {
  override name = "SessionsBusy"
}

/**
 * One session of a built-in agent, run as the office runs a chat, with no office.
 *
 * **The run.** The flow, written to `<folder>/pin/<name>.yaml`, runs in one kept worker, its log at
 * `<folder>/runs/<run id>/log.jsonl`. Between turns the worker waits, parked. Each message, answer, Esc and End is a
 * delivery: a `deliver` frame while the worker runs a job, else an `advance` job to the parked worker. A result that
 * isn't kept ends the session. There is one run: no restart or resume.
 *
 * **Cards.** A held call (an approval, an `ask_user`, a feature's question card) is a question in memory, published as
 * the store would publish it, and the call waits in yian. The owner's answer makes the call's output, which goes back
 * by `complete`: a Yes runs the card's act, a No is the owner's words and answers the run's other open cards the same
 * way, and "don't ask again" adds session rules and runs the other open cards they now allow. There is no "always":
 * rules last for the session. A feature's question card asks in every mode but `dontAsk`, which refuses it, and its
 * answer, whatever it is, goes to the feature's act.
 *
 * **One host per sessions folder.** The host holds `<sessions>/lock` (the parent of its session's folder) while it
 * runs, so no other host starts on that folder meanwhile and marks this one's live shells interrupted.
 *
 * **Permissions.** The session's mode, starting in `auto`; its rules, the session's own only; where shells run, as the
 * terminal says; Auto's check, a `classify` worker job on the spec's model, each verdict a line of
 * `<folder>/checks/verdicts.jsonl`, unpriced. A switch to `dontAsk` refuses the open cards.
 *
 * **Instruments.** Each terminal shell is listed as it is made; a feature may list its own. The session's end closes
 * the terminal and removes every listing, but never closes a feature's instrument.
 */
export class LocalHost {
  /** The session's id. */
  readonly id = newId()

  /** Why the session failed, as its run or its worker said, once it has; null while it lives, and when it ended as
   *  asked. */
  get failure(): string | null {
    return this.#record.status === "failed" ? (this.#failure ?? "its worker ended before its run did") : null
  }
  /** The session's events: its record, its questions, its messages and its instruments. */
  readonly bus = new Bus()
  /** The session's live instruments, published on the bus. */
  readonly instruments: Instruments
  /** Resolves once the session has ended or failed, its worker gone and its instruments removed. */
  readonly ended: Promise<void>
  /** A stream needs no recheck here: the one token it was opened with counts for the host's life. */
  readonly tokens = { track: (): (() => void) => () => {} }

  readonly #spec: BuiltinSession<Terminal>
  readonly #log: (line: string) => void
  readonly #workers: HostWorkers
  readonly #runId = newId()
  readonly #transcript: Transcript
  readonly #relay: LiveRelay
  readonly #book = new RuleBook()
  readonly #check: Check
  readonly #held = new Map<string, Held>()
  /** Every instrument listed in the session, the host's and the feature's. */
  readonly #listed = new Set<string>()
  /** The tool calls running now, each stopped by its controller: Esc and End stop them. */
  readonly #calls = new Set<AbortController>()
  /** The approved actions running now, by card id. */
  readonly #approved = new Map<string, AbortController>()
  /** What each delivery's reply does, by delivery id. */
  readonly #replies = new Map<string, (frame: Frame) => void>()
  /** Deliveries that wait for the worker to park, for its next `advance` job. */
  readonly #queue: Delivery[] = []
  #record: SessionRecord
  #tools: BuiltinTools<Terminal> = { groups: {} }
  #worker: Worker | null = null
  #handlers: BaseHandlers | null = null
  /** Whether the worker runs a job (until it parks or exits), waits parked, or is gone. */
  #job: "running" | "parked" | "gone" = "gone"
  /** Whether the run has shown its turn once: until then the session is starting. */
  #started = false
  /** How the run ended, from the worker's last result: null while it waits. */
  #outcome: "ended" | "failed" | null = null
  /** Whether the worker's job has sent its result: a delivery answered after it was applied offline. */
  #resulted = false
  /** Whether the run must be moved on once the worker parks, though no delivery waits: a delivery was applied after
   *  the result, or the run waits on a call already settled. */
  #readvance = false
  /** The waits of the worker's last result, and those a plain re-advance started from: one that made no progress
   *  isn't made again. */
  #waits = ""
  #plainFrom: string | null = null
  #ending = false
  #finished = false
  /** The session's end, once it started. */
  #finishing: Promise<void> | null = null
  #endTimer: ReturnType<typeof setTimeout> | undefined
  #resolveEnded!: () => void
  /** The sessions folder's lock, held from the start until the host closes. */
  #lock: FileLock | null = null
  /** Why the session failed, once it has; kept in memory, never logged: it may quote what the model's server said. */
  #failure: string | null = null

  private constructor(spec: BuiltinSession<Terminal>, options: LocalHostOptions) {
    this.#spec = spec
    this.#log = (line) => {
      try {
        options.log?.(line)
      } catch {}
    }
    this.#workers = new HostWorkers(options.environ ?? process.env, options.spawn ?? spawnProcess, this.#log)
    this.instruments = new Instruments((event) => this.bus.publishLive(event))
    this.#transcript = new Transcript(path.join(spec.folder, "runs"), { log: this.#log })
    this.#relay = new LiveRelay({ bus: this.bus, transcript: this.#transcript, log: this.#log })
    this.#check = new Check({
      run: inWorker(this.#workers, async () => spec.model, { logDir: this.#checks }),
      record: async (entry) => this.#recordCheck(entry),
      ...(options.checkTimeoutMs === undefined ? {} : { timeoutMs: options.checkTimeoutMs }),
    })
    this.ended = new Promise((resolve) => (this.#resolveEnded = resolve))
    const at = now()
    this.#record = Session.parse({
      id: this.id,
      person: spec.agent.handle,
      harness: "composer",
      office: "local",
      cwd: spec.folder,
      // A GitId: what runs, as a commit names it in the office.
      repo_commit: createHash("sha256").update(spec.flow.text, "utf8").digest("hex"),
      status: "starting",
      kind: "main",
      run_ids: [this.#runId],
      opened_by: OWNER,
      mode: "auto",
      created_at: at,
      updated_at: at,
    })
  }

  /** Starts `spec`'s session: takes its sessions folder's lock, marks the shells earlier sessions left running as
   *  interrupted, writes the flow's pin, binds the tools, starts the flow in its worker and sends the owner's first
   *  message. Throws, leaving nothing running, when it can't: `SessionsBusy` while another host holds the folder. */
  static async start(spec: BuiltinSession<Terminal>, options: LocalHostOptions = {}): Promise<LocalHost> {
    if (!FLOW_NAME.test(spec.flow.name)) throw new RangeError("a flow's name is letters, digits, _ and -")
    const host = new LocalHost(spec, options)
    try {
      await host.#start()
    } catch (error) {
      await host.close()
      throw error
    }
    return host
  }

  get #checks(): string {
    return path.join(this.#spec.folder, "checks")
  }

  async #start(): Promise<void> {
    const { folder, flow } = this.#spec
    const sessions = path.dirname(folder)
    makePrivateFolder(sessions)
    try {
      this.#lock = lockFile(path.join(sessions, "lock"), { private: true })
    } catch (error) {
      if (!(error instanceof FileLockError && error.reason === "busy")) throw error
      throw new SessionsBusy(`another host is running the sessions in ${sessions}`)
    }
    this.#recover(sessions)
    makePrivateFolder(folder)
    const pin = path.join(folder, "pin")
    makePrivateFolder(pin)
    replaceFile(pin, `${flow.name}.yaml`, flow.text)
    makePrivateFolder(path.join(folder, "runs"))
    this.#tools = await this.#spec.tools(this.#binding())
    this.#handlers = this.#makeHandlers()
    this.#job = "running"
    try {
      this.#worker = await this.#workers.spawn(this.#jobOf("chat", []), folder, this.#handlers, {
        env: { ...this.#spec.model.env },
      })
    } catch (error) {
      this.#job = "gone"
      throw error
    }
    if (this.#spec.first !== undefined) await this.prompt(this.#spec.first, OWNER)
  }

  /** Marks the shells each earlier session in `sessions` left running as interrupted, in its `terminal/` folder. */
  #recover(sessions: string): void {
    let names: fs.Dirent[]
    try {
      names = fs.readdirSync(sessions, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.#log(`shells weren't recovered: ${errorName(error)}`)
      return
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue
      try {
        for (const problem of recoverRecords(path.join(sessions, entry.name, "terminal"))) {
          this.#log(`a terminal record was left as it is: ${problem}`)
        }
      } catch (error) {
        this.#log(`session ${entry.name}'s shells weren't recovered: ${errorName(error)}`)
      }
    }
  }

  /** The run's job: a `chat` that runs the flow afresh, or an `advance` that moves it on with `deliver`. */
  #jobOf(kind: "chat" | "advance", deliver: Delivery[]): Job {
    const spec = this.#spec
    const tools = this.#tools.groups as Record<string, Record<string, OfficeTool>>
    return parseJob({
      kind,
      session_id: this.id,
      run_id: this.#runId,
      person: spec.agent.handle,
      pin: path.join(spec.folder, "pin"),
      flow: `${spec.flow.name}.yaml`,
      log: path.join(spec.folder, "runs", this.#runId, "log.jsonl"),
      inputs: { ...spec.inputs },
      llm_config: { ...spec.model.llm_config },
      groups: groupSpecs(tools),
      deliver,
      keep: true,
    })
  }

  /** What the session's tools are bound to. */
  #binding(): SessionBinding {
    const permissions: Permissions = {
      mode: () => this.#record.mode,
      rules: () => this.#book.list(),
      where: () => ({ ...NO_FOLDER }),
      hold: (card, callId) => this.#hold(card, callId, (signal) => this.#runApproved(card, signal), true),
      check: (input, signal) => this.#check.judge(input, signal),
    }
    return {
      sessionId: this.id,
      permissions,
      hold: (card, callId, act) => this.#hold(card, callId, act, false),
      ask: (card, callId, act) => this.#ask(card, callId, act),
      onShell: (id, name) => {
        const terminal = this.#tools.terminal
        if (terminal !== undefined) {
          const listing = shellInstrument({
            sessionId: this.id,
            id,
            name,
            driver: this.#spec.agent.handle,
            profile: terminal.profile,
            interactive: terminal.interactive,
            shell: () => terminal.shell(id),
          })
          this.#list(listing)
        }
        return {
          changed: () => this.instruments.updated(this.id, id),
          output: (chunk) => this.instruments.output(this.id, id, chunk),
        }
      },
      instruments: {
        add: (instrument) => this.#list(instrument),
        updated: (id) => this.instruments.updated(this.id, id),
        output: (id, chunk) => this.instruments.output(this.id, id, chunk),
        remove: (id) => {
          this.#listed.delete(id)
          this.instruments.remove(this.id, id)
        },
      },
    }
  }

  /** Lists `instrument` in the session, until its end. */
  #list(instrument: LiveInstrument): void {
    if (this.#finished) return
    this.instruments.add(this.id, instrument)
    this.#listed.add(instrument.id)
  }

  /** The approved run of a terminal call held on `card`. */
  #runApproved(card: ApprovalCard, signal: AbortSignal): Promise<string> {
    const terminal = this.#tools.terminal
    if (terminal === undefined) return Promise.reject(new RangeError("this session has no terminal"))
    return terminal.runApproved(card.tool, { ...card.args }, signal)
  }

  // --- what the routes call ------------------------------------------------------------

  /** Session `id` (the host's own by default) as it is now; undefined for any other id. */
  session(id: string = this.id): SessionRecord | undefined {
    return id === this.id ? { ...this.#record } : undefined
  }

  /** Who answers for the session: its owner. */
  approver(_session: SessionRecord): string {
    return OWNER
  }

  /** The people this host knows: its built-in agent. */
  people(): Person[] {
    const { handle, name } = this.#spec.agent
    return [PersonSchema.parse({ handle, name, kind: "agent", title: "Built-in agent", manager: null })]
  }

  /** The session's transcript, read from its run's log, with the calls in flight. */
  async messages(): Promise<Message[]> {
    await this.#transcript.refresh([this.#runId])
    return this.#transcript.messages(this.id, [this.#runId], this.#relay)
  }

  /** A message from `by`: the next turn, or a steer of the running reply. */
  async prompt(text: string, by: string): Promise<void> {
    this.#live()
    const event = { role: "user", parts: [{ type: "text" as const, text }], author: by }
    await this.#deliver({ id: newId(), op: "send", inbox: MAIN_CHAT.inbox, event }, (frame) => {
      if (typeof frame.seq !== "number") return
      const message = userMessage(this.id, this.#runId, { seq: frame.seq, at: now(), message: event })
      this.bus.publishLive({ type: "message.updated", session_id: this.id, data: message })
    })
  }

  /** Steers the running reply; with none running, it is the next turn. */
  steer(text: string, by: string): Promise<void> {
    return this.prompt(text, by)
  }

  /** Esc: stops the running reply, its calls, Auto's checks in their gates and the approved actions still running;
   *  its held calls close, their cards answered interrupted. The session stays open. */
  async interrupt(): Promise<void> {
    this.#live()
    this.#stopCalls()
    await this.#deliver({ id: newId(), op: "interrupt", inbox: MAIN_CHAT.inbox }, (frame) => {
      if (Array.isArray(frame.closed)) for (const callId of frame.closed) this.#closedCall(String(callId), "interrupted")
    })
  }

  /** End: interrupts a busy reply, closes the inbox, and the run and its worker end. A worker that hasn't ended
   *  `END_STOP_MS` later is asked to stop, and killed at `END_KILL_MS`. Ending a session that is ending or has ended does
   *  nothing. */
  async end(): Promise<void> {
    if (this.#finished || this.#ending) return
    const busy = this.#job === "running" || this.#approved.size > 0 || this.#open().length > 0
    this.#ending = true
    this.#settle()
    this.#stopCalls()
    // A worker that never ends is asked to stop, then killed, so End always ends.
    this.#endTimer = setTimeout(() => void this.#workers.close(this.id, STOP_MS).catch(() => {}), END_STOP_MS)
    this.#endTimer.unref?.()
    if (busy) await this.#deliver({ id: newId(), op: "interrupt", inbox: MAIN_CHAT.inbox })
    await this.#deliver({ id: newId(), op: "close", inbox: MAIN_CHAT.inbox })
  }

  /** Switches the session's mode as `by`, who must be its owner. A switch to `dontAsk` refuses every open card. */
  setMode(mode: Mode, by: string): SessionRecord {
    if (this.#finished) throw new HarnessError(409, "not_live", "this session has ended")
    if (by !== OWNER) throw new HarnessError(403, "forbidden", `only @${OWNER} may switch this session's mode`)
    if (this.#record.mode !== mode) this.#write({ mode })
    if (mode === "dontAsk") {
      const refusal = (card: QuestionRecord) =>
        `this session is now in dontAsk mode, which doesn't ask: ${card.approval?.reason ?? ""}`
      this.#answerOpen(refusal, by, null)
      // A feature's question card is refused as it would have been, had it come now; its act never runs.
      for (const held of this.#open()) {
        if (held.answered === undefined) continue
        const answered = this.#answer(held, "this session is now in dontAsk mode, which doesn't ask", "text", by)
        void this.#complete(answered, dontAskRefusal(held.reason ?? ""))
      }
    }
    return { ...this.#record }
  }

  /** The session's rules: its own, from "don't ask again". */
  rules(): RuleList {
    const rules = this.#book.list().map((rule) => ({ ...rule, source: "session" as const, by: null, at: null, note: null }))
    return { rules, errors: [] }
  }

  /** Removes a session rule as `by`, its owner; there are no others here. */
  removeRule(rule: RemoveRuleRequest, by: string): void {
    if (by !== OWNER) throw new HarnessError(403, "forbidden", `only @${OWNER} may remove this session's rules`)
    if (rule.source === "company") {
      throw new HarnessError(409, "company_rule", "a company rule changes only by editing rules.yaml in the company repo")
    }
    if (rule.source !== "session" || !this.#book.remove(rule)) {
      throw new HarnessError(404, "not_found", "this session has no such rule")
    }
  }

  /** The session's questions, oldest first, optionally of one session and in some statuses. */
  questions({ session, status }: { session?: string; status?: readonly string[] }): QuestionRecord[] {
    return [...this.#held.values()]
      .map((held) => held.question)
      .filter((q) => (session === undefined || q.session_id === session) && (status === undefined || status.includes(q.status)))
      .map((q) => ({ ...q }))
  }

  /** Question `id`, or undefined. */
  question(id: string): QuestionRecord | undefined {
    const found = this.#held.get(id)?.question
    return found && { ...found }
  }

  /** Answers open question `id` as `by` and acts on it: the first answer wins. Only the owner answers the session's
   *  cards. Throws `HarnessError` 404 `not_found`, 403 `forbidden`, 409 `not_open` or 422 `invalid_answer`. */
  answer(id: string, value: unknown, kind: "option" | "text", by: string): QuestionRecord {
    // Once End began, a Yes would run its action only for the end to stop it.
    this.#live()
    const held = this.#held.get(id)
    if (held === undefined) throw new HarnessError(404, "not_found", `no question ${id}`)
    if (by !== OWNER) throw new HarnessError(403, "forbidden", `only @${OWNER} may answer this session's cards`)
    if (held.question.status !== "open") throw new HarnessError(409, "not_open", `question ${id} is not open`)
    let checked: unknown
    try {
      checked = checkAnswer(held.question, value, kind)
    } catch (error) {
      if (error instanceof InvalidAnswer) throw new HarnessError(422, "invalid_answer", error.message)
      throw error
    }
    const answered = this.#answer(held, checked, kind, by)
    this.#acted(answered)
    return { ...answered }
  }

  /** Stops the asker of open question `id` as `by`, who must be the owner: Esc on the chat, which closes its held
   *  calls, so the card is answered interrupted; a card the interrupt left open is answered so as `by`. Throws
   *  `HarnessError` 404 `not_found`, 403 `forbidden`, or 409 `not_open` or `ending`/`not_live`. */
  async stopQuestion(id: string, by: string): Promise<QuestionRecord> {
    const held = this.#held.get(id)
    if (held === undefined) throw new HarnessError(404, "not_found", `no question ${id}`)
    if (by !== OWNER) throw new HarnessError(403, "forbidden", `only @${OWNER} may stop this session's cards`)
    if (held.question.status !== "open") throw new HarnessError(409, "not_open", `question ${id} is not open`)
    await this.interrupt()
    await waitUntil(() => held.question.status !== "open", STOP_WAIT_MS)
    if (held.question.status === "open") this.#answer(held, INTERRUPTED, "interrupted", by)
    return { ...held.question }
  }

  /** Stops the host: ends the session (its worker killed by `END_KILL_MS` if it doesn't end), stops Auto's checks and
   *  ends the bus's streams. Never rejects. */
  async close(): Promise<void> {
    try {
      // A worker that never started has nothing to end.
      if (!this.#finished && this.#job !== "gone") {
        await this.end().catch(() => {})
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([this.ended, new Promise((resolve) => (timer = setTimeout(resolve, END_KILL_MS)))])
        clearTimeout(timer)
      }
      await this.#workers.closeAll()
      await this.#finish("ended")
    } catch (error) {
      this.#log(`the host didn't stop cleanly: ${errorName(error)}`)
    } finally {
      this.bus.close()
      this.#lock?.release()
      this.#lock = null
    }
  }

  // --- the run --------------------------------------------------------------------------

  /** Throws `HarnessError` unless the session takes messages: 409 `ending` while it ends, `not_live` once it has. */
  #live(): void {
    if (this.#finished) throw new HarnessError(409, "not_live", "this session has ended")
    if (this.#ending) throw new HarnessError(409, "ending", "this session is ending")
  }

  /** Sends `delivery` to the worker while it runs a job, else queues it for the parked worker's next `advance`;
   *  `replied` gets its reply. */
  async #deliver(delivery: Delivery, replied?: (frame: Frame) => void): Promise<void> {
    if (replied !== undefined) this.#replies.set(delivery.id, replied)
    const worker = this.#worker
    if (worker !== null && this.#job === "running") {
      try {
        if (await worker.deliver(delivery)) return
      } catch (error) {
        this.#replies.delete(delivery.id)
        throw error
      }
    }
    if (this.#job === "gone") {
      this.#replies.delete(delivery.id)
      return
    }
    this.#queue.push(delivery)
    await this.#flush()
  }

  /** Hands the queued deliveries to the parked worker as its next `advance` job; with none, moves the run on when it
   *  must (`#readvance`). */
  async #flush(): Promise<void> {
    const worker = this.#worker
    if (worker === null || !worker.parked || this.#handlers === null) return
    if (this.#queue.length === 0 && !this.#readvance) return
    const deliver = this.#queue.splice(0)
    this.#plainFrom = deliver.length === 0 ? this.#waits : null
    this.#readvance = false
    this.#resulted = false
    this.#job = "running"
    this.#settle()
    let sent = false
    try {
      sent = await worker.next(this.#jobOf("advance", deliver), this.#handlers)
    } catch (error) {
      this.#log(`session ${this.id}: an advance can't be sent (${errorName(error)})`)
    }
    if (!sent) {
      this.#queue.unshift(...deliver)
      if (deliver.length === 0) this.#readvance = true
      if (worker.parked) this.#job = "parked"
      this.#settle()
    }
  }

  /** The handlers of the session's worker, for every job it runs. */
  #makeHandlers(): BaseHandlers {
    const host = this
    return new (class extends BaseHandlers {
      override event(_worker: unknown, frame: Frame): void {
        const data = (typeof frame.data === "object" && frame.data !== null ? frame.data : {}) as Frame
        if (frame.name === "CallClosed" && typeof data.call_id === "string" && typeof data.reason === "string") {
          host.#closedCall(data.call_id, data.reason)
        }
      }

      override stream(worker: Worker, frame: Frame): void {
        host.#relay.frame(worker, frame.frame)
      }

      override deliverReply(_worker: unknown, frame: Frame): void {
        // Applied after the run call ended, offline: the run takes it only when it is moved on.
        if (host.#resulted && (typeof frame.seq === "number" || Array.isArray(frame.closed))) host.#readvance = true
        const replied = typeof frame.id === "string" ? host.#replies.get(frame.id) : undefined
        if (replied === undefined) return
        host.#replies.delete(frame.id as string)
        try {
          replied(frame)
        } catch (error) {
          host.#log(`session ${host.id}: a delivery's reply wasn't handled (${errorName(error)})`)
        }
      }

      override result(_worker: unknown, frame: Frame): void {
        host.#resulted = true
        if (frame.kept === true) {
          const waits = Array.isArray(frame.waits) ? (frame.waits as Frame[]) : []
          host.#waits = JSON.stringify(waits)
          // A plain re-advance that left the run on the same settled calls made no progress: it waits for the owner.
          if (waits.some((wait) => wait?.settled === true) && host.#plainFrom !== host.#waits) host.#readvance = true
        }
        if (frame.kept !== true && frame.status !== "succeeded") {
          const status = typeof frame.status === "string" ? frame.status : "badly"
          host.#log(`session ${host.id}: its run ended ${status}`)
          const failure = frame.failure as { message?: unknown } | null | undefined
          host.#failure ??= typeof failure?.message === "string" ? failure.message : `its run ended ${status}`
        }
        host.#outcome = frame.kept === true ? null : frame.status === "succeeded" ? "ended" : "failed"
      }

      override error(_worker: unknown, frame: Frame): void {
        const code = typeof frame.code === "string" ? frame.code : "error"
        host.#log(`session ${host.id}: its worker failed (${code})`)
        host.#failure ??= `its worker failed (${code})`
        host.#outcome = "failed"
      }

      override parked(worker: Worker): void {
        host.#relay.detach(worker)
        host.#job = "parked"
        host.#started = true
        host.#settle()
        void host.#flush()
      }

      override exited(worker: Worker, returncode: number | null): void {
        super.exited(worker, returncode)
        host.#relay.detach(worker)
        host.#job = "gone"
        void host.#finish(host.#ending || host.#outcome === "ended" ? "ended" : "failed")
      }

      override askUser(_worker: unknown, request: AskRequest, callId: string): Promise<unknown> {
        if (host.#finished) return Promise.reject(new Error("the session has ended"))
        const ask = makeAskUser(host.#record, host.#runId, (question) => host.#keep(question))
        return ask(request, callId)
      }

      override async toolCall(
        _worker: unknown,
        group: string,
        name: string,
        args: Record<string, unknown>,
        callId?: string,
      ): Promise<unknown> {
        if (host.#finished) throw new Error("the session has ended")
        const named = Object.hasOwn(host.#tools.groups, group) ? host.#tools.groups[group]! : {}
        if (!Object.hasOwn(named, name)) throw new Error(`no tool ${JSON.stringify(name)} in group ${JSON.stringify(group)}`)
        const stop = new AbortController()
        host.#calls.add(stop)
        try {
          return await named[name]!.call(args, { callId, signal: stop.signal })
        } finally {
          host.#calls.delete(stop)
        }
      }
    })()
  }

  /** Stops the tool calls running now, Auto's checks in their gates and the approved actions. */
  #stopCalls(): void {
    this.#tools.terminal?.interruptWaits()
    for (const stop of this.#calls) stop.abort()
    for (const stop of this.#approved.values()) stop.abort()
  }

  /** Ends the session as `status`: its open cards go stale, its terminal closes, and every listing is removed. The
   *  first call ends it; later ones wait for that. */
  #finish(status: "ended" | "failed"): Promise<void> {
    this.#finishing ??= this.#ended(status)
    return this.#finishing
  }

  async #ended(status: "ended" | "failed"): Promise<void> {
    this.#finished = true
    this.#ending = false
    clearTimeout(this.#endTimer)
    this.#stopCalls()
    this.#queue.length = 0
    this.#replies.clear()
    for (const held of this.#held.values()) if (held.question.status === "open") this.#update(held, { status: "stale" })
    this.#write({ status, waiting_on: [] })
    try {
      await this.#tools.terminal?.close()
    } catch (error) {
      this.#log(`session ${this.id}: its terminal didn't close cleanly (${errorName(error)})`)
    }
    for (const id of [...this.#listed]) this.instruments.remove(this.id, id)
    this.#listed.clear()
    this.#relay.forget([this.#runId])
    this.#resolveEnded()
  }

  // --- cards --------------------------------------------------------------------------

  /** Holds `callId` on approval card `card`, whose Yes runs `act`: `pending()`, or in `dontAsk` the refusal. `gated`
   *  when the session's permissions hold it. */
  #hold(card: ApprovalCard, callId: string, act: CardAct, gated: boolean): unknown {
    if (this.#record.mode === "dontAsk") return dontAskRefusal(card.reason)
    const keep = (question: QuestionRecord) => this.#keep(question, { act, gated })
    return holdApproval(this.#record, this.#runId, keep, { always: false })(card, callId)
  }

  /** Holds `callId` on a feature's question card `card`, whose answer runs `act`: `pending()`, or in `dontAsk` the
   *  refusal. */
  #ask(card: QuestionCard, callId: string, act: QuestionAct): unknown {
    if (this.#record.mode === "dontAsk") return dontAskRefusal(card.reason)
    const at = now()
    const data = {
      id: newId(),
      session_id: this.id,
      run_id: this.#runId,
      node_id: null,
      call_id: callId,
      source: "ask_user",
      asker: this.#record.person,
      work_item_id: this.#record.work_item_id,
      title: card.title,
      question: card.question,
      options: [...card.options],
      status: "open",
      created_at: at,
      updated_at: at,
    }
    const parsed = Question.safeParse(data)
    // Only validationMessage's text leaves: the error's issues can quote the card's values.
    if (!parsed.success) throw new TypeError(validationMessage(Question, parsed.error, data))
    // Never gated: no session rule answers it.
    const kept = this.#keep(parsed.data, { gated: false, answered: act, reason: card.reason })
    if (kept.status === "open") return pending()
    throw new Error(`question ${kept.id} was answered before; its result went with it`)
  }

  /** Keeps `question` and publishes it, unless one is kept for its call: then that one, consumed if answered. */
  #keep(
    question: QuestionRecord,
    how: { act?: CardAct; gated: boolean; answered?: QuestionAct; reason?: string } = { gated: false },
  ): QuestionRecord {
    const kept = [...this.#held.values()].find((held) => held.question.call_id === question.call_id)
    if (kept !== undefined) {
      if (kept.question.status === "answered") this.#update(kept, { status: "consumed" })
      return { ...kept.question }
    }
    const held: Held = { question, ...how }
    this.#held.set(question.id, held)
    this.#publish("question.created", question.id, question)
    this.#settle()
    return { ...question }
  }

  /** The session's open questions, oldest first. */
  #open(): Held[] {
    return [...this.#held.values()].filter((held) => held.question.status === "open")
  }

  /** Stores `value` (of `kind`) as `held`'s answer by `by`. */
  #answer(held: Held, value: unknown, kind: AnswerKind, by: string | null): QuestionRecord {
    return this.#update(held, { status: "answered", answer: value, answer_kind: kind, answered_by: by })
  }

  /** Acts on answered `question`. An approval card's Yes runs its act; "don't ask again" adds its rules first and then
   *  runs the other open cards they allow. A No completes its call with the owner's words, and answers every other open
   *  card the same way. A question's answer completes its call. */
  #acted(question: QuestionRecord): void {
    const answered = this.#held.get(question.id)?.answered
    if (answered !== undefined) {
      const answer = { value: String(question.answer), typed: question.answer_kind === "text" }
      this.#run(question, (signal) => answered(answer, signal))
      return
    }
    if (question.source !== "approval") {
      void this.#complete(question, formatAnswer(question))
      return
    }
    const read = readAnswer(question)
    if (read.answer === "yes" || read.answer === "session" || read.answer === "always") {
      const added = this.#remember(question)
      this.#approve(question)
      if (added) this.#recheck(question.answered_by)
      return
    }
    void this.#complete(question, approvalResult(question))
    if (read.answer === "no") this.#answerOpen(() => question.answer, question.answered_by, question.answer_kind)
  }

  /** Adds the rules an answered card's "don't ask again" chose to the session's own; whether it added any. */
  #remember(question: QuestionRecord): boolean {
    const card = question.approval
    if (card === null || readAnswer(question).answer !== "session" || card.rules.length === 0) return false
    for (const pattern of card.rules) this.#book.add({ effect: "allow", kind: card.kind, pattern })
    return true
  }

  /** Runs approved card `question`'s act while the session reads busy; its output (or `error: <its type>`)
   *  completes the call. Esc and End stop it. */
  #approve(question: QuestionRecord): void {
    this.#run(question, this.#held.get(question.id)?.act)
  }

  /** Runs `act` for answered card `question` while the session reads busy; its output (or `error: <its type>`)
   *  completes the call. Esc and End stop it. */
  #run(question: QuestionRecord, act: CardAct | undefined): void {
    const stop = new AbortController()
    this.#approved.set(question.id, stop)
    this.#settle()
    const ran = act === undefined ? Promise.reject(new RangeError("this card runs nothing")) : act(stop.signal)
    void ran
      .then(
        (output) => output,
        (error: unknown) => `error: ${errorName(error)}`,
      )
      .then(async (output) => {
        this.#approved.delete(question.id)
        await this.#complete(question, output)
        this.#settle()
      })
  }

  /** After "don't ask again" added rules: each open card the session's permissions held that its mode and rules now
   *  allow is answered Yes as `by` and its act run; the others, and every card a feature held, stay open. */
  #recheck(by: string | null): void {
    for (const held of this.#open()) {
      const card = held.question.approval
      if (card === null || held.question.source !== "approval" || !held.gated) continue
      const into = card.into === null ? {} : { into: card.into }
      const action = { kind: card.kind, text: card.action, partial: card.partial, ...into }
      const shell = typeof card.args.shell === "string" ? card.args.shell : undefined
      const where = this.#tools.terminal?.where(shell) ?? NO_FOLDER
      if (decide(action, this.#record.mode, this.#book.list(), where).verdict !== "allow") continue
      this.#approve(this.#answer(held, YES, "option", by))
    }
  }

  /** Answers every open approval card with `value(card)` as `by` (as text, unless `kind` says), and completes each
   *  call with what it says. Nothing runs. */
  #answerOpen(value: (card: QuestionRecord) => unknown, by: string | null, kind: AnswerKind | null): void {
    for (const held of this.#open()) {
      if (held.question.source !== "approval") continue
      const answered = this.#answer(held, value(held.question), kind ?? "text", by)
      void this.#complete(answered, approvalResult(answered))
    }
  }

  /** Completes `question`'s call with `output`: consumed once the run takes it, stale when it can't. */
  async #complete(question: QuestionRecord, output: unknown): Promise<void> {
    if (this.#finished || question.call_id === null) return
    const delivery: Delivery = { id: newId(), op: "complete", call_id: question.call_id, result: { output } }
    await this.#deliver(delivery, (frame) => {
      const held = this.#held.get(question.id)
      if (held === undefined || held.question.status !== "answered") return
      this.#update(held, { status: typeof frame.seq === "number" ? "consumed" : "stale" })
    }).catch((error: unknown) => this.#log(`session ${this.id}: an answer can't be sent (${errorName(error)})`))
  }

  /** The call `callId` closed for `reason` before its answer: an interrupted card is answered interrupted and
   *  consumed, any other goes stale. */
  #closedCall(callId: string, reason: string): void {
    const held = [...this.#held.values()].find((h) => h.question.call_id === callId)
    if (held === undefined || held.question.status !== "open") return
    if (reason === "interrupted") {
      this.#answer(held, INTERRUPTED, "interrupted", null)
      this.#update(held, { status: "consumed" })
    } else {
      this.#update(held, { status: "stale" })
    }
  }

  /** `held`'s question with `change`, published. */
  #update(held: Held, change: Partial<QuestionRecord>): QuestionRecord {
    held.question = { ...held.question, ...change, updated_at: now() }
    this.#publish("question.updated", held.question.id, held.question)
    this.#settle()
    return held.question
  }

  // --- the session's record ------------------------------------------------------------

  /** Writes the session's status from its run, its cards and its approved actions. */
  #settle(): void {
    if (this.#finished) return
    const waiting = this.#open().length > 0
    const status: SessionRecord["status"] = this.#ending
      ? "ending"
      : waiting
        ? "waiting"
        : !this.#started
          ? "starting"
          : this.#job === "running" || this.#approved.size > 0
            ? "busy"
            : "idle"
    const waitingOn = status === "waiting" ? [OWNER] : []
    if (status === this.#record.status && waitingOn.length === this.#record.waiting_on.length) return
    this.#write({ status, waiting_on: waitingOn })
  }

  /** The session's record with `change`, published. */
  #write(change: Partial<SessionRecord>): void {
    this.#record = { ...this.#record, ...change, updated_at: now() }
    this.#publish("session.updated", this.id, this.#record)
  }

  #publish(type: Event["type"], subject: string, data: object): void {
    this.bus.publishMeta({ id: newId(), type, at: now(), subject_id: subject, data: { ...data } })
  }

  /** Records one of Auto's checks as a line of `<folder>/checks/verdicts.jsonl`, unpriced. */
  #recordCheck(entry: CheckRecord): void {
    const line = {
      at: now(),
      input: entry.input,
      verdict: entry.verdict,
      reason: entry.reason,
      failed: entry.failed,
      cached: entry.cached,
      run_id: entry.runId,
      model: entry.model,
      usage: entry.usage,
    }
    makePrivateFolder(this.#checks)
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants
    const fd = fs.openSync(path.join(this.#checks, "verdicts.jsonl"), O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
    try {
      fs.writeSync(fd, `${JSON.stringify(line)}\n`)
    } finally {
      fs.closeSync(fd)
    }
  }
}

/** A scripted stand-in for `codex app-server --listen stdio://`, for office tests and the fake-Codex e2e.
 *
 *      bun fake_codex.ts (--script s.json | --scenario e2e) [--log rpc.jsonl] [ignored args]
 *
 *  A script is `{"thread": {"id", "model"}, "account": {...} | null, "initialize_error": {...}, "initialize_delay":
 *  seconds, "interrupt_hangs": bool, "load_exit": code, "resume_error": {...}, "stderr": "...", "turns": [[step, ...],
 *  ...]}`; `load_exit` dies with `code` on `thread/start` or `thread/resume`, before answering. Each `turn/start` that
 *  starts a turn takes the next list of steps (an unscripted turn just completes). The count is kept next to `--log`,
 *  so a restarted fake goes on with the next turn. A step is one of:
 *
 *  - `{"notify": method, "params": {...}}` sends a notification;
 *  - `{"request": method, "params": {...}, "id": n, "wait": bool}` sends a server request, waiting for the reply when
 *    `wait`;
 *  - `{"wait_reply": n}` waits for the reply to request `n`; `{"resolve": n}` sends `serverRequest/resolved`;
 *  - `{"sleep": seconds}`; `{"exit": code}` dies at once; `{"end": "completed" | "failed", "error": {...}}`;
 *  - `{"spawn": seconds}` starts `sleep <seconds>` in the fake's process group, as a command Codex runs would be, and
 *    logs its pid as `{"dir": "spawn", "pid": n}`.
 *
 *  `"{thread}"`, `"{turn}"` and `"{cwd}"` in params are filled in. `turn/start` during a turn is a steer and answers
 *  with the running turn. `turn/interrupt` stops the steps, completes the turn `interrupted`, and then resolves the
 *  requests of the turn still waiting (a request whose `turnId` is null outlives it); with `interrupt_hangs` it gets
 *  no answer and the turn runs on. Every message read or written
 *  is appended to `--log` as `{"dir": "in"|"out", "msg"}`. Stdin EOF exits 0. The builders below make steps whose
 *  messages match the pinned Codex schema. */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

/** A JSON object from a script or the wire: `any`, since its shape is whatever the script or Codex sent. */
type Obj = Record<string, any>

export const THREAD = { id: "thr_fake", model: "gpt-fake-codex" }

/** Python's truth value of a JSON value: an empty object or list is false too. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0
  return Boolean(value)
}

/** `value` with `{thread}`, `{turn}` and `{cwd}` filled in every string. */
export function fill(value: any, turn: string, cwd: string, thread: string = THREAD.id): any {
  // split and join, not replaceAll: a `$` in the replacement must stay literal.
  if (typeof value === "string")
    return value.split("{thread}").join(thread).split("{turn}").join(turn).split("{cwd}").join(cwd)
  if (Array.isArray(value)) return value.map((v) => fill(v, turn, cwd, thread))
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, turn, cwd, thread)]))
  return value
}

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000))

/** One fake app-server process. */
export class Fake {
  readonly thread: Obj
  cwd = "/"
  private readonly replies = new Map<unknown, Obj>()
  private readonly waiting = new Set<unknown>() // requests sent and not resolved yet
  private readonly turnless = new Set<unknown>() // the waiting requests whose turnId is null
  private turn: string | null = null
  private interrupted = false
  private readonly countFile: string | null
  private count = 0
  private dying = false
  private wakers: (() => void)[] = []

  constructor(
    readonly script: Obj,
    readonly log: string | null,
  ) {
    this.thread = { ...(truthy(script.thread) ? script.thread : THREAD) }
    this.countFile = log ? log.slice(0, log.length - path.extname(log).length) + ".turns" : null
  }

  private writeLog(entry: Obj): void {
    if (this.log && !this.dying) fs.appendFileSync(this.log, JSON.stringify(entry) + "\n")
  }

  send(msg: Obj): void {
    if (this.dying) return
    this.writeLog({ dir: "out", msg })
    process.stdout.write(JSON.stringify(msg) + "\n")
  }

  reply(requestId: unknown, result?: Obj, error?: Obj): void {
    this.send(truthy(error) ? { id: requestId, error } : { id: requestId, result: result || {} })
  }

  /** Stops everything at once and exits with `code` once what was already written reaches stdout. */
  private die(code: number): void {
    this.dying = true
    process.stdout.write("", () => process.exit(code))
  }

  /** Wakes every wait, to look again at what it waits for. */
  private changed(): void {
    const wakers = this.wakers
    this.wakers = []
    for (const wake of wakers) wake()
  }

  /** Resolves once `done()` holds, the fake is dying, or `seconds` pass. */
  private async waitFor(done: () => boolean, seconds = Infinity): Promise<void> {
    const deadline = performance.now() + seconds * 1000
    while (!done() && !this.dying) {
      const left = deadline - performance.now()
      if (left <= 0) return
      await new Promise<void>((resolve) => {
        const timer = left === Infinity ? undefined : setTimeout(resolve, left)
        this.wakers.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  async serve(): Promise<number> {
    if (this.script.stderr) process.stderr.write(`${this.script.stderr}\n`)
    // Made before any await, so no line on stdin is missed.
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]()
    for (;;) {
      const next = await lines.next()
      if (next.done) break
      const msg: Obj = JSON.parse(next.value)
      this.writeLog({ dir: "in", msg })
      if (!("method" in msg)) {
        // The office's reply to one of our requests; as Codex does, say the request is resolved before the turn goes
        // on.
        if (this.waiting.has(msg.id)) this.resolve(msg.id)
        this.replies.set(msg.id, msg)
        this.changed()
      } else if ("id" in msg) {
        await this.answer(msg.id, msg.method, truthy(msg.params) ? msg.params : {})
      }
    }
    this.dying = true
    return 0
  }

  async answer(requestId: unknown, method: string, params: Obj): Promise<void> {
    if (this.dying) return
    if (method === "initialize") {
      await sleep(this.script.initialize_delay ?? 0)
      if (truthy(this.script.initialize_error)) return this.reply(requestId, undefined, this.script.initialize_error)
      return this.reply(requestId, { userAgent: "fake-codex/0.0.0" })
    }
    if (method === "account/read")
      return this.reply(requestId, {
        account: "account" in this.script ? this.script.account : { type: "chatgpt" },
        requiresOpenaiAuth: true,
      })
    if (method === "thread/start" || method === "thread/resume") {
      if ("load_exit" in this.script) return this.die(this.script.load_exit)
      if (method === "thread/resume") {
        if (truthy(this.script.resume_error)) return this.reply(requestId, undefined, this.script.resume_error)
        this.thread.id = params.threadId
      }
      this.cwd = params.cwd || this.cwd
      return this.reply(requestId, {
        thread: { id: this.thread.id, turns: [] },
        model: this.thread.model ?? null,
        modelProvider: "openai",
        cwd: this.cwd,
        approvalPolicy: params.approvalPolicy ?? null,
        approvalsReviewer: "approvalsReviewer" in params ? params.approvalsReviewer : "user",
        sandbox: { type: "readOnly" },
      })
    }
    if (method === "turn/start") return this.turnStart(requestId)
    if (method === "turn/interrupt") {
      if (this.script.interrupt_hangs) return // a Codex stuck on the interrupt: no answer, the turn runs on
      if (this.turn === null || params.turnId !== this.turn)
        return this.reply(requestId, undefined, { code: -32600, message: "no active turn to interrupt" })
      // Codex answers the interrupt before the turn's turn/completed.
      this.reply(requestId, {})
      this.interrupted = true
      this.changed()
      return
    }
    if (method === "fake/wait") {
      await sleep(params.seconds ?? 0)
      return this.reply(requestId, {})
    }
    this.reply(requestId, undefined, { code: -32601, message: `fake codex doesn't serve ${method}` })
  }

  nextSteps(): Obj[] {
    if (this.countFile && fs.existsSync(this.countFile))
      this.count = Number.parseInt(fs.readFileSync(this.countFile, "utf8"), 10)
    const turns: Obj[][] = this.script.turns ?? []
    const steps = this.count < turns.length ? turns[this.count]! : []
    this.count += 1
    if (this.countFile) fs.writeFileSync(this.countFile, String(this.count))
    return steps
  }

  turnStart(requestId: unknown): void {
    if (this.turn !== null) // Codex steers the running turn
      return this.reply(requestId, { turn: { id: this.turn, items: [], status: "inProgress" } })
    const steps = this.nextSteps()
    const turn = (this.turn = `turn_${this.count}`)
    this.interrupted = false
    const started = { id: turn, items: [], status: "inProgress" }
    this.reply(requestId, { turn: started })
    this.send({ method: "turn/started", params: { threadId: this.thread.id, turn: started } })
    void this.run(turn, steps)
  }

  async run(turn: string, steps: Obj[]): Promise<void> {
    let status = "completed"
    let error: unknown = null
    for (const step of steps) {
      if (this.interrupted || this.dying) break
      const params = fill("params" in step ? step.params : {}, turn, this.cwd, this.thread.id)
      if ("notify" in step) this.send({ method: step.notify, params })
      else if ("request" in step) {
        this.waiting.add(step.id)
        if (params.turnId === null) this.turnless.add(step.id)
        this.send({ id: step.id, method: step.request, params })
        if (step.wait) await this.waitReply(step.id)
      } else if ("wait_reply" in step) await this.waitReply(step.wait_reply)
      else if ("resolve" in step) this.resolve(step.resolve)
      else if ("sleep" in step) await this.waitFor(() => this.interrupted, step.sleep)
      else if ("spawn" in step) {
        // Codex gives a command its own pipes, so it never holds the app-server's stdout open.
        const child = spawn("sleep", [String(step.spawn)], { stdio: "ignore" })
        // Without a listener a failed spawn would crash the whole fake; Python lost only the turn thread.
        child.on("error", () => {})
        child.unref()
        this.writeLog({ dir: "spawn", pid: child.pid })
      } else if ("exit" in step) return this.die(step.exit)
      else if ("end" in step) {
        status = step.end
        error = step.error ?? null
        break
      }
    }
    if (this.dying) return
    // As Codex does: turn/completed first, then serverRequest/resolved for what an interrupt left waiting. All of it
    // is sent with no await in between, so a turn/start that comes as the turn ends never sends the next turn/started
    // ahead of it.
    const waiting = this.interrupted ? [...this.waiting].filter((id) => !this.turnless.has(id)) : []
    if (this.interrupted) status = "interrupted"
    this.send({
      method: "turn/completed",
      params: { threadId: this.thread.id, turn: { id: turn, items: [], status, error } },
    })
    this.turn = null
    this.changed()
    for (const requestId of waiting) this.resolve(requestId)
  }

  waitReply(requestId: unknown): Promise<void> {
    return this.waitFor(() => this.replies.has(requestId) || this.interrupted)
  }

  resolve(requestId: unknown): void {
    this.waiting.delete(requestId)
    this.turnless.delete(requestId)
    this.send({ method: "serverRequest/resolved", params: { threadId: this.thread.id, requestId } })
  }
}

// --- step builders: messages shaped as the pinned schema says --------------------------------

function itemNote(event: string, item: Obj): Obj {
  const at = event === "item/started" ? "startedAtMs" : "completedAtMs"
  return { notify: event, params: { item, threadId: "{thread}", turnId: "{turn}", [at]: 0 } }
}

export function agentMessageDelta(itemId: string, delta: string): Obj {
  return {
    notify: "item/agentMessage/delta",
    params: { threadId: "{thread}", turnId: "{turn}", itemId, delta },
  }
}

/** An agent message streamed in two deltas, then completed. */
export function agentMessage(itemId: string, text: string): Obj[] {
  // Split by code points, as Python's len and slices count.
  const chars = [...text]
  const half = Math.floor(chars.length / 2)
  const item = { type: "agentMessage", id: itemId, text }
  return [
    itemNote("item/started", { ...item, text: "" }),
    agentMessageDelta(itemId, chars.slice(0, half).join("")),
    agentMessageDelta(itemId, chars.slice(half).join("")),
    itemNote("item/completed", item),
  ]
}

export function command(
  itemId: string,
  cmd: string,
  {
    status = "completed",
    exitCode = 0,
    output = "",
  }: { status?: string; exitCode?: number | null; output?: string | null } = {},
): Obj[] {
  const base = {
    type: "commandExecution",
    id: itemId,
    command: cmd,
    cwd: "{cwd}",
    processId: null,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  }
  const done = { ...base, status, aggregatedOutput: output, exitCode, durationMs: 5 }
  return [itemNote("item/started", { ...base, status: "inProgress" }), itemNote("item/completed", done)]
}

export function commandStarted(itemId: string, cmd: string): Obj {
  return command(itemId, cmd)[0]!
}

export function commandApproval(requestId: number, itemId: string, cmd: string, { wait = true } = {}): Obj {
  return {
    request: "item/commandExecution/requestApproval",
    id: requestId,
    wait,
    params: {
      threadId: "{thread}",
      turnId: "{turn}",
      itemId,
      startedAtMs: 0,
      command: cmd,
      cwd: "{cwd}",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    },
  }
}

/** A file change. As in Codex, `diff` is the whole content for `add` and `delete`, and a unified diff only for
 *  `update`. */
export function fileChange(
  itemId: string,
  path: string,
  diff: string,
  { kind = "add", status = "completed" } = {},
): Obj[] {
  const change = { path, kind: { type: kind, ...(kind === "update" ? { move_path: null } : {}) }, diff }
  const item = { type: "fileChange", id: itemId, changes: [change] }
  return [itemNote("item/started", { ...item, status: "inProgress" }), itemNote("item/completed", { ...item, status })]
}

export function fileChangeApproval(requestId: number, itemId: string, { wait = true } = {}): Obj {
  return {
    request: "item/fileChange/requestApproval",
    id: requestId,
    wait,
    params: { threadId: "{thread}", turnId: "{turn}", itemId, startedAtMs: 0, reason: null, grantRoot: null },
  }
}

export function permissionsApproval(requestId: number, itemId: string, { wait = true } = {}): Obj {
  return {
    request: "item/permissions/requestApproval",
    id: requestId,
    wait,
    params: {
      threadId: "{thread}",
      turnId: "{turn}",
      itemId,
      startedAtMs: 0,
      cwd: "{cwd}",
      reason: "needs the network",
      permissions: { network: { enabled: true }, fileSystem: null },
    },
  }
}

export function question(
  qid: string,
  header: string,
  text: string,
  { options, other = false, secret = false }: { options?: string[] | null; other?: boolean; secret?: boolean } = {},
): Obj {
  return {
    id: qid,
    header,
    question: text,
    isOther: other,
    isSecret: secret,
    options: options ? options.map((o) => ({ label: o, description: "" })) : null,
  }
}

export function userInput(requestId: number, itemId: string, questions: Obj[], { wait = true } = {}): Obj {
  return {
    request: "item/tool/requestUserInput",
    id: requestId,
    wait,
    params: { threadId: "{thread}", turnId: "{turn}", itemId, questions, isBlocking: true },
  }
}

/** An MCP tool approval in its elicitation form (`_meta.codex_approval_kind`). */
export function mcpApproval(
  requestId: number,
  server: string,
  tool: string,
  { sessionOption = true, wait = true } = {},
): Obj {
  const meta = {
    codex_approval_kind: "mcp_tool_call",
    tool_name: tool,
    ...(sessionOption ? { persist: "session" } : {}),
  }
  return {
    request: "mcpServer/elicitation/request",
    id: requestId,
    wait,
    params: {
      serverName: server,
      threadId: "{thread}",
      turnId: "{turn}",
      mode: "form",
      _meta: meta,
      message: `Allow ${server} to run ${tool}?`,
      requestedSchema: { type: "object", properties: {} },
    },
  }
}

/** An MCP tool approval in its requestUserInput form. */
export function mcpApprovalQuestion(
  requestId: number,
  itemId: string,
  server: string,
  tool: string,
  { wait = true } = {},
): Obj {
  const q = question("mcp_tool_call_approval_1", "Approve app tool call?", `Allow ${server} to run ${tool}?`, {
    options: ["Allow", "Allow for this session", "Allow and don't ask me again", "Cancel"],
  })
  return userInput(requestId, itemId, [q], { wait })
}

/** A managed-network approval: a command approval with no command or cwd, only the host. */
export function networkApproval(
  requestId: number,
  itemId: string,
  host: string,
  { protocol = "https", wait = true } = {},
): Obj {
  const step = commandApproval(requestId, itemId, "", { wait })
  Object.assign(step.params, { command: null, cwd: null, networkApprovalContext: { host, protocol } })
  return step
}

/** An MCP server's URL elicitation, with no turn (`turnId` is nullable). */
export function urlElicitation(
  requestId: number,
  server: string,
  message: string,
  url: string,
  { wait = true } = {},
): Obj {
  return {
    request: "mcpServer/elicitation/request",
    id: requestId,
    wait,
    params: {
      serverName: server,
      threadId: "{thread}",
      turnId: null,
      mode: "url",
      elicitationId: `e${requestId}`,
      message,
      url,
    },
  }
}

/** An MCP server's form elicitation; `properties` is its requested schema's. */
export function formElicitation(
  requestId: number,
  server: string,
  message: string,
  properties: Obj,
  { wait = true } = {},
): Obj {
  return {
    request: "mcpServer/elicitation/request",
    id: requestId,
    wait,
    params: {
      serverName: server,
      threadId: "{thread}",
      turnId: "{turn}",
      mode: "form",
      message,
      requestedSchema: { type: "object", properties },
    },
  }
}

export function tokenUsage(inputTokens: number, cached: number, output: number): Obj {
  const total = {
    totalTokens: inputTokens + output,
    inputTokens,
    cachedInputTokens: cached,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
  }
  return {
    notify: "thread/tokenUsage/updated",
    params: {
      threadId: "{thread}",
      turnId: "{turn}",
      tokenUsage: { total, last: total, modelContextWindow: null },
    },
  }
}

export function error(message: string, { willRetry }: { willRetry: boolean }): Obj {
  return {
    notify: "error",
    params: { threadId: "{thread}", turnId: "{turn}", willRetry, error: { message, codexErrorInfo: null } },
  }
}

export function threadClosed(): Obj {
  return { notify: "thread/closed", params: { threadId: "{thread}" } }
}

/** The tmux e2e's script: two cards at once, a secret question, a long command to interrupt, a crash, then quiet
 *  turns (restarts and continuing go on from the turn count). */
export function e2e(): Obj {
  const quiet = Array.from({ length: 7 }, (_, i) => agentMessage(`q${i + 5}`, `Quiet turn ${i + 5}.`))
  return {
    thread: { id: "thr_e2e", model: "gpt-fake-codex" },
    turns: [
      [
        ...agentMessage("m1", "I'll create hello.txt."),
        commandStarted("c1", "touch hello.txt"),
        commandApproval(1, "c1", "touch hello.txt", { wait: false }),
        permissionsApproval(2, "p1", { wait: false }),
        { wait_reply: 1 },
        command("c1", "touch hello.txt")[1]!,
        { wait_reply: 2 },
        ...fileChange("f1", "{cwd}/hello.txt", "hello\n"),
        tokenUsage(1200, 800, 90),
        ...agentMessage("m2", "Done."),
      ],
      [
        userInput(3, "u1", [question("token", "Token", "Paste the deploy token", { secret: true })]),
        ...agentMessage("m3", "Thanks, got it."),
      ],
      [commandStarted("c2", "sleep 30"), { sleep: 30 }],
      [...agentMessage("m4", "Working on it…").slice(0, 2), { spawn: 300 }, { exit: 1 }],
      ...quiet,
    ],
  }
}

const USAGE = "usage: fake_codex (--script SCRIPT | --scenario e2e) [--log LOG]"

/** Runs the fake on `argv` (the real command's `app-server --listen stdio://` is ignored); returns its exit code. */
export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--version")) {
    // what `opencorp doctor` asks a codex on the office's PATH
    process.stdout.write("codex-cli 0.0.0-fake\n")
    return 0
  }
  if (argv.includes("login")) return 0 // `codex login status`: the fake is always signed in
  const options: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    if (flag !== "--script" && flag !== "--scenario" && flag !== "--log") continue
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) {
      process.stderr.write(`${USAGE}\nfake_codex: error: argument ${flag}: expected one argument\n`)
      return 2
    }
    options[flag] = value
    i += 1
  }
  const script = options["--script"]
  const scenario = options["--scenario"]
  if ((script === undefined) === (scenario === undefined) || (scenario !== undefined && scenario !== "e2e")) {
    process.stderr.write(`${USAGE}\nfake_codex: error: give one of --script or --scenario e2e\n`)
    return 2
  }
  const loaded = scenario === "e2e" ? e2e() : JSON.parse(fs.readFileSync(script!, "utf8"))
  return new Fake(loaded, options["--log"] ?? null).serve()
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  // The callback runs after every earlier write has reached stdout.
  process.stdout.write("", () => process.exit(code))
}

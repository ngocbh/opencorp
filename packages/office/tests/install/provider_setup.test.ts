/** Setting up the model provider, and the terminal prompter that asks for it. */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "bun:test"
import { type AuthRequest, HttpResponse } from "@ngocbh/yian/llm_clients"
import { loadProvider, Provider } from "../../src/chat/provider.ts"
import {
  azureDeployments,
  ensureProvider,
  type Listers,
  type ProviderOptions,
  providerModels,
  setupConnectionFile,
} from "../../src/install/onboard.ts"
import {
  KeyboardInterrupt,
  NoTerminal,
  OnboardError,
  type Prompter,
  stepLines,
  TRIES,
  TYPE_OWN,
  TtyPrompter,
  readLine,
} from "../../src/install/prompts.ts"
import { repr } from "../../src/perm/redact.ts"

const KEY = "sk-ant-test-0123456789"

const OFFICE = fileURLToPath(new URL("../..", import.meta.url))
const PROMPTS = fileURLToPath(new URL("../../src/install/prompts.ts", import.meta.url))

const DOWN = "\x1b[B"
const ENTER = "\r"
const CTRL_C = "\x03"

/** A writable that keeps what is written; `tty` makes it look like a terminal 80 by 24. */
function collector(tty: boolean): { stream: Writable; text: () => string } {
  let text = ""
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      text += chunk.toString()
      done()
    },
  })
  if (tty) Object.assign(stream, { isTTY: true, columns: 80, rows: 24 })
  return { stream, text: () => text }
}

/** A terminal: keys written to `input` are read as typed, and `drawn()` is everything written to `output`. */
function fakeTerminal(): { input: PassThrough; output: Writable; drawn: () => string } {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
  const { stream, text } = collector(true)
  return { input, output: stream, drawn: text }
}

/** Input `text` read line by line as from a pipe, and an output that isn't a terminal either. */
function pipe(text: string): { input: Readable; output: Writable; printed: () => string } {
  const { stream, text: printed } = collector(false)
  return { input: Readable.from([text]), output: stream, printed }
}

/** Types `keys` once `drawn()` shows `question`, and throws if it never does: keys typed ahead for a prompt that
 *  isn't up yet can be lost. */
async function typeWhenAsked(
  terminal: { input: PassThrough; drawn: () => string },
  question: string,
  keys: string,
): Promise<void> {
  for (let i = 0; i < 400 && !terminal.drawn().includes(question); i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  if (!terminal.drawn().includes(question)) throw new Error(`${question} was never drawn`)
  terminal.input.write(keys)
}

/** What `promise` rejects with. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("it resolved")
}

test("the terminal prompter wont read a key without a terminal", async () => {
  for (const interactive of [true, false]) {
    const { input, output, printed } = pipe(KEY + "\n")
    const error = await rejection(new TtyPrompter({ interactive, input, output, env: {} }).secret("anthropic API key"))
    expect(error).toBeInstanceOf(NoTerminal)
    expect(error.message).not.toContain(KEY)
    expect(printed()).toBe("")
    expect(await readLine(input)).toBe(KEY)
  }
})

test("a secret needs a terminal on stdout too", async () => {
  const { input } = fakeTerminal()
  input.write(KEY + "\n")
  const { output, printed } = pipe("")
  const error = await rejection(new TtyPrompter({ input, output, env: {} }).secret("anthropic API key"))
  expect(error).toBeInstanceOf(NoTerminal)
  expect(error.message).not.toContain(KEY)
  expect(printed()).toBe("")
  expect(await readLine(input)).toBe(KEY)
})

test("the terminal prompter takes presets and defaults", async () => {
  const { input, output } = pipe("")
  const prompter = new TtyPrompter({
    preset: { "Company name": "Acme", "Your name": "" },
    interactive: false,
    input,
    output,
    env: {},
  })
  expect(await prompter.ask("Company name", "My company")).toBe("Acme")
  expect(await prompter.ask("Your name", "Me")).toBe("Me")
})

test("a preset picks from a list without asking", async () => {
  const { input, output, printed } = pipe("")
  expect(await new TtyPrompter({ preset: { Q: "b" }, input, output, env: {} }).choose("Q", ["a", "b"], "a")).toBe("b")
  expect(printed()).toBe("")
})

test.each(["", "b"])("without anyone to ask a list gives its default even on a terminal [%s]", async (answer) => {
  const { input, output, drawn } = fakeTerminal()
  input.write(DOWN + ENTER)
  const prompter = new TtyPrompter({ interactive: false, input, output, env: {} })
  expect(await prompter.choose("Q", ["a", "b"], answer)).toBe(answer)
  expect(drawn()).toBe("")
  expect(String(input.read())).toBe(DOWN + ENTER)
})

test.each([
  ["2", "b"],
  ["b", "b"],
  ["", "a"],
])("without a terminal a list is numbered and takes a number an option or nothing [%s]", async (line, answer) => {
  const { input, output, printed } = pipe(line + "\n")
  expect(await new TtyPrompter({ input, output, env: {} }).choose("Q", ["a", "b"], "a")).toBe(answer)
  expect(printed()).toContain("  1. a\n")
  expect(printed()).toContain("  2. b\n")
})

test("without a terminal an option is taken before a number", async () => {
  const { input, output } = pipe("1\n")
  expect(await new TtyPrompter({ input, output, env: {} }).choose("Q", ["3", "2", "1"])).toBe("1")
})

test("without a terminal nothing with no default is empty", async () => {
  const { input, output } = pipe("\n")
  expect(await new TtyPrompter({ input, output, env: {} }).choose("Q", ["a", "b"])).toBe("")
})

test("without a terminal a bad answer is asked again", async () => {
  const { input, output, printed } = pipe("x\n3\n2\n")
  expect(await new TtyPrompter({ input, output, env: {} }).choose("Q", ["a", "b"])).toBe("b")
  expect(printed().split("That doesn't work: choose 1 to 2").length - 1).toBe(2)
})

test("without a terminal bad answers give up", async () => {
  const { input, output } = pipe("x\n".repeat(TRIES) + "2\n")
  const error = await rejection(new TtyPrompter({ input, output, env: {} }).choose("Q", ["a", "b"]))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("no usable answer to 'Q'")
})

test("without a terminal closed input is an onboard error", async () => {
  const { input, output } = pipe("")
  const error = await rejection(new TtyPrompter({ input, output, env: {} }).choose("Q", ["a", "b"]))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe("no answer to 'Q' (stdin closed)")
})

test("without a terminal a typed list ends with typing your own", async () => {
  const { input, output, printed } = pipe("2\nmy-model\n")
  const prompter = new TtyPrompter({ input, output, env: {} })
  expect(await prompter.choose("Model", ["sonnet (the default)"], "sonnet (the default)", true)).toBe("my-model")
  expect(printed()).toContain(`  2. ${TYPE_OWN}\n`)
})

test("without a terminal a typed list still picks an option", async () => {
  const { input, output } = pipe("1\n")
  const prompter = new TtyPrompter({ input, output, env: {} })
  expect(await prompter.choose("Model", ["sonnet (the default)"], "", true)).toBe("sonnet (the default)")
})

test("a typed default that isnt an option is the typed answers default", async () => {
  const { input, output } = pipe("\n\n")
  const prompter = new TtyPrompter({ input, output, env: {} })
  expect(await prompter.choose("Model", ["sonnet (the default)"], "my-model", true)).toBe("my-model")
})

test("an empty typed answer on the terminal is the default", async () => {
  const { input, output } = pipe("2\n\n")
  const prompter = new TtyPrompter({ input, output, env: {} })
  expect(await prompter.choose("Deployment", ["gpt-5.4"], "gpt-5.4", true)).toBe("gpt-5.4")
})

test("a typed list with no one to ask takes its default", async () => {
  const { input, output } = pipe("")
  const prompter = new TtyPrompter({ interactive: false, input, output, env: {} })
  expect(await prompter.choose("Model", ["a"], "typed-before", true)).toBe("typed-before")
})

test("the terminal prompter shows a step as a header and why", () => {
  const { input, output, printed } = pipe("")
  new TtyPrompter({ input, output, env: {} }).step(2, 5, "You", "You're the CEO.")
  expect(printed()).toBe("\nStep 2 of 5: You\nYou're the CEO.\n")
})

test("on a terminal a step is a bold cyan header and a grey why", () => {
  const { input, output, drawn } = fakeTerminal()
  new TtyPrompter({ input, output, env: { TERM: "xterm-256color" } }).step(2, 5, "You", "You're the CEO.")
  expect(drawn()).toBe("\n\x1b[1;36mStep 2 of 5: You\x1b[0m\n\x1b[90mYou're the CEO.\x1b[0m\n")
})

test.each([
  ["NO_COLOR", "1"],
  ["TERM", "dumb"],
])("without colour a step on a terminal is plain [%s]", (name, value) => {
  const { input, output, drawn } = fakeTerminal()
  const env: Record<string, string | undefined> = { TERM: "xterm-256color", [name]: value }
  const prompter = new TtyPrompter({ input, output, env })
  // The init flow's environment drops it after the prompter is made.
  delete env[name]
  prompter.step(2, 5, "You", "You're the CEO.")
  expect(drawn()).toBe("\nStep 2 of 5: You\nYou're the CEO.\n")
})

test("a dumb terminal gets a numbered list", async () => {
  const { input, output, drawn } = fakeTerminal()
  input.write("2\n")
  expect(await new TtyPrompter({ input, output, env: { TERM: "dumb" } }).choose("Q", ["a", "b"])).toBe("b")
  expect(drawn()).toContain("  2. b")
})

test("an empty no color leaves colour on", () => {
  const { input, output } = fakeTerminal()
  expect(new TtyPrompter({ input, output, env: { TERM: "xterm-256color", NO_COLOR: "" } }).color).toBe(true)
})

test("a list on a terminal is picked with the arrow keys", async () => {
  const { input, output } = fakeTerminal()
  input.write(DOWN + ENTER)
  expect(await new TtyPrompter({ input, output, env: {} }).choose("Q", ["a", "b", "c"])).toBe("b")
})

test("a list on a terminal starts at its default", async () => {
  const { input, output } = fakeTerminal()
  input.write(ENTER)
  expect(await new TtyPrompter({ input, output, env: {} }).choose("Q", ["a", "b", "c"], "c")).toBe("c")
})

test("a default that isnt an option starts the list at the top", async () => {
  const { input, output } = fakeTerminal()
  input.write(ENTER)
  expect(await new TtyPrompter({ input, output, env: {} }).choose("Q", ["a", "b"], "zzz")).toBe("a")
})

test.each([
  ["typed", "Acme" + ENTER, "", "Acme"],
  ["default", ENTER, "Mine", "Mine"],
])("a question on a terminal takes typed text or its default [%s]", async (_case, typed, answer, expected) => {
  const { input, output } = fakeTerminal()
  input.write(typed)
  expect(await new TtyPrompter({ input, output, env: {} }).ask("Q", answer)).toBe(expected)
})

const calls: [string, (p: TtyPrompter) => Promise<string>][] = [
  ["choose", (p) => p.choose("Q", ["a"])],
  ["ask", (p) => p.ask("Q")],
]

test.each(calls)("ctrl c on a terminal is a keyboard interrupt [%s]", async (_case, call) => {
  const { input, output } = fakeTerminal()
  input.write(CTRL_C)
  const error = await rejection(call(new TtyPrompter({ input, output, env: {} })))
  expect(error).toBeInstanceOf(KeyboardInterrupt)
  expect(error).not.toBeInstanceOf(OnboardError)
})

test.each(calls)("closed input on a terminal is an onboard error [%s]", async (_case, call) => {
  const { input, output } = fakeTerminal()
  input.end()
  const error = await rejection(call(new TtyPrompter({ input, output, env: {} })))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe("no answer to 'Q' (stdin closed)")
})

test("on a terminal a secret is read masked by clack", async () => {
  const { input, output, drawn } = fakeTerminal()
  input.write(KEY + ENTER)
  expect(await new TtyPrompter({ input, output, env: {} }).secret("anthropic API key")).toBe(KEY)
  expect(drawn()).toContain("anthropic API key")
  expect(drawn()).not.toContain(KEY)
})

test("a secret on a dumb terminal is still read masked", async () => {
  const { input, output, drawn } = fakeTerminal()
  input.write(KEY + ENTER)
  expect(await new TtyPrompter({ input, output, env: { TERM: "dumb" } }).secret("anthropic API key")).toBe(KEY)
  expect(drawn()).toContain("anthropic API key")
  expect(drawn()).not.toContain(KEY)
})

// Reads in turn on one stream: lines before and after clack prompts each get their own input. A PassThrough isn't
// Bun's tty stream; the next test reads on a real terminal.
test("a clack prompt and a line read share one input", async () => {
  const terminal = fakeTerminal()
  const { input, output } = terminal
  const prompter = new TtyPrompter({ input, output, env: {} })
  input.write("first line\n")
  expect(await readLine(input)).toBe("first line")
  const picked = prompter.choose("Q", ["a", "b"])
  await typeWhenAsked(terminal, "Q", DOWN + ENTER)
  expect(await picked).toBe("b")

  const asked = prompter.ask("Name")
  await typeWhenAsked(terminal, "Name", "Acme" + ENTER)
  expect(await asked).toBe("Acme")
  input.write("last line\n")
  expect(await readLine(input)).toBe("last line")
})

// Bun's tty stream, unlike a PassThrough, once stopped delivering to a line read after a clack prompt had used it.
test("on a real dumb terminal a numbered list after a secret gets its answer", async () => {
  const code = [
    `import { TtyPrompter } from ${JSON.stringify(PROMPTS)}`,
    "const prompter = new TtyPrompter()",
    'const key = await prompter.secret("KEYQ")',
    'const picked = await prompter.choose("LISTQ", ["a", "b"])',
    "console.log(`picked ${picked} after a key of ${key.length}`)",
  ].join("\n")
  let drawn = ""
  const decoder = new TextDecoder()
  const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", "-e", code], {
    cwd: OFFICE,
    env: { PATH: process.env.PATH, TERM: "dumb" },
    terminal: { cols: 80, rows: 24, data: (_terminal, bytes) => (drawn += decoder.decode(bytes, { stream: true })) },
  })
  const typeWhenDrawn = async (shown: string, keys: string) => {
    for (let i = 0; i < 400 && !drawn.includes(shown); i++) await Bun.sleep(25)
    if (!drawn.includes(shown)) throw new Error(`${shown} was never drawn: ${JSON.stringify(drawn)}`)
    child.terminal!.write(keys)
  }
  try {
    await typeWhenDrawn("KEYQ", KEY + ENTER)
    await typeWhenDrawn("LISTQ: ", "2" + ENTER)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), 10_000)))
    const status = await Promise.race([child.exited, timeout])
    clearTimeout(timer)
    expect(status).toBe(0)
    expect(drawn).toContain(`picked b after a key of ${KEY.length}`)
    expect(drawn).not.toContain(KEY)
  } finally {
    child.kill("SIGKILL")
    child.terminal!.close()
  }
}, 30_000)

const SENTINEL = "sk-ant-sentinel-a7d93c10e5b2"

/** A prompter that answers from a list and records everything it was asked or told. */
class Script implements Prompter {
  readonly answers: string[]
  readonly interactive: boolean
  readonly seen: string[] = []
  /** The options of each `choose`, in order. */
  readonly offered: string[][] = []
  /** Whether each `choose` took a typed answer, in order. */
  readonly typed: boolean[] = []

  constructor(answers: string[] = [], { interactive = true }: { interactive?: boolean } = {}) {
    this.answers = [...answers]
    this.interactive = interactive
  }

  private next(): string {
    const answer = this.answers.shift()
    if (answer === undefined) throw new Error("the script ran out of answers")
    return answer
  }

  async ask(question: string, defaultAnswer = ""): Promise<string> {
    this.seen.push(question)
    return this.next() || defaultAnswer
  }

  /** The default for an empty answer, an option given exactly, the option a number picks (from 1), or with
   *  `typed` any other text. */
  async choose(question: string, options: readonly string[], defaultAnswer = "", typed = false): Promise<string> {
    this.seen.push(question)
    this.offered.push([...options])
    this.typed.push(typed)
    const answer = this.next()
    if (!answer) return defaultAnswer
    if (options.includes(answer)) return answer
    const number = /^[0-9]+$/.test(answer) ? Number(answer) : 0
    if (number >= 1 && number <= options.length) return options[number - 1]!
    if (typed) return answer
    throw new Error(`${repr(answer)} isn't an answer to ${repr(question)}; the options are [${options.map(repr).join(", ")}]`)
  }

  async secret(question: string): Promise<string> {
    this.seen.push(question)
    return this.next()
  }

  say(text: string): void {
    this.seen.push(text)
  }

  step(number: number, total: number, title: string, why: string): void {
    this.seen.push(...stepLines(number, total, title, why))
  }
}

/** Listers that list nothing, so no test reaches a provider: the model or deployment is typed. */
const NO_LISTING: Listers = {
  azureDeployments: async () => [],
  providerModels: async () => [],
}

/** `ensureProvider` with `NO_LISTING` unless `options` gives listers. */
function ensure(office: string, prompter: Prompter, options: Partial<ProviderOptions> = {}): Promise<boolean> {
  return ensureProvider(office, prompter, { listers: NO_LISTING, ...options })
}

const offices: string[] = []

afterEach(() => {
  for (const office of offices.splice(0)) rmSync(office, { recursive: true, force: true })
})

/** A fresh office folder, removed after the test. */
function newOffice(): string {
  const office = mkdtempSync(join(tmpdir(), "opencorp-onboard-"))
  offices.push(office)
  return office
}

const file = (office: string): string => setupConnectionFile(office)

/** Writes `text` as the office's setup connection with `mode`, in a 0700 connections folder. */
function place(office: string, text: string, mode = 0o600): void {
  mkdirSync(join(office, "connections"), { mode: 0o700, recursive: true })
  chmodSync(join(office, "connections"), 0o700)
  writeFileSync(file(office), text)
  chmodSync(file(office), mode)
}

const mode = (path: string): number => lstatSync(path).mode & 0o777

const stdin = (value: unknown): Readable => Readable.from([typeof value === "string" ? value : JSON.stringify(value)])

const read = (office: string): unknown => JSON.parse(readFileSync(file(office), "utf8"))

const listing = (office: string): string[] => readdirSync(join(office, "connections")).sort()

const saved = async (office: string) => (await loadProvider(file(office), Provider.parse, { missingOk: false })).llm_config

/** A sender that records each request and answers with the next of `replies`. */
function fakeRequest(replies: HttpResponse[]): AuthRequest & { calls: { method: string; url: string; options: { headers: Record<string, string>; timeoutMs: number } }[] } {
  const calls: { method: string; url: string; options: { headers: Record<string, string>; timeoutMs: number } }[] = []
  const request = async (method: string, url: string, options: { headers: Record<string, string>; timeoutMs: number }) => {
    calls.push({ method, url, options })
    const reply = replies.shift()
    if (reply === undefined) throw new Error("no reply left")
    return reply
  }
  return Object.assign(request, { calls })
}

test("a script is interactive unless told otherwise", () => {
  expect(new Script(["x"]).interactive).toBe(true)
  expect(new Script([], { interactive: false }).interactive).toBe(false)
})

test("a provider on stdin with a key and no model is saved with the default", async () => {
  const office = newOffice()
  const data = { llm_config: { provider: "anthropic", api_key: KEY } }
  expect(await ensure(office, new Script(), { stdin: stdin(data) })).toBe(true)
  expect((read(office) as { llm_config: { model: string } }).llm_config.model).toBe("claude-sonnet-4-5")
})

test("an existing provider with a key and no model gets the default written", async () => {
  const office = newOffice()
  place(office, JSON.stringify({ llm_config: { provider: "openai", api_key: KEY } }))
  expect(await ensure(office, new Script([], { interactive: false }))).toBe(true)
  expect(read(office)).toEqual({ llm_config: { provider: "openai", api_key: KEY, model: "gpt-5.5" } })
  expect(mode(file(office))).toBe(0o600)
  expect(await ensure(office, new Script([], { interactive: false }))).toBe(false)
})

test("azure deployments waits fifteen seconds and says why it cant list them", async () => {
  const request = fakeRequest([
    new HttpResponse(200, { data: [{ id: "gpt-5.4", model: "gpt-5.4", status: "succeeded" }] }),
    new HttpResponse(401, {}),
  ])
  const baseUrl = "https://acme.openai.azure.com/openai/v1/"
  expect(await azureDeployments(baseUrl, KEY, { request })).toEqual(["gpt-5.4"])
  const error = await rejection(azureDeployments(baseUrl, KEY, { request }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/^HTTP 401$/)
  expect(request.calls).toHaveLength(2)
  for (const call of request.calls) {
    expect(call.method).toBe("GET")
    expect(call.url).toBe("https://acme.openai.azure.com/openai/deployments?api-version=2022-12-01")
    expect(call.options.headers["api-key"]).toBe(KEY)
    expect(call.options.timeoutMs).toBe(15_000)
  }
})

test("provider models waits fifteen seconds and says why it cant list them", async () => {
  const request = fakeRequest([
    new HttpResponse(200, { data: [{ id: "claude-sonnet-4-5" }], has_more: false }),
    new HttpResponse(401, {}),
  ])
  expect(await providerModels("anthropic", SENTINEL, { request })).toEqual(["claude-sonnet-4-5"])
  expect(await providerModels("azure", SENTINEL, { request })).toEqual([])
  expect(request.calls).toHaveLength(1)
  const error = await rejection(providerModels("anthropic", SENTINEL, { request }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/^HTTP 401$/)
  expect(request.calls).toHaveLength(2)
  for (const call of request.calls) {
    expect(call.url).toBe("https://api.anthropic.com/v1/models?limit=1000")
    expect(call.options.headers["x-api-key"]).toBe(SENTINEL)
    expect(call.options.timeoutMs).toBeGreaterThan(14_000)
    expect(call.options.timeoutMs).toBeLessThanOrEqual(15_000)
  }
})

test.each(["azure", "google"])("a provider with no model and no default is refused [%s]", async (name) => {
  const office = newOffice()
  const error = await rejection(ensure(office, new Script(), { stdin: stdin({ llm_config: { provider: name, api_key: KEY } }) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain(`llm_config.model is missing, and ${name} has no default model`)
  expect(error.message).not.toContain(KEY)
  expect(existsSync(file(office))).toBe(false)
})

test.each(["google", "ollama"])(
  "a provider with no key and no model takes the model yians login saved [%s]",
  async (name) => {
    const office = newOffice()
    const data = { llm_config: { provider: name } }
    expect(await ensure(office, new Script(), { stdin: stdin(data) })).toBe(true)
    expect(read(office)).toEqual(data)
  },
)

test("an endpoint of ones own with no model is refused", async () => {
  const office = newOffice()
  const llm = { provider: "openai", base_url: "https://gateway.example.com/v1", api_key: KEY }
  let error = await rejection(ensure(office, new Script(), { stdin: stdin({ llm_config: llm }) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/^llm_config\.model is missing, and an endpoint of your own has no default model$/)
  expect(existsSync(file(office))).toBe(false)
  place(office, JSON.stringify({ llm_config: llm }))
  error = await rejection(ensure(office, new Script([], { interactive: false })))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("an endpoint of your own has no default model; fix it or remove it")
})

test("an existing provider that cant be used is an error without a terminal", async () => {
  const office = newOffice()
  const text = JSON.stringify({ llm_config: { provider: "azure", api_key: KEY } })
  place(office, text)
  const error = await rejection(ensure(office, new Script([], { interactive: false })))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("has no default model; fix it or remove it")
  expect(error.message).not.toContain(KEY)
  expect(readFileSync(file(office), "utf8")).toBe(text)
})

test("a misspelled setting is refused without echoing the key", async () => {
  const office = newOffice()
  const data = { llm_config: { provider: "anthropic", api_key: KEY, temprature: 1 } }
  const error = await rejection(ensure(office, new Script(), { stdin: stdin(data) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("an extra field; the fields are provider, model")
  expect(error.message).not.toContain(KEY)
  expect(existsSync(file(office))).toBe(false)
})

test("a key pasted as a field name is not echoed", async () => {
  const office = newOffice()
  const inputs = [
    { llm_config: { provider: "anthropic", [KEY]: 1 } },
    { [KEY]: 1 },
    { llm_config: { model: 1, api_key: KEY } },
    { llm_config: { provider: "openai", api_key: "sk-other-1234567890", headers: { [KEY]: "bad\nvalue" } } },
    { llm_config: { provider: "anthropic", api_key: "sk-other-1234567890", anthropic: { metadata: { [KEY]: 1 } } } },
    // A lone surrogate, as JSON.parse can produce.
    { llm_config: { provider: "openai", model: "\ud800" } },
  ]
  for (const data of inputs) {
    const error = await rejection(ensure(office, new Script(), { stdin: stdin(data) }))
    expect(error).toBeInstanceOf(OnboardError)
    expect(error.message).not.toContain(KEY)
  }
})

test("a key needs a provider", async () => {
  const office = newOffice()
  const error = await rejection(ensure(office, new Script(), { stdin: stdin({ llm_config: { api_key: KEY } }) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("needs llm_config.provider")
  expect(error.message).not.toContain(KEY)
})

test("a base url beside the key is saved", async () => {
  const office = newOffice()
  const llm = { provider: "openai", model: "gpt-5.4", base_url: "https://acme.openai.azure.com/openai/v1/", api_key: KEY }
  expect(await ensure(office, new Script(), { stdin: stdin({ llm_config: llm }) })).toBe(true)
  expect(await saved(office)).toEqual(llm)
  expect(mode(file(office))).toBe(0o600)
})

test.each([
  ["http", { provider: "openai", base_url: "http://gateway.example.com/v1", api_key: KEY }, "must use https"],
  ["no key", { provider: "openai", base_url: "https://gateway.example.com/v1" }, "base_url needs llm_config.api_key"],
  [
    "ollama",
    { provider: "ollama", base_url: "https://gateway.example.com/v1", api_key: KEY, model: "llama3" },
    "ollama does not take llm_config.base_url",
  ],
  [
    "userinfo",
    { provider: "openai", base_url: "https://user:pw-0123456789@gateway.example.com/v1", api_key: KEY },
    "base_url",
  ],
] as const)("a base url composer refuses is refused without echoing it or the key [%s]", async (_case, llm, expected) => {
  const office = newOffice()
  const error = await rejection(ensure(office, new Script(), { stdin: stdin({ llm_config: llm }) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain(expected)
  for (const value of [KEY, "gateway.example.com", "pw-0123456789"]) expect(error.message).not.toContain(value)
  expect(existsSync(file(office))).toBe(false)
})

test("a credential in env is refused without its value", async () => {
  const office = newOffice()
  const error = await rejection(ensure(office, new Script(), { stdin: stdin({ env: { ANTHROPIC_API_KEY: KEY } }) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("ANTHROPIC_API_KEY")
  expect(error.message).not.toContain(KEY)
})

test("stdin that isnt json is refused without echo", async () => {
  const office = newOffice()
  const error = await rejection(ensure(office, new Script(), { stdin: stdin(`{"llm_config": ${KEY}`) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("not valid JSON")
  expect(error.message).not.toContain(KEY)
  // A read error is the stream's own, not bad JSON.
  const failing = new Readable({
    read() {
      this.destroy(Object.assign(new Error("EIO"), { code: "EIO" }))
    },
  })
  const readError = await rejection(ensure(office, new Script(), { stdin: failing }))
  expect(readError).not.toBeInstanceOf(OnboardError)
  expect((readError as NodeJS.ErrnoException).code).toBe("EIO")
})

test("an existing provider is kept and nothing is asked", async () => {
  const office = newOffice()
  place(office, '{"llm_config": {"provider": "openai"}}\n')
  const before = lstatSync(file(office)).mtimeMs
  const ask = new Script()
  expect(await ensure(office, ask)).toBe(false)
  expect(lstatSync(file(office)).mtimeMs).toBe(before)
  expect(ask.seen).toEqual([])
})

test("a provider on stdin replaces an existing one", async () => {
  const office = newOffice()
  const old = "sk-ant-old-key-9f8e7d6c5b4a"
  await ensure(office, new Script(), { stdin: stdin({ llm_config: { provider: "anthropic", api_key: old } }) })
  const ask = new Script()
  expect(await ensure(office, ask, { stdin: stdin({ llm_config: { provider: "anthropic", api_key: KEY } }) })).toBe(true)
  expect((await saved(office))?.api_key).toBe(KEY)
  expect(readFileSync(file(office), "utf8")).not.toContain(old)
  expect(mode(file(office))).toBe(0o600)
  expect(listing(office)).toEqual([".lock", "office.json"])
  expect(ask.seen).toEqual([])
})

test("a bad provider on stdin leaves the existing one", async () => {
  const office = newOffice()
  place(office, '{"llm_config": {"provider": "openai"}}\n')
  const error = await rejection(ensure(office, new Script(), { stdin: stdin("{") }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("not valid JSON")
  expect(readFileSync(file(office), "utf8")).toBe('{"llm_config": {"provider": "openai"}}\n')
})

test("an existing provider others can read is an error and left alone", async () => {
  const office = newOffice()
  place(office, "{}\n", 0o644)
  const error = await rejection(ensure(office, new Script()))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("0600")
  expect(readFileSync(file(office), "utf8")).toBe("{}\n")
  expect(mode(file(office))).toBe(0o644)
})

test("an existing provider composer wont take is an error without the key", async () => {
  const office = newOffice()
  place(office, JSON.stringify({ llm_config: { provider: "anthropic", api_key: KEY, temprature: 1 } }))
  const error = await rejection(ensure(office, new Script([], { interactive: false })))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("an extra field; the fields are provider, model")
  expect(error.message).not.toContain(KEY)
})

test("a symlink where the provider goes is refused", async () => {
  const office = newOffice()
  mkdirSync(join(office, "connections"), { mode: 0o700 })
  chmodSync(join(office, "connections"), 0o700)
  symlinkSync(join(office, "elsewhere"), file(office))
  const error = await rejection(ensure(office, new Script(["openai", "", ""])))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("office.json")
  expect(existsSync(join(office, "elsewhere"))).toBe(false)
})

test("a directory where the provider goes is an onboard error", async () => {
  const office = newOffice()
  mkdirSync(file(office), { recursive: true })
  chmodSync(join(office, "connections"), 0o700)
  let error = await rejection(
    ensure(office, new Script(), { stdin: stdin({ llm_config: { provider: "anthropic", api_key: KEY } }) }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("office.json")
  expect(error.message).not.toContain(KEY)
  expect(listing(office)).toEqual([".lock", "office.json"]) // no temp file left
  error = await rejection(ensure(office, new Script()))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("office.json")
})

test("without a terminal a model that doesnt answer is an error", async () => {
  const office = newOffice()
  const error = await rejection(
    ensure(office, new Script([], { interactive: false }), {
      stdin: stdin({ llm_config: { provider: "openai", api_key: KEY } }),
      checkModel: async () => "Connection error",
    }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/^the model didn't answer: Connection error$/)
  expect(existsSync(file(office))).toBe(false)
})

test("the script prompter takes typed text only for a typed list", async () => {
  const ask = new Script(["my-model"])
  expect(await ask.choose("Model", ["a"], "", true)).toBe("my-model")
  expect(ask.typed).toEqual([true])
  expect((await rejection(new Script(["my-model"]).choose("Model", ["a"]))).message).toContain("'my-model' isn't an answer")
})

test("the script prompter picks by option number or default", async () => {
  const ask = new Script(["", "b", "1", "2"])
  const picked: string[] = []
  for (let i = 0; i < 4; i++) picked.push(await ask.choose("Q", ["a", "b"], "x"))
  expect(picked).toEqual(["x", "b", "a", "b"])
  expect(ask.seen).toEqual(["Q", "Q", "Q", "Q"])
  expect(ask.offered).toEqual([["a", "b"], ["a", "b"], ["a", "b"], ["a", "b"]])
})

test("the script prompter fails on an answer that isnt an option", async () => {
  expect((await rejection(new Script(["c"]).choose("Q", ["a", "b"]))).message).toBe(
    "'c' isn't an answer to 'Q'; the options are ['a', 'b']",
  )
  expect((await rejection(new Script(["3"]).choose("Q", ["a", "b"]))).message).toContain("'3' isn't")
})

test("the script prompter records the same step lines", () => {
  const ask = new Script()
  ask.step(1, 4, "Company", "Why.")
  expect(ask.seen).toEqual(stepLines(1, 4, "Company", "Why."))
  expect(ask.seen).toEqual(["Step 1 of 4: Company", "Why."])
})

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
import { dirname, join } from "node:path"
import { PassThrough, Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "bun:test"
import { AuthError, type AuthRequest, AuthStore, HttpResponse, SUPPORTED_LLM_PROVIDERS } from "@ngocbh/yian/llm_clients"
import { OAuthCredentials } from "@ngocbh/yian/llm_clients"
import { AUTH_FILE_ENV, Connections } from "../../src/chat/connections.ts"
import { loadProvider, Provider, ProviderError } from "../../src/chat/provider.ts"
import {
  API_KEY,
  askDeployment,
  askModel,
  askProviderTo,
  azureDeployments,
  checkProvider,
  ensureProvider,
  HOW_SIGN_IN,
  type Listers,
  pendingSignIn,
  MAX_KEY_CHARS,
  type ModelCheck,
  type ProviderOptions,
  providerModels,
  SET_UP_AGAIN,
  setupConnectionFile,
  signInLine,
  SUBSCRIPTION,
  TRY_AGAIN,
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
import { tempDir, waitFor } from "../helpers.ts"
import {
  ACCESS_TOKEN,
  ACCOUNT,
  DEVICE_CODE,
  DEVICE_URL,
  fakeSubscription,
  NO_LISTING,
  REFRESH_TOKEN,
  Script,
  SUBSCRIPTION_MODELS,
} from "./helpers.ts"

const KEY = "sk-ant-test-0123456789"

const OFFICE = fileURLToPath(new URL("../..", import.meta.url))
const PROMPTS = fileURLToPath(new URL("../../src/install/prompts.ts", import.meta.url))
const ONBOARD = fileURLToPath(new URL("../../src/install/onboard.ts", import.meta.url))

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

test("without a terminal a typed list takes text typed at the list", async () => {
  const { input, output, printed } = pipe("git@github.com:me/acme.git\n")
  const prompter = new TtyPrompter({ input, output, env: {} })
  expect(await prompter.choose("Q", ["None for now"], "None for now", true)).toBe("git@github.com:me/acme.git")
  expect(printed()).toContain(`  2. ${TYPE_OWN}\n`)
  expect(printed()).not.toContain("That doesn't work")
})

test("without a terminal a typed list still refuses a number out of range", async () => {
  const { input, output, printed } = pipe("7\n1\n")
  const prompter = new TtyPrompter({ input, output, env: {} })
  expect(await prompter.choose("Q", ["a"], "", true)).toBe("a")
  expect(printed().split("That doesn't work: choose 1 to 2").length - 1).toBe(1)
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

const TOO_LONG = "llm_config.api_key is too long (at most 16384 characters)"
const NOT_HEADER_TEXT = "llm_config.api_key must be printable ASCII with no leading or trailing spaces"

test.each([
  ["too long", "anthropic", "k".repeat(MAX_KEY_CHARS + 1), TOO_LONG],
  ["a space", "anthropic", " ", NOT_HEADER_TEXT],
  ["a trailing newline", "anthropic", "k\n", NOT_HEADER_TEXT],
  ["a leading tab", "anthropic", "\tsk-abc", NOT_HEADER_TEXT],
  ["a trailing space", "anthropic", "sk-abc ", NOT_HEADER_TEXT],
  ["non-ascii", "anthropic", "sk-é-0123456789", NOT_HEADER_TEXT],
  // An ollama key is never sent, but the rule is the same for every provider.
  ["an ollama dummy", "ollama", " ", NOT_HEADER_TEXT],
] as const)("a key that cant be sent as a header is refused before anything is saved [%s]", async (_case, name, key, message) => {
  const llm = { provider: name, model: "m", api_key: key }
  let error: unknown
  try {
    checkProvider({ llm_config: llm })
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(OnboardError)
  expect((error as Error).message).toBe(message)
  const office = newOffice()
  const refused = await rejection(ensure(office, new Script(), { stdin: stdin({ llm_config: llm }) }))
  expect(refused).toBeInstanceOf(OnboardError)
  expect(refused.message).toContain(message)
  if (key.length > 8) expect(refused.message).not.toContain(key)
  expect(existsSync(file(office))).toBe(false)
})

test("a key of the longest length and inner spaces passes", () => {
  for (const key of ["k".repeat(MAX_KEY_CHARS), "sk abc"]) {
    expect(checkProvider({ llm_config: { provider: "anthropic", model: "m", api_key: key } }).llm_config?.api_key).toBe(key)
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
  chmodSync(file(office), 0o600)
  const connections = join(office, "connections")
  try {
    // Search only: the file is seen, but its folder's lock, removed here, can't be made again.
    rmSync(join(connections, ".lock"), { force: true })
    chmodSync(connections, 0o100)
    const unreadable = await rejection(ensure(office, new Script()))
    expect(unreadable).toBeInstanceOf(OnboardError)
    expect(unreadable.message).toBe(`can't read ${file(office)}: EACCES`)
    // No access: the file can't be seen, so it is asked for, and without a terminal the key can't be.
    chmodSync(connections, 0o000)
    const { input, output } = pipe("")
    const prompter = new TtyPrompter({ interactive: false, input, output, env: {} })
    expect(await rejection(ensure(office, prompter))).toBeInstanceOf(OnboardError)
  } finally {
    chmodSync(connections, 0o700)
  }
  expect(readFileSync(file(office), "utf8")).toBe("{}\n")
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
  const error = await rejection(ensure(office, new Script(["openai", "2", "", ""])))
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

test("a symlinked connections folder is an onboard error and its target keeps its mode", async () => {
  const office = newOffice()
  const target = newOffice()
  chmodSync(target, 0o755)
  symlinkSync(target, join(office, "connections"))
  const error = await rejection(
    ensure(office, new Script(), { stdin: stdin({ llm_config: { provider: "anthropic", api_key: KEY } }) }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error).not.toBeInstanceOf(ProviderError)
  expect(error.message).toContain("connections")
  expect(error.message).not.toContain(KEY)
  expect(mode(target)).toBe(0o755)
  expect(readdirSync(target)).toEqual([])
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

/** `askModel` with `NO_LISTING` unless a test gives listers. */
function askModelWith(prompter: Prompter, name: string, last = "", key = "", listers = NO_LISTING): Promise<string> {
  return askModel(prompter, name, last, key, listers)
}

/** Listers whose deployments are `deployments` and which list no models. */
const deploymentsListed = (deployments: () => Promise<string[]>): Listers => ({ ...NO_LISTING, azureDeployments: deployments })

/** Listers whose models are `models` and which list no deployments. */
const modelsListed = (models: (name: string, key: string, baseUrl?: string) => Promise<string[]>): Listers => ({
  ...NO_LISTING,
  providerModels: models,
})

/** A model check that finds each of `problems` in turn (null: the model answered), recording what it checked. */
function answers(...problems: (string | null)[]): ModelCheck & { checked: unknown[] } {
  const checked: unknown[] = []
  const left = [...problems]
  const check = async (provider: Provider) => {
    checked.push(provider.llm_config)
    const problem = left.shift()
    if (problem === undefined) throw new Error("no problem left")
    return problem
  }
  return Object.assign(check, { checked })
}

test("the key is asked without echo and written private", async () => {
  const office = newOffice()
  const ask = new Script(["", KEY, "claude-opus-4-1"])
  expect(await ensure(office, ask)).toBe(true)
  expect(mode(file(office))).toBe(0o600)
  expect(read(office)).toEqual({ llm_config: { provider: "anthropic", api_key: KEY, model: "claude-opus-4-1" } })
  expect((await saved(office))?.api_key).toBe(KEY)
  for (const line of ask.seen) expect(line).not.toContain(KEY)
  expect(listing(office)).toEqual([".lock", "office.json"]) // no temp file left behind
  expect(ask.seen).toEqual([
    "Model provider",
    "anthropic API key (empty to use `yian auth anthropic`; not shown)",
    "Model",
  ])
  expect(ask.offered).toEqual([[...SUPPORTED_LLM_PROVIDERS], ["claude-sonnet-4-5 (the default)"]])
  expect(ask.typed).toEqual([false, true])
})

test("askProviderTo asks with init's picker and writes the provider to the given file", async () => {
  const dir = join(tempDir(), "hq")
  mkdirSync(dir, { mode: 0o700 })
  const target = join(dir, "provider.json")
  const ask = new Script(["", KEY, "claude-opus-4-1"])
  const check = answers(null)
  const provider = await askProviderTo(target, ask, { listers: NO_LISTING, checkModel: check })
  const llm = { provider: "anthropic", api_key: KEY, model: "claude-opus-4-1" }
  expect(provider.llm_config).toEqual(llm)
  expect(check.checked).toEqual([llm])
  expect(ask.seen).toEqual([
    "Model provider",
    "anthropic API key (empty to use `yian auth anthropic`; not shown)",
    "Model",
    "Checking that the model answers...",
  ])
  expect(mode(dir)).toBe(0o700)
  expect(mode(target)).toBe(0o600)
  expect(readdirSync(dir).sort()).toEqual([".lock", "provider.json"])
  const loaded = await loadProvider(target, Provider.parse, { missingOk: false })
  expect(loaded.llm_config).toEqual(llm)
  expect(loaded).toEqual(provider)
})

/** A 0700 folder for a provider file and its sign-in, as `opencorp hq` keeps them. */
function hqDir(): { dir: string; target: string; auth: string } {
  const dir = join(tempDir(), "hq")
  mkdirSync(dir, { mode: 0o700 })
  return { dir, target: join(dir, "provider.json"), auth: join(dir, "auth.json") }
}

/** A model check that, before answering with the next of `problems`, finds the run's `YIAN_AUTH_FILE` naming the
 *  sign-in waiting beside `auth`, a 0600 file holding the fake sign-in for the model checked, and `target` and `auth`
 *  as they were before. */
function signedInCheck(
  target: string,
  auth: string,
  ...problems: (string | null)[]
): ModelCheck & { checked: unknown[] } {
  const check = answers(...problems)
  const before = [target, auth].map((file) => (existsSync(file) ? readFileSync(file, "utf8") : null))
  const signedIn: ModelCheck = async (provider) => {
    const pending = pendingSignIn(auth)
    expect(pending).toBe(auth.replace(/\.json$/, ".new.json"))
    expect(provider.env[AUTH_FILE_ENV]).toBe(pending)
    expect(mode(pending)).toBe(0o600)
    const store = new AuthStore(pending)
    expect(store.savedSecrets("openai")).toEqual([ACCESS_TOKEN, REFRESH_TOKEN, ACCOUNT])
    expect(store.selection("openai")).toMatchObject({ method: "subscription", model: provider.llm_config?.model })
    expect([target, auth].map((file) => (existsSync(file) ? readFileSync(file, "utf8") : null))).toEqual(before)
    return check(provider)
  }
  return Object.assign(signedIn, { checked: check.checked })
}

/** `seen` holds no token or account of the fake sign-in. */
function noToken(seen: readonly string[]): void {
  for (const line of seen) {
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, ACCOUNT]) expect(line).not.toContain(secret)
  }
}

test("a ChatGPT subscription signs in with a device code, and its model is checked with the saved sign-in before the provider is written", async () => {
  const { dir, target, auth } = hqDir()
  const fake = fakeSubscription()
  const check = signedInCheck(target, auth, null)
  // openai, the subscription (the default), its second model.
  const ask = new Script(["openai", "", "2"])
  const provider = await askProviderTo(target, ask, {
    listers: NO_LISTING,
    checkModel: check,
    signIn: { file: auth, auth: fake.auth },
  })
  expect(ask.seen).toEqual([
    "Model provider",
    HOW_SIGN_IN,
    signInLine(DEVICE_URL, DEVICE_CODE),
    "Model",
    "Checking that the model answers...",
  ])
  expect(signInLine(DEVICE_URL, DEVICE_CODE)).toBe(
    `Sign in to ChatGPT: open ${DEVICE_URL} in a browser, on any device, and enter the code ${DEVICE_CODE}.` +
      " Waiting (Ctrl-C stops it)...",
  )
  expect(ask.offered.slice(1)).toEqual([[SUBSCRIPTION, API_KEY], SUBSCRIPTION_MODELS])
  expect([SUBSCRIPTION, API_KEY]).toEqual(["ChatGPT subscription", "API key"])
  const llm = { provider: "openai", model: "gpt-5.5" }
  expect(check.checked).toEqual([llm])
  expect(provider.llm_config).toEqual(llm)
  // No key: a key would bill the API instead.
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ method: "subscription", llm_config: llm })
  expect(mode(target)).toBe(0o600)
  expect(mode(auth)).toBe(0o600)
  expect(readdirSync(dir).sort()).toEqual([".lock", "auth.json", "provider.json"])
  expect(new AuthStore(auth).selection("openai")).toMatchObject({ method: "subscription", model: "gpt-5.5" })
  noToken(ask.seen)
  for (const name of readdirSync(dir).filter((name) => name !== "auth.json")) {
    noToken([readFileSync(join(dir, name), "utf8")])
  }
})

test("Ctrl-C while the device sign-in waits stops it and saves nothing", async () => {
  const { dir, target, auth } = hqDir()
  const fake = fakeSubscription({ approved: new Promise(() => {}) })
  const stop = new AbortController()
  const ask = new Script(["openai", ""])
  const done = askProviderTo(target, ask, {
    listers: NO_LISTING,
    checkModel: answers(),
    signIn: { file: auth, auth: fake.auth, signal: stop.signal },
  })
  await waitFor(() => ask.seen.includes(signInLine(DEVICE_URL, DEVICE_CODE)), { what: "the code" })
  const interrupt = new KeyboardInterrupt()
  stop.abort(interrupt)
  expect(await rejection(done)).toBe(interrupt)
  expect(fake.signals).toEqual([stop.signal])
  expect(readdirSync(dir)).toEqual([])
})

test("a device sign-in that fails says why and asks again", async () => {
  const { target, auth } = hqDir()
  const fake = fakeSubscription({ failures: [new AuthError("OpenAI login timed out")] })
  const ask = new Script(["openai", "", "", "", ""])
  const check = signedInCheck(target, auth, null)
  await askProviderTo(target, ask, { listers: NO_LISTING, checkModel: check, signIn: { file: auth, auth: fake.auth } })
  expect(ask.seen.slice(0, 5)).toEqual([
    "Model provider",
    HOW_SIGN_IN,
    signInLine(DEVICE_URL, DEVICE_CODE),
    "That doesn't work: OpenAI login timed out",
    "Model provider",
  ])
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
    method: "subscription",
    llm_config: { provider: "openai", model: "gpt-5.5-codex" },
  })
})

test("a subscription whose model doesn't answer keeps its sign-in to try again, and setting up again with a key leaves none", async () => {
  const { dir, target, auth } = hqDir()
  const fake = fakeSubscription()
  const subscription = signedInCheck(target, auth, "Connection error", "Connection error")
  const keyed = answers(null)
  const check: ModelCheck = async (provider) => {
    if (provider.llm_config?.api_key === undefined) return subscription(provider)
    expect(existsSync(auth)).toBe(false)
    expect(provider.env).toEqual({})
    return keyed(provider)
  }
  // The subscription, try again, set up again: openai with a key and its default model.
  const ask = new Script(["openai", "", "", "1", "2", "", "2", KEY, ""])
  await askProviderTo(target, ask, { listers: NO_LISTING, checkModel: check, signIn: { file: auth, auth: fake.auth } })
  expect(subscription.checked).toHaveLength(2)
  expect(keyed.checked).toEqual([{ provider: "openai", api_key: KEY, model: "gpt-5.5" }])
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ llm_config: { provider: "openai", api_key: KEY, model: "gpt-5.5" } })
  expect(readdirSync(dir).sort()).toEqual([".lock", "provider.json"])
  noToken(ask.seen)
})

test("a subscription's model check that yian tells to run yian auth says to set up the model again", async () => {
  const { target, auth } = hqDir()
  const yian = "OpenAI authentication request failed (HTTP 401); sign in again. Run 'yian auth openai' and start a new run"
  const check = signedInCheck(target, auth, yian, null)
  // The subscription; then try again.
  const ask = new Script(["openai", "", "", "1"])
  await askProviderTo(target, ask, { listers: NO_LISTING, checkModel: check, signIn: { file: auth, auth: fakeSubscription().auth } })
  expect(ask.seen).toContain(
    "The model didn't answer: OpenAI authentication request failed (HTTP 401); sign in again: choose" +
      ` "${SET_UP_AGAIN}"`,
  )
  for (const line of ask.seen) expect(line).not.toContain("yian auth")
})

test("a subscription's model check that couldn't reach OpenAI says to try again", async () => {
  const { target, auth } = hqDir()
  const yian = "OpenAI authentication request failed (could not connect). Run 'yian auth openai' and start a new run"
  const ask = new Script(["openai", "", "", "1"])
  await askProviderTo(target, ask, {
    listers: NO_LISTING,
    checkModel: signedInCheck(target, auth, yian, null),
    signIn: { file: auth, auth: fakeSubscription().auth },
  })
  expect(ask.seen).toContain(
    `The model didn't answer: OpenAI authentication request failed (could not connect): choose "${TRY_AGAIN}"`,
  )
})

test("a model check stopped by Ctrl-C removes the new sign-in and leaves the old provider and sign-in as they were", async () => {
  const { dir, target, auth } = hqDir()
  const old = '{"method": "subscription", "llm_config": {"provider": "openai", "model": "gpt-4.1"}}'
  writeFileSync(target, old, { mode: 0o600 })
  writeFileSync(auth, "the old sign-in", { mode: 0o600 })
  const interrupt = new KeyboardInterrupt()
  const check = signedInCheck(target, auth)
  const stopped: ModelCheck = async (provider) => {
    await expect(check(provider)).rejects.toThrow("no problem left")
    throw interrupt
  }
  const ask = new Script(["openai", "", ""])
  const error = await rejection(
    askProviderTo(target, ask, { listers: NO_LISTING, checkModel: stopped, signIn: { file: auth, auth: fakeSubscription().auth } }),
  )
  expect(error).toBe(interrupt)
  expect(readdirSync(dir).sort()).toEqual(["auth.json", "provider.json"])
  expect([readFileSync(target, "utf8"), readFileSync(auth, "utf8")]).toEqual([old, "the old sign-in"])
})

test("a provider file that can't be written after the model answers removes the sign-in", async () => {
  const { dir, target, auth } = hqDir()
  // A folder where the file goes: the write fails.
  mkdirSync(target, { mode: 0o700 })
  const ask = new Script(["openai", "", ""])
  const error = await rejection(
    askProviderTo(target, ask, {
      listers: NO_LISTING,
      checkModel: answers(null),
      signIn: { file: auth, auth: fakeSubscription().auth },
    }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toStartWith(`can't write ${target}`)
  expect(existsSync(auth)).toBe(false)
  expect(existsSync(pendingSignIn(auth))).toBe(false)
  noToken([error.message])
  // The new sign-in moves in only once provider.json is written, so it never took auth.json's place.
  expect(readdirSync(dir).filter((name) => name.startsWith("auth"))).toEqual([])
})

test("a sign-in a stopped check left waiting is removed when the picker starts", async () => {
  const { dir, target, auth } = hqDir()
  await new AuthStore(pendingSignIn(auth)).save("openai", fakeSubscription().creds, "gpt-5.5")
  expect(readdirSync(dir).sort()).toEqual(["auth.new.json", "auth.new.json.lock"])
  const seen: string[][] = []
  const ask = new Script(["openai", "2", KEY, ""])
  const check: ModelCheck = async (provider) => {
    seen.push(readdirSync(dir).sort())
    return answers(null)(provider)
  }
  await askProviderTo(target, ask, { listers: NO_LISTING, checkModel: check, signIn: { file: auth, auth: fakeSubscription().auth } })
  expect(seen).toEqual([[]])
  expect(readdirSync(dir).sort()).toEqual([".lock", "provider.json"])
})

test("with an API key, openai asks today's questions and removes a sign-in left from before", async () => {
  const { dir, target, auth } = hqDir()
  await new AuthStore(auth).save("openai", fakeSubscription().creds, "gpt-5.5")
  const ask = new Script(["openai", "2", KEY, ""])
  const check = answers(null)
  await askProviderTo(target, ask, { listers: NO_LISTING, checkModel: check, signIn: { file: auth, auth: fakeSubscription().auth } })
  expect(ask.seen).toEqual([
    "Model provider",
    HOW_SIGN_IN,
    "openai API key (empty to use `yian auth openai`; not shown)",
    "Model",
    "Checking that the model answers...",
  ])
  expect(check.checked).toEqual([{ provider: "openai", api_key: KEY, model: "gpt-5.5" }])
  expect(readdirSync(dir).sort()).toEqual([".lock", "auth.json.lock", "provider.json"])
})

test("without a sign-in file the picker never asks how openai signs in", async () => {
  const { target } = hqDir()
  const ask = new Script(["openai", KEY, ""])
  await askProviderTo(target, ask, { listers: NO_LISTING, checkModel: answers(null) })
  expect(ask.seen).not.toContain(HOW_SIGN_IN)
  expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ llm_config: { provider: "openai", api_key: KEY, model: "gpt-5.5" } })
})

test("a sign-in folder open to others stops the picker before the device sign-in starts", async () => {
  const { dir, target, auth } = hqDir()
  chmodSync(dir, 0o755)
  const fake = fakeSubscription()
  const ask = new Script(["openai", ""])
  const error = await rejection(
    askProviderTo(target, ask, { listers: NO_LISTING, checkModel: answers(), signIn: { file: auth, auth: fake.auth } }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe(`can't keep the sign-in: folder '${dir}' must be mode 0700`)
  expect(fake.signals).toEqual([])
  expect(ask.seen).toEqual(["Model provider", HOW_SIGN_IN])
  expect(readdirSync(dir)).toEqual([])
})

/** The office's sign-in, beside its setup connection. */
const signInFile = (office: string): string => join(office, "connections", "office.auth.json")

/** Writes `office`'s setup connection as a subscription on `model`, and its sign-in, expiring in `inSeconds`. */
async function subscribedOffice(office: string, model = "gpt-5.5", inSeconds = 3600): Promise<void> {
  new Connections(office).ensureDir()
  writeFileSync(file(office), JSON.stringify({ method: "subscription", llm_config: { provider: "openai", model } }), {
    mode: 0o600,
  })
  const creds = new OAuthCredentials({
    accessToken: "saved-access-0123456789",
    refreshToken: "saved-refresh-0123456789",
    expiresAt: Date.now() / 1000 + inSeconds,
    accountId: ACCOUNT,
  })
  await new AuthStore(signInFile(office)).save("openai", creds, model)
}

test("onboard's picker can sign in to a ChatGPT subscription, its sign-in in office.auth.json, checked before office.json is written", async () => {
  const office = newOffice()
  const fake = fakeSubscription()
  const check = signedInCheck(file(office), signInFile(office), null)
  const ask = new Script(["openai", "", ""])
  expect(await ensure(office, ask, { checkModel: check, auth: fake.auth })).toBe(true)
  expect(ask.seen.slice(0, 3)).toEqual(["Model provider", HOW_SIGN_IN, signInLine(DEVICE_URL, DEVICE_CODE)])
  expect(read(office)).toEqual({ method: "subscription", llm_config: { provider: "openai", model: "gpt-5.5-codex" } })
  expect(listing(office)).toEqual([".lock", "office.auth.json", "office.json"])
  expect(mode(signInFile(office))).toBe(0o600)
  expect(mode(join(office, "connections"))).toBe(0o700)
  const run = await new Connections(office).resolve(null, null)
  expect(run.env).toEqual({ YIAN_AUTH_FILE: signInFile(office) })
  noToken(ask.seen)
  noToken([readFileSync(file(office), "utf8")])
})

test("without a terminal, openai's sign-in question takes the key, as before", async () => {
  const office = newOffice()
  const { input, output } = pipe("")
  const ask = new TtyPrompter({ preset: { "Model provider": "openai" }, interactive: false, input, output, env: {} })
  const error = await rejection(ensure(office, ask, { auth: fakeSubscription().auth }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("--provider-stdin")
})

test("a subscription office.json whose sign-in works is kept, refreshed first when its token is about to expire", async () => {
  const office = newOffice()
  await subscribedOffice(office)
  const ask = new Script([])
  expect(await ensure(office, ask, { auth: fakeSubscription().auth })).toBe(false)
  expect(ask.seen).toEqual([])
  const expired = newOffice()
  await subscribedOffice(expired, "gpt-5.5", -60)
  const fresh = new OAuthCredentials({
    accessToken: "fresh-access-0123456789",
    refreshToken: "fresh-refresh-0123456789",
    expiresAt: Date.now() / 1000 + 3600,
    accountId: ACCOUNT,
  })
  const refreshing = fakeSubscription({ refreshed: fresh })
  expect(await ensure(expired, new Script([]), { auth: refreshing.auth })).toBe(false)
  expect(refreshing.refreshes.count).toBe(1)
  expect(new AuthStore(signInFile(expired)).savedSecrets("openai")[0]).toBe(fresh.accessToken)
})

test("a subscription office.json whose sign-in is missing, unreadable or refused says so and signs in again", async () => {
  const refused = new AuthError("OpenAI authentication request failed (HTTP 401, refresh_token_expired); sign in again", {
    status: 401,
  })
  const cases: [string, (office: string) => void, string, number][] = [
    ["missing", (office) => rmSync(signInFile(office)), "is missing; set up the model again.", 3600],
    ["open to others", (office) => chmodSync(signInFile(office), 0o644), "must be private to its owner", 3600],
    ["refused", () => {}, "has expired or was revoked", -60],
  ]
  for (const [, damage, said, inSeconds] of cases) {
    const office = newOffice()
    await subscribedOffice(office, "gpt-5.5", inSeconds)
    damage(office)
    const fake = fakeSubscription({ refreshed: refused })
    // Enter at each question: openai, the subscription, the model it had.
    const ask = new Script(["", "", ""])
    expect(await ensure(office, ask, { checkModel: answers(null), auth: fake.auth })).toBe(true)
    expect(ask.seen[0]).toStartWith(`${file(office)} signs in to a ChatGPT subscription, but`)
    expect(ask.seen[0]).toContain(said)
    expect(ask.seen.slice(1, 3)).toEqual(["Model provider", HOW_SIGN_IN])
    expect(read(office)).toEqual({ method: "subscription", llm_config: { provider: "openai", model: "gpt-5.5" } })
    expect(new AuthStore(signInFile(office)).savedSecrets("openai")[0]).toBe(ACCESS_TOKEN)
    for (const line of ask.seen) expect(line).not.toContain("yian auth")
  }
  // With no one to ask, it says how to sign in again.
  const office = newOffice()
  await subscribedOffice(office)
  rmSync(signInFile(office))
  const error = await rejection(ensure(office, new Script([], { interactive: false }), { auth: fakeSubscription().auth }))
  expect(error.message).toBe(
    `${file(office)} signs in to a ChatGPT subscription, but its sign-in ${signInFile(office)} is missing;` +
      " run `opencorp onboard` in a terminal to sign in again",
  )
})

test("a refresh that may work later warns, keeps the office's sign-in, and onboarding goes on, as offline with a key", async () => {
  const failures = [
    new AuthError("OpenAI authentication request failed (could not connect)"),
    new AuthError("OpenAI authentication request failed (HTTP 429)", { status: 429 }),
    new AuthError("OpenAI authentication request failed (HTTP 503)", { status: 503 }),
  ]
  for (const refreshed of failures) {
    const office = newOffice()
    await subscribedOffice(office, "gpt-5.5", -60)
    const before = readFileSync(signInFile(office), "utf8")
    // No terminal either: nothing is asked.
    const ask = new Script([], { interactive: false })
    expect(await ensure(office, ask, { auth: fakeSubscription({ refreshed }).auth })).toBe(false)
    expect(ask.seen).toEqual([
      `Couldn't refresh the ChatGPT sign-in in ${signInFile(office)} now (${refreshed.message}); the office's runs` +
        " will try again.",
    ])
    expect(readFileSync(signInFile(office), "utf8")).toBe(before)
  }
})

test("a provider on stdin replaces a subscription and removes its sign-in, and a stray waiting sign-in goes", async () => {
  const office = newOffice()
  await subscribedOffice(office)
  await new AuthStore(pendingSignIn(signInFile(office))).save("openai", fakeSubscription().creds, "gpt-5.5")
  await ensure(office, new Script(), { stdin: stdin({ llm_config: { provider: "anthropic", api_key: KEY } }) })
  expect(read(office)).toEqual({ llm_config: { provider: "anthropic", api_key: KEY, model: "claude-sonnet-4-5" } })
  expect(listing(office).filter((name) => name.includes("auth"))).toEqual(["office.auth.json.lock"])
})

test("no key and no model name means the model yians login saved", async () => {
  const office = newOffice()
  await ensure(office, new Script(["openai", "2", "", "  "]))
  expect(read(office)).toEqual({ llm_config: { provider: "openai" } })
})

test("picking the default saves its name", async () => {
  // Yian has no default model, so the file names it.
  const office = newOffice()
  await ensure(office, new Script(["openai", "2", KEY, "1"]))
  expect(read(office)).toEqual({ llm_config: { provider: "openai", api_key: KEY, model: "gpt-5.5" } })
})

test("a provider without a default model asks for one until it has it", async () => {
  const office = newOffice()
  const ask = new Script(["google", KEY, "", "gemini-2.5-pro"])
  await ensure(office, ask)
  expect(read(office)).toEqual({ llm_config: { provider: "google", api_key: KEY, model: "gemini-2.5-pro" } })
  expect(ask.offered).toEqual([[...SUPPORTED_LLM_PROVIDERS]])
  expect(ask.seen.filter((line) => line === "Model name (google has no default model)")).toHaveLength(2)
  expect(ask.seen).toContain("That doesn't work: type the model's name")
})

test.each([
  "acme",
  "acme.openai.azure.com",
  "https://acme.openai.azure.com/",
  " https://acme.openai.azure.com/openai/v1/ ",
])("azure is saved as openai on the resources v1 endpoint [%s]", async (endpoint) => {
  const office = newOffice()
  const ask = new Script(["azure", endpoint, KEY, "gpt-5-4-prod"])
  expect(await ensure(office, ask)).toBe(true)
  expect(read(office)).toEqual({
    llm_config: {
      provider: "openai",
      base_url: "https://acme.openai.azure.com/openai/v1/",
      api_key: KEY,
      model: "gpt-5-4-prod",
    },
  })
  expect(ask.seen).toEqual([
    "Model provider",
    "Azure OpenAI endpoint or resource name",
    "azure API key (not shown)",
    "Deployment name",
  ])
})

test("azure offers the resources deployments", async () => {
  const office = newOffice()
  const seen: [string, string][] = []
  const listers: Listers = {
    ...NO_LISTING,
    azureDeployments: async (baseUrl, key) => {
      seen.push([baseUrl, key])
      return ["gpt-5.4", "o3"]
    },
  }
  const ask = new Script(["azure", "acme", KEY, "2"])
  await ensure(office, ask, { listers })
  expect((await saved(office))?.model).toBe("o3")
  expect(seen).toEqual([["https://acme.openai.azure.com/openai/v1/", KEY]])
  expect(ask.offered).toContainEqual(["gpt-5.4", "o3"])
  expect(ask.typed).toContain(true)
})

test("azure takes a typed deployment too", async () => {
  const office = newOffice()
  await ensure(office, new Script(["azure", "acme", KEY, "my-deployment"]), {
    listers: deploymentsListed(async () => ["gpt-5.4"]),
  })
  expect((await saved(office))?.model).toBe("my-deployment")
})

test("a model typed before is the answer for nothing", async () => {
  let ask = new Script([""])
  expect(await askModelWith(ask, "anthropic", "claude-opus-4-1", SENTINEL)).toBe("claude-opus-4-1")
  expect(ask.offered).toEqual([["claude-sonnet-4-5 (the default)"]])
  expect(ask.typed).toEqual([true])
  ask = new Script([""])
  expect(await askModelWith(ask, "anthropic", "claude-opus-4-1")).toBe("claude-opus-4-1")
  expect(ask.offered).toEqual([["the model `yian auth anthropic` saved"]])
})

test("a deployment typed before is the answer for nothing", async () => {
  const ask = new Script([""])
  const url = "https://acme.openai.azure.com/openai/v1/"
  expect(await askDeployment(ask, url, KEY, "mine", deploymentsListed(async () => ["gpt-5.4"]))).toBe("mine")
  expect(ask.offered).toEqual([["gpt-5.4"]])
  expect(ask.typed).toEqual([true])
})

test("an empty typed deployment on the terminal is never saved empty", async () => {
  // Pick "Type my own answer" (3), then type nothing.
  const { input, output } = pipe("3\n\n")
  const url = "https://acme.openai.azure.com/openai/v1/"
  const prompter = new TtyPrompter({ input, output, env: {} })
  const listers = deploymentsListed(async () => ["gpt-5.4", "o3"])
  expect(await askDeployment(prompter, url, KEY, "", listers)).toBe("gpt-5.4")
})

test("azure asks for the name when it cant list the deployments", async () => {
  const office = newOffice()
  const listers = deploymentsListed(async () => {
    throw new OnboardError("HTTP 401")
  })
  const ask = new Script(["azure", "acme", KEY, "gpt-5-4-prod"])
  await ensure(office, ask, { listers })
  expect((await saved(office))?.model).toBe("gpt-5-4-prod")
  expect(ask.seen.slice(-2)).toEqual([
    "Couldn't list the deployments (HTTP 401); type the name instead.",
    "Deployment name",
  ])
})

test("setting azure up again defaults to the last deployment", async () => {
  const office = newOffice()
  await ensure(office, new Script(["azure", "acme", KEY, "2", "2", "", "", "", ""]), {
    listers: deploymentsListed(async () => ["gpt-5.4", "o3"]),
    checkModel: answers("Error code: 429", null),
  })
  expect((await saved(office))?.model).toBe("o3")
})

test("a provider offers the models it lists for the key", async () => {
  const office = newOffice()
  const seen: [string, string][] = []
  const listers = modelsListed(async (name, key) => {
    seen.push([name, key])
    return ["claude-opus-4-1", "claude-sonnet-4-5"]
  })
  const ask = new Script(["anthropic", SENTINEL, "2"])
  await ensure(office, ask, { listers })
  expect((read(office) as { llm_config: unknown }).llm_config).toEqual({
    provider: "anthropic",
    api_key: SENTINEL,
    model: "claude-opus-4-1",
  })
  expect(seen).toEqual([["anthropic", SENTINEL]])
  expect(ask.offered.at(-1)).toEqual(["claude-sonnet-4-5 (the default)", "claude-opus-4-1"])
  expect(ask.typed.at(-1)).toBe(true)
  for (const line of ask.seen) expect(line).not.toContain(SENTINEL)
})

test("a provider without a default offers its models and takes a typed one", async () => {
  const listers = modelsListed(async () => ["gemini-2.5-flash", "gemini-2.5-pro"])
  const office = newOffice()
  const ask = new Script(["google", SENTINEL, ""])
  await ensure(office, ask, { listers })
  expect((await saved(office))?.model).toBe("gemini-2.5-flash")
  expect(ask.offered.at(-1)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"])
  expect(ask.typed.at(-1)).toBe(true)
  expect(await askModelWith(new Script(["gemini-3-pro"]), "google", "", SENTINEL, listers)).toBe("gemini-3-pro")
})

test("a listing that fails falls back to typing the model", async () => {
  const listers = modelsListed(async () => {
    throw new OnboardError("HTTP 401")
  })
  const office = newOffice()
  const ask = new Script(["google", SENTINEL, "gemini-2.5-pro"])
  await ensure(office, ask, { listers })
  expect((await saved(office))?.model).toBe("gemini-2.5-pro")
  expect(ask.seen.slice(-2)).toEqual(["Couldn't list the models (HTTP 401).", "Model name (google has no default model)"])
})

test("nothing is listed without a key or someone to ask", async () => {
  const never: Listers = {
    azureDeployments: async () => {
      throw new Error("nothing to list with")
    },
    providerModels: async () => {
      throw new Error("nothing to list with")
    },
  }
  await ensure(newOffice(), new Script(["anthropic", "", ""]), { listers: never })
  const ask = new Script([""], { interactive: false })
  expect(await askModelWith(ask, "anthropic", "", SENTINEL, never)).toBe("claude-sonnet-4-5")
})

test("azure needs a key and a usable endpoint", async () => {
  const office = newOffice()
  const ask = new Script(["azure", "http://acme.example.com", "acme", "", KEY, "dep"])
  await ensure(office, ask)
  expect((await saved(office))?.api_key).toBe(KEY)
  expect(ask.seen.filter((line) => line === "Azure OpenAI endpoint or resource name")).toHaveLength(2)
  expect(ask.seen.filter((line) => line === "azure API key (not shown)")).toHaveLength(2)
  expect(ask.seen).toContain("That doesn't work: azure needs a key")
})

test("an existing provider that cant be used is asked again on a terminal", async () => {
  const office = newOffice()
  place(office, JSON.stringify({ llm_config: { provider: "azure", api_key: KEY } }))
  const ask = new Script(["openai", "2", "", ""])
  expect(await ensure(office, ask)).toBe(true)
  expect(read(office)).toEqual({ llm_config: { provider: "openai" } })
  expect(ask.seen[0]).toBe(
    `${file(office)}: llm_config.model is missing, and azure has no default model; set up the model again.`,
  )
  for (const line of ask.seen) expect(line).not.toContain(KEY)
})

test("no key means composers own login", async () => {
  const office = newOffice()
  const ask = new Script(["openai", "2", "", ""])
  await ensure(office, ask)
  expect(read(office)).toEqual({ llm_config: { provider: "openai" } })
  expect(ask.seen.some((line) => line.includes("yian auth"))).toBe(true)
  expect(ask.offered.at(-1)).toEqual(["the model `yian auth openai` saved"])
  expect(ask.typed.at(-1)).toBe(true)
})

test("no key takes a typed model too", async () => {
  const office = newOffice()
  await ensure(office, new Script(["google", "", "gemini-2.5-pro"]))
  expect(read(office)).toEqual({ llm_config: { provider: "google", model: "gemini-2.5-pro" } })
})

test("a keyless provider without a key offers its models", async () => {
  const office = newOffice()
  // The provider, its server URL and the model: yian's ollama client sends no key, so none is asked for.
  const ask = new Script(["ollama", "", ""])
  await ensure(office, ask, { listers: modelsListed(async () => ["llama3", "qwen3"]) })
  expect(read(office)).toEqual({ llm_config: { provider: "ollama", model: "llama3" } })
  expect(ask.offered.at(-1)).toEqual(["llama3", "qwen3"])
  expect(ask.seen.some((line) => line.includes("API key"))).toBe(false)
})

test("a vllm server elsewhere is listed and saved in the providers env", async () => {
  const office = newOffice()
  const listed: unknown[] = []
  const listers = modelsListed(async (name, key, baseUrl) => {
    listed.push([name, key, baseUrl])
    return ["qwen3"]
  })
  const ask = new Script(["vllm", "http://192.168.1.5:8000/v1", "", ""])
  await ensure(office, ask, { listers })
  expect(listed).toEqual([["vllm", "", "http://192.168.1.5:8000/v1"]])
  expect(read(office)).toEqual({
    llm_config: { provider: "vllm", model: "qwen3" },
    env: { VLLM_BASE_URL: "http://192.168.1.5:8000/v1" },
  })
  expect(ask.seen).toContain("vllm server URL (empty for one on this machine)")
  expect(ask.seen).toContain("vllm API key (empty for none; not shown)")
  expect(ask.seen.some((line) => line.includes("yian auth"))).toBe(false)
})

test("a vllm server on this machine leaves the env out", async () => {
  const office = newOffice()
  const listed: unknown[] = []
  const listers = modelsListed(async (name, key, baseUrl) => {
    listed.push([name, key, baseUrl])
    return []
  })
  await ensure(office, new Script(["vllm", "", "", "m1"]), { listers })
  expect(listed).toEqual([["vllm", "", ""]])
  expect(read(office)).toEqual({ llm_config: { provider: "vllm", model: "m1" } })
})

test("an ollama server elsewhere is saved in the providers env", async () => {
  const office = newOffice()
  await ensure(office, new Script(["ollama", "http://10.0.0.2:11434", "llama3"]))
  expect(read(office)).toEqual({
    llm_config: { provider: "ollama", model: "llama3" },
    env: { OLLAMA_BASE_URL: "http://10.0.0.2:11434" },
  })
})

test.each([
  "ftp://h",
  "not a url",
  "http://u:hunter2@h:8000/v1",
  "http://@h:8000/v1",
  "http://h/v1?x=1",
  "http://h/v1#f",
  "http://münchen.lan:11434",
  "http://h/my v1",
])(
  "a server URL that isnt usable is asked again without echoing it [%s]",
  async (url) => {
    const office = newOffice()
    const ask = new Script(["vllm", url, "", "", "m"])
    await ensure(office, ask)
    expect(read(office)).toEqual({ llm_config: { provider: "vllm", model: "m" } })
    expect(ask.seen.filter((line) => line.startsWith("That doesn't work: "))).toHaveLength(1)
    for (const line of ask.seen) {
      expect(line).not.toContain("hunter2")
      expect(line).not.toContain(url)
    }
  },
)

test("a key goes to a vllm server only over https or to this machine", async () => {
  const office = newOffice()
  const other = "sk-other-4f1e0b7a9c"
  const ask = new Script(["vllm", "http://192.168.1.5:8000/v1", KEY, "https://vllm.lan/v1", other, "m"])
  await ensure(office, ask)
  expect(ask.seen).toContain("That doesn't work: a key goes only over https, or http to localhost, 127.0.0.1 or ::1")
  expect(read(office)).toEqual({
    llm_config: { provider: "vllm", api_key: other, model: "m" },
    env: { VLLM_BASE_URL: "https://vllm.lan/v1" },
  })
  for (const line of ask.seen) expect(line).not.toContain(KEY)
})

test("a key goes to a vllm server on localhost over http", async () => {
  const office = newOffice()
  await ensure(office, new Script(["vllm", "http://localhost:8000/v1", KEY, "m"]))
  expect(read(office)).toEqual({
    llm_config: { provider: "vllm", api_key: KEY, model: "m" },
    env: { VLLM_BASE_URL: "http://localhost:8000/v1" },
  })
})

test("setting up again keeps the server URL", async () => {
  const office = newOffice()
  const url = "http://192.168.1.5:8000/v1"
  const ask = new Script(["vllm", url, "", "m", SET_UP_AGAIN, "", "", "", ""])
  await ensure(office, ask, { checkModel: answers("nope", null) })
  expect(read(office)).toEqual({ llm_config: { provider: "vllm", model: "m" }, env: { VLLM_BASE_URL: url } })
  expect(ask.seen.filter((line) => line === "vllm server URL (empty for one on this machine)")).toHaveLength(1)
  expect(ask.seen).toContain("vllm server URL (empty keeps the one you just typed)")
})

test("a key isnt sent to a URL yian wouldnt send it to, and says why", async () => {
  const office = newOffice()
  const ask = new Script(["vllm", "https://vllm_server:8000/v1", KEY, "https://vllm.lan/v1", KEY, "m"])
  await ensure(office, ask)
  expect(ask.seen).toContain(
    "That doesn't work: yian sends a key only to a lowercase ASCII URL whose host has no underscore",
  )
  expect(ask.seen.some((line) => line.includes("only over https"))).toBe(false)
  expect(read(office)).toEqual({
    llm_config: { provider: "vllm", api_key: KEY, model: "m" },
    env: { VLLM_BASE_URL: "https://vllm.lan/v1" },
  })
})

test("a key to an upper case http URL on this machine says why, not that it needs https", async () => {
  const office = newOffice()
  const ask = new Script(["vllm", "HTTP://localhost:8000/v1", KEY, "http://localhost:8000/v1", KEY, "m"])
  await ensure(office, ask)
  expect(ask.seen).toContain(
    "That doesn't work: yian sends a key only to a lowercase ASCII URL whose host has no underscore",
  )
  expect(ask.seen.some((line) => line.includes("only over https"))).toBe(false)
})

test("a keyless vllm server URL may have an underscore", async () => {
  const office = newOffice()
  await ensure(office, new Script(["vllm", "http://vllm_server:8000/v1", "", "m"]))
  expect(read(office)).toEqual({
    llm_config: { provider: "vllm", model: "m" },
    env: { VLLM_BASE_URL: "http://vllm_server:8000/v1" },
  })
})

// No test changes process.env, so the key sits in a child's environment.
test("a key in the environment is never read", async () => {
  const office = newOffice()
  const code = [
    `import { ensureProvider } from ${JSON.stringify(ONBOARD)}`,
    'const answers = ["anthropic", "", ""]',
    "const next = (answer = \"\") => {",
    '  if (answers.length === 0) throw new Error("the script ran out of answers")',
    "  return answers.shift() || answer",
    "}",
    "const prompter = {",
    "  interactive: true,",
    "  ask: async (_q, answer) => next(answer),",
    "  choose: async (_q, _options, answer) => next(answer),",
    "  secret: async () => next(),",
    "  say: () => {},",
    "  step: () => {},",
    "}",
    "const listers = { azureDeployments: async () => [], providerModels: async () => [] }",
    "await ensureProvider(process.argv.at(-1), prompter, { listers })",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", "-e", code, office], {
    cwd: OFFICE,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: KEY },
    stdout: "ignore",
    stderr: "pipe",
  })
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), 20_000)))
    const status = await Promise.race([child.exited, timeout])
    clearTimeout(timer)
    // Killed before stderr is read: a child that timed out would keep stderr open.
    child.kill("SIGKILL")
    expect(status, await new Response(child.stderr).text()).toBe(0)
    const text = readFileSync(file(office), "utf8")
    expect(text).not.toContain(KEY)
    expect(Object.hasOwn((JSON.parse(text) as { llm_config: object }).llm_config, "api_key")).toBe(false)
  } finally {
    child.kill("SIGKILL")
  }
}, 30_000)

test("an unknown provider preset gives up", async () => {
  const office = newOffice()
  const { input } = pipe("")
  const { stream, text } = collector(false)
  const prompter = new TtyPrompter({ preset: { "Model provider": "antrhopic" }, input, output: stream, env: {} })
  const error = await rejection(ensure(office, prompter))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("no usable answer to 'Model provider'")
  expect(text()).toContain(`That doesn't work: choose one of: ${SUPPORTED_LLM_PROVIDERS.join(", ")}\n`)
  expect(existsSync(file(office))).toBe(false)
})

test("a key asked for without a terminal says to pass the provider on stdin", async () => {
  const office = newOffice()
  const { input, output } = pipe(KEY + "\n")
  const prompter = new TtyPrompter({ preset: { "Model provider": "anthropic" }, interactive: false, input, output, env: {} })
  const error = await rejection(ensure(office, prompter))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error).not.toBeInstanceOf(NoTerminal)
  expect(error.message).toContain("--provider-stdin")
  expect(error.message).not.toContain(KEY)
})

test("the provider is saved only once the model answers", async () => {
  const office = newOffice()
  const check = answers(null)
  const ask = new Script(["openai", "2", KEY, ""])
  expect(await ensure(office, ask, { checkModel: check })).toBe(true)
  expect(check.checked).toEqual([{ provider: "openai", api_key: KEY, model: "gpt-5.5" }])
  expect(ask.seen.at(-1)).toBe("Checking that the model answers...")
  expect(await saved(office)).toEqual({ provider: "openai", api_key: KEY, model: "gpt-5.5" })
})

test("a provider on stdin says it is checking the model", async () => {
  const office = newOffice()
  const ask = new Script()
  const data = { llm_config: { provider: "anthropic", api_key: KEY } }
  expect(await ensure(office, ask, { stdin: stdin(data), checkModel: answers(null) })).toBe(true)
  expect(ask.seen).toEqual(["Checking that the model answers..."])
})

test("a provider on stdin whose model times out is not saved", async () => {
  const office = newOffice()
  const ask = new Script()
  const data = { llm_config: { provider: "anthropic", api_key: KEY } }
  const error = await rejection(ensure(office, ask, { stdin: stdin(data), checkModel: answers("timed out") }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe("the model didn't answer: timed out")
  expect(ask.seen[0]).toBe("Checking that the model answers...")
  expect(existsSync(file(office))).toBe(false)
})

test("trying again checks the same answers and nothing is saved until it works", async () => {
  const office = newOffice()
  const problems = answers("Connection error", "Connection error", null)
  const check = async (provider: Provider) => {
    expect(existsSync(file(office))).toBe(false)
    return problems(provider)
  }
  const ask = new Script(["openai", "2", KEY, "", "", "1"])
  await ensure(office, ask, { checkModel: check })
  expect(ask.seen.filter((line) => line === "The model didn't answer: Connection error")).toHaveLength(2)
  expect(ask.offered.slice(-2)).toEqual([
    [TRY_AGAIN, SET_UP_AGAIN],
    [TRY_AGAIN, SET_UP_AGAIN],
  ])
  expect(await saved(office)).toEqual({ provider: "openai", api_key: KEY, model: "gpt-5.5" })
})

test("setting up again starts from the last answers and keeps the key", async () => {
  const office = newOffice()
  const check = answers("Error code: 404 - DeploymentNotFound", null)
  const ask = new Script(["azure", "acme", KEY, "gpt-5-4", "2", "", "", "", "gpt-5-4-prod"])
  await ensure(office, ask, { checkModel: check })
  expect(await saved(office)).toEqual({
    provider: "openai",
    base_url: "https://acme.openai.azure.com/openai/v1/",
    api_key: KEY,
    model: "gpt-5-4-prod",
  })
  expect(ask.seen).toContain("azure API key (empty keeps the one you just typed; not shown)")
  for (const line of ask.seen) expect(line).not.toContain(KEY)
})

test("picking the default when setting up again drops the typed model", async () => {
  const office = newOffice()
  // Typed, then the default; the third round's empty answers keep the default.
  const ask = new Script(["openai", "2", "", "gpt-x", "2", "", "", "", "1", "2", "", "", "", ""])
  await ensure(office, ask, { checkModel: answers("Error code: 404", "Error code: 404", null) })
  expect(await saved(office)).toEqual({ provider: "openai" })
})

test("a model that never answers is never saved", async () => {
  const office = newOffice()
  const ask = new Script(["openai", "2", KEY, "", "1", "1"])
  // The script ran out: only the owner can stop asking, with Ctrl-C.
  const error = await rejection(ensure(office, ask, { checkModel: async () => "Connection error" }))
  expect(error.message).toBe("the script ran out of answers")
  expect(existsSync(file(office))).toBe(false)
})

test("a key is never kept for another provider", async () => {
  const office = newOffice()
  const check = answers("Error code: 401", null)
  const ask = new Script(["azure", "acme", KEY, "gpt-5-4", "2", "openai", "2", "", "1"])
  await ensure(office, ask, { checkModel: check })
  expect(await saved(office)).toEqual({ provider: "openai" })
  expect(ask.seen).toContain("openai API key (empty to use `yian auth openai`; not shown)")
})

test("the setup connection is made 0700 and read as the office connection", async () => {
  const office = newOffice()
  expect(existsSync(join(office, "connections"))).toBe(false)
  await ensure(office, new Script(), { stdin: stdin({ llm_config: { provider: "anthropic", api_key: KEY } }) })
  expect(mode(join(office, "connections"))).toBe(0o700)
  expect(mode(file(office))).toBe(0o600)
  expect(Object.hasOwn(read(office) as object, "method")).toBe(false)
  expect((await new Connections(office).get("office")).llm_config?.api_key).toBe(KEY)
})

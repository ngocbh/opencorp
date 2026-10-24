/** Setting up the model provider, and the terminal prompter that asks for it. */
import { PassThrough, Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import {
  KeyboardInterrupt,
  NoTerminal,
  OnboardError,
  TRIES,
  TYPE_OWN,
  TtyPrompter,
  readLine,
} from "../../src/install/prompts.ts"

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

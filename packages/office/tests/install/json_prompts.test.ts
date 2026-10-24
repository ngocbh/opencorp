/** The setup screen's prompts: one SetupPrompt JSON line out, one SetupAnswer JSON line back. */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PassThrough, Readable } from "node:stream"
import { expect, test } from "bun:test"
import { JsonPrompter } from "../../src/install/json_prompts.ts"
import { OnboardError } from "../../src/install/prompts.ts"

const OFFICE = fileURLToPath(new URL("../..", import.meta.url))
const PROMPTS = fileURLToPath(new URL("../../src/install/prompts.ts", import.meta.url))

type Out = { text: string; write(text: string): void }

/** A collecting output. */
function output(): Out {
  return {
    text: "",
    write(text: string) {
      this.text += text
    },
  }
}

/** A prompter whose stdin holds one answer line per answer, and its output. */
function prompter(answers: string[], preset?: Record<string, string>): [JsonPrompter, Out] {
  const out = output()
  const stdin = Readable.from([answers.map((a) => JSON.stringify({ answer: a }) + "\n").join("")])
  return [new JsonPrompter(out, stdin, preset), out]
}

/** Each line sent, parsed. */
function sent(out: Out): unknown[] {
  return out.text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
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

test("ask sends the question and returns the answer", async () => {
  const [p, out] = prompter(["Acme"])
  expect(await p.ask("Company", "Default Co")).toBe("Acme")
  expect(sent(out)).toEqual([{ type: "ask", question: "Company", default: "Default Co" }])
  expect(out.text).toBe('{"type":"ask","question":"Company","default":"Default Co"}\n')
})

test("an empty answer is the default", async () => {
  const [p] = prompter(["  "])
  expect(await p.ask("Company", "Default Co")).toBe("Default Co")
})

test("choose returns one of the options", async () => {
  const [p, out] = prompter(["openai"])
  expect(await p.choose("Model provider", ["anthropic", "openai"], "anthropic")).toBe("openai")
  expect(sent(out)).toEqual([
    { type: "choose", question: "Model provider", options: ["anthropic", "openai"], default: "anthropic", typed: false },
  ])
  expect(out.text).toBe(
    '{"type":"choose","question":"Model provider","options":["anthropic","openai"],"default":"anthropic","typed":false}\n',
  )
})

test("an empty choice is the default", async () => {
  const [p] = prompter([""])
  expect(await p.choose("Model provider", ["anthropic", "openai"], "openai")).toBe("openai")
})

test("choose refuses an answer that isnt an option", async () => {
  const [p] = prompter(["gemini"])
  const caught = await rejection(p.choose("Model provider", ["anthropic", "openai"]))
  expect(caught).toBeInstanceOf(OnboardError)
  expect(caught.message).toContain("isn't one of")
})

const FIRST = "claude-sonnet-4-5 (the default)"

test("a typed choice says so and takes typed text", async () => {
  const [p, out] = prompter([" claude-opus-4-1 "])
  expect(await p.choose("Model", [FIRST], FIRST, true)).toBe("claude-opus-4-1")
  expect(sent(out)).toEqual([{ type: "choose", question: "Model", options: [FIRST], default: FIRST, typed: true }])
})

test("a typed choice still returns an option and takes the default for nothing", async () => {
  const [p] = prompter(["None for now", "  "])
  expect(await p.choose("Remote", ["None for now"], "None for now", true)).toBe("None for now")
  expect(await p.choose("Remote", ["None for now"], "my-model", true)).toBe("my-model")
})

test("a long option is sent and returned whole", async () => {
  const label = Array(4).fill("Keep the CI pipeline we have and add a nightly run").join(" ")
  expect(label.length).toBeGreaterThan(200)
  const [p, out] = prompter([label])
  expect(await p.choose("Plan", [label, "b"], "", true)).toBe(label)
  expect((sent(out)[0] as { options: string[] }).options[0]).toBe(label)
})

test("secret is asked without a default and stripped", async () => {
  const [p, out] = prompter([" sk-ant-sentinel-a7d93c10e5b2\n"])
  expect(await p.secret("API key")).toBe("sk-ant-sentinel-a7d93c10e5b2")
  expect(sent(out)).toEqual([{ type: "secret", question: "API key" }])
  expect(out.text).toBe('{"type":"secret","question":"API key"}\n')
})

test("say and step need no answer", () => {
  const [p, out] = prompter([])
  p.step(1, 5, "Model", "Why it matters")
  p.say("Saved")
  expect(sent(out)).toEqual([
    { type: "step", number: 1, total: 5, title: "Model", why: "Why it matters" },
    { type: "say", text: "Saved" },
  ])
  expect(out.text).toBe(
    '{"type":"step","number":1,"total":5,"title":"Model","why":"Why it matters"}\n{"type":"say","text":"Saved"}\n',
  )
})

test("a preset answer asks nothing", async () => {
  const [p, out] = prompter([], { "Which human are you?": "ngocbh" })
  expect(await p.ask("Which human are you?")).toBe("ngocbh")
  expect(out.text).toBe("")
})

test("stdin closing before an answer is an onboard error", async () => {
  const [p] = prompter([])
  const caught = await rejection(p.ask("Company"))
  expect(caught).toBeInstanceOf(OnboardError)
  expect(caught.message).toContain("stdin closed")
})

test("a stdin destroyed before an answer is an onboard error", async () => {
  const stdin = new PassThrough()
  const p = new JsonPrompter(output(), stdin)
  const asked = rejection(p.ask("Company"))
  stdin.destroy()
  const caught = await asked
  expect(caught).toBeInstanceOf(OnboardError)
  expect(caught.message).toContain("stdin closed")
})

test("a line that isnt an answer is an onboard error without its text", async () => {
  const p = new JsonPrompter(output(), Readable.from(["sk-ant-sentinel-a7d93c10e5b2\n"]))
  const caught = await rejection(p.secret("API key"))
  expect(caught).toBeInstanceOf(OnboardError)
  expect(caught.message).not.toContain("sentinel")
  expect(caught.cause).toBeUndefined()
})

test("read line leaves the rest of the stream for the next read and lets the process exit", async () => {
  const code = [
    `import { readLine } from ${JSON.stringify(PROMPTS)}`,
    "const first = await readLine(process.stdin)",
    "const second = await readLine(process.stdin)",
    "console.log(JSON.stringify([first, second]))",
  ].join("\n")
  const child = spawn(process.execPath, ["--no-install", "--no-env-file", "--config=/dev/null", "-e", code], {
    cwd: OFFICE,
    env: { PATH: process.env.PATH },
    stdio: ["pipe", "pipe", "pipe"],
  })
  try {
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    // "close" waits for the child's stdout to be read to the end; "exit" can come first.
    const exited = new Promise<number | null>((resolve) => child.on("close", (status) => resolve(status)))
    // One write holding both lines, stdin kept open, as the TUI does.
    child.stdin.write("a\nb\n")
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), 10_000)))
    const status = await Promise.race([exited, timeout])
    clearTimeout(timer)
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
    expect(JSON.parse(stdout)).toEqual(["a", "b"])
  } finally {
    child.kill("SIGKILL")
  }
}, 20_000)

test("an empty choice list is refused before anything is sent", async () => {
  const [p, out] = prompter(["a"])
  const caught = await rejection(p.choose("Q", []))
  expect(caught).toBeInstanceOf(Error)
  expect(out.text).toBe("")
})

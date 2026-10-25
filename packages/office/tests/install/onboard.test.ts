/** Onboarding this machine: the owner's defaults, the in-process model check, and the helpers it uses. */
import fs from "node:fs"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { expect, test } from "bun:test"
import { loadFlow } from "@ngocbh/yian"
import { Provider } from "../../src/chat/provider.ts"
import { writeCompany } from "../../src/company_template/index.ts"
import {
  modelProblem,
  type OnboardOptions,
  onboard,
  ownerDefaults,
  redact,
  runSetup,
  setupConnectionFile,
} from "../../src/install/onboard.ts"
import { OnboardError, TtyPrompter } from "../../src/install/prompts.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { fakeLlm } from "../chat/helpers.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"
import { makeHost, NO_LISTING, Runner, Script } from "./helpers.ts"

const KEY = "sk-test-0000000000000000"
const PROVIDER_JSON = '{"llm_config": {"provider": "openai"}}'

const OFFICE = fileURLToPath(new URL("../..", import.meta.url))
const ONBOARD = fileURLToPath(new URL("../../src/install/onboard.ts", import.meta.url))
const PROVIDER = fileURLToPath(new URL("../../src/chat/provider.ts", import.meta.url))
const FAKE_LLM = fileURLToPath(new URL("../../src/testing/fake_llm.ts", import.meta.url))

test("the owner defaults come from the login", () => {
  expect(ownerDefaults("ngocbh", "Hong Ngoc Bui,,,")).toEqual(["Hong Ngoc Bui", "ngocbh"])
  expect(ownerDefaults("Ngoc_Bui", "")).toEqual(["Ngoc_Bui", "ngoc-bui"])
})

/** A company at `home` made as `opencorp init` makes it, with `handle` as CEO and no device. */
async function company(home: string, handle = "me"): Promise<string> {
  const root = path.join(home, "company")
  await writeCompany(root, path.join(home, "office", "worktrees"), { company: "Acme", owner: { handle, name: "Me" } })
  return root
}

/** A fresh provider on stdin. */
function provider(): Readable {
  return Readable.from([PROVIDER_JSON])
}

/** The options every test passes: listers and a model check that reach no provider, git without the user's
 *  config, and a stand-in host, so no test can reach the real service tools. */
function base(dir: string): OnboardOptions {
  return {
    listers: NO_LISTING,
    checkModel: async () => null,
    environ: gitEnv(process.env),
    host: makeHost(dir, new Runner()),
  }
}

/** A writable that keeps what is written; not a terminal. */
function collector(): { stream: Writable; text: () => string } {
  let text = ""
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      text += chunk.toString()
      done()
    },
  })
  return { stream, text: () => text }
}

/** A terminal prompter with no one to ask, reading from an empty pipe. */
function nonInteractive(): TtyPrompter {
  return new TtyPrompter({ interactive: false, input: Readable.from([""]), output: collector().stream, env: {} })
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

test("lint errors stop onboarding before anything runs", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const root = await company(home)
  fs.writeFileSync(path.join(root, "company.yaml"), "name: Acme\nceo: nobody\n")
  const run = new Runner()
  const error = await rejection(onboard(home, new Script(), { ...base(dir), host: makeHost(dir, run) }))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("company.unknown_ceo")
  expect(run.calls).toEqual([])
  expect(fs.existsSync(path.join(home, "office", "install.json"))).toBe(false)
  expect(fs.existsSync(setupConnectionFile(path.join(home, "office")))).toBe(false)
})

test("an existing company without an identity suggests login", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await company(home)
  const ask = new Script()
  await onboard(home, ask, {
    ...base(dir),
    stdin: provider(),
    host: makeHost(dir, new Runner(), { answers: async () => true }),
  })
  expect(ask.seen).toContain("This device has no identity yet; run `opencorp login` to use opencorp from it.")
  expect(fs.existsSync(path.join(home, "identity.json"))).toBe(false)
  expect(ask.seen.filter((line) => line.startsWith("Step "))).toEqual([
    "Step 1 of 4: Company",
    "Step 2 of 4: This device",
    "Step 3 of 4: Model",
    "Step 4 of 4: Office",
  ])
})

test("onboard saves no provider whose model doesnt answer", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await company(home)
  const error = await rejection(
    onboard(home, new Script(), {
      ...base(dir),
      checkModel: async () => "Connection error",
      stdin: provider(),
      host: makeHost(dir, new Runner(), { answers: async () => true }),
    }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toBe("the model didn't answer: Connection error")
  expect(fs.existsSync(setupConnectionFile(path.join(home, "office")))).toBe(false)
})

test("an office started by hand is left alone", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  await company(home)
  const ask = new Script()
  await onboard(home, ask, {
    ...base(dir),
    stdin: provider(),
    host: makeHost(dir, new Runner(), { answers: async () => true }),
  })
  expect(ask.seen.some((line) => line.includes("not started by a service"))).toBe(true)
})

test("a running office is not topped up behind its back", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  const root = await company(home)
  fs.unlinkSync(path.join(root, "shared/flows/side_chat.yaml"))
  fs.unlinkSync(path.join(root, "shared/flows/profile_manager.yaml"))
  git(root, "commit", "-qam", "drop two flows")
  const head = git(root, "rev-parse", "HEAD")
  const ask = new Script()
  await onboard(home, ask, {
    ...base(dir),
    stdin: provider(),
    host: makeHost(dir, new Runner(), { answers: async () => true }),
  })
  expect(ask.seen.join("\n")).toContain(
    "The office is running; stop it and run `opencorp onboard` again to add 2 template files.",
  )
  expect(fs.existsSync(path.join(root, "shared/flows/side_chat.yaml"))).toBe(false)
  expect(git(root, "rev-parse", "HEAD")).toBe(head)
})

test("a running office without a company is not written to", async () => {
  const dir = tempDir()
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script(), {
      ...base(dir),
      host: makeHost(dir, new Runner(), { answers: async () => true }),
    }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(/running, but .* has no company yet/)
  expect(fs.existsSync(path.join(dir, "home", "company"))).toBe(false)
})

/** Onboards with auto, then again from a shell with another env; returns the second run's commands. */
async function onboardTwice(dir: string, platform: NodeJS.Platform, started: string[][]): Promise<string[][]> {
  const home = path.join(dir, "home")
  await company(home)
  const run = new Runner()
  const host = makeHost(dir, run, {
    platform,
    answers: async () => run.calls.some((call) => started.some((s) => isDeepStrictEqual(call.slice(0, 3), s))),
  })
  await onboard(home, new Script(), {
    ...base(dir),
    stdin: provider(),
    host,
    environ: { PATH: "/usr/bin", LC_TERMINAL_VERSION: "3.5.0" },
  })
  const first = run.calls.length
  await onboard(home, new Script(), {
    ...base(dir),
    stdin: provider(),
    host,
    environ: { PATH: "/opt/homebrew/bin:/usr/bin", LC_TERMINAL_VERSION: "3.6.0" },
  })
  return run.calls.slice(first)
}

test("a second onboard from another shell leaves a running launch agent alone", async () => {
  const again = await onboardTwice(tempDir(), "darwin", [["launchctl", "bootstrap", "gui/501"]])
  expect(again.map((call) => call[1])).toEqual(["print"])
})

test("a second onboard from another shell leaves a running systemd unit alone", async () => {
  const again = await onboardTwice(tempDir(), "linux", [["systemctl", "--user", "restart"]])
  expect(again.map((call) => call[2])).toEqual(["is-enabled"])
})

test.each([
  ["empty", () => new Script([""])],
  ["non-interactive", nonInteractive],
] as const)("no company and no repo suggests init [%s]", async (_name, prompter) => {
  const dir = tempDir()
  const error = await rejection(onboard(path.join(dir, "home"), prompter(), base(dir)))
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toMatch(
    /no company at .*; run `opencorp init` to create one, or `opencorp onboard --from URL`/,
  )
  expect(fs.existsSync(path.join(dir, "home", "company"))).toBe(false)
})

test("a company init left unfinished is not cloned over", async () => {
  const dir = tempDir()
  const root = path.join(dir, "home", "company")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, "company.yaml"), 'name: "Acme"\nceo: "me"\n')
  const error = await rejection(
    onboard(path.join(dir, "home"), new Script(), { ...base(dir), source: path.join(dir, "x.git") }),
  )
  expect(error).toBeInstanceOf(OnboardError)
  expect(error.message).toContain("run `opencorp init` to finish it")
  expect(fs.readdirSync(root)).toEqual(["company.yaml"])
})

test("an existing home is made private", async () => {
  const dir = tempDir()
  const home = path.join(dir, "home")
  fs.mkdirSync(home)
  fs.chmodSync(home, 0o755)
  const error = await rejection(onboard(home, new Script([""]), base(dir)))
  expect(error.message).toContain("no company at")
  expect(fs.statSync(home).mode & 0o777).toBe(0o700)
  expect(fs.statSync(path.join(home, "office")).mode & 0o777).toBe(0o700)
})

test("a model that answers has no problem", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  expect(await modelProblem(Provider.parse({ llm_config: LLM_CONFIG, env: fake.env() }))).toBeNull()
  expect(fake.requests()).toHaveLength(1)
})

test("a model that fails says why without the key", async () => {
  const fake = await fakeLlm()
  fake.script({ error: 401 })
  const problem = await modelProblem(Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: KEY }, env: fake.env() }))
  expect(problem).toBeTruthy()
  expect(problem).not.toContain(KEY)
})

test("a setup run failure never shows the key or url credentials", async () => {
  const flow = await loadFlow(
    "id: fail\nname: fail\ninput:\n  text: !str\noutput: str\nkind: code\ncode: |\n  throw new Error(inputs.text)\n",
    { sourceLabel: "fail" },
  )
  const text = `bad key ${KEY} for https://user:hunter2@example.com/v1.`
  const { message } = await runSetup(
    flow,
    { text },
    Provider.parse({ llm_config: { ...LLM_CONFIG, api_key: KEY } }),
    { tools: {} },
  )
  expect(message).toContain("bad key *** for https://***@example.com/v1")
  expect(message).not.toContain(KEY)
  expect(message).not.toContain("hunter2")
  expect(message!.endsWith(".")).toBe(false)
})

test("the unknown model warning stays off the terminal", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  const seen: string[] = []
  const listener = (warning: Error) => seen.push(warning.message)
  process.on("warning", listener)
  try {
    const provider = Provider.parse({
      llm_config: {
        // A Chat Completions vendor with a model list (openai's key route goes to /v1/responses, which the fake
        // doesn't serve).
        provider: "deepseek",
        base_url: `${fake.baseUrl}/v1`,
        api_key: KEY,
        // Unique: yian warns once per text in a process, and test files share one.
        model: `unlisted-${crypto.randomUUID()}`,
      },
    })
    expect(await modelProblem(provider)).toBeNull()
    // A warning is emitted on the next tick.
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off("warning", listener)
  }
  expect(seen.filter((message) => message.includes("known model list"))).toEqual([])
})

// No test changes process.env, so the variable sits in a child's environment.
test("a setup run sees only the office workers env and the providers", async () => {
  const fake = await fakeLlm()
  fake.script({ content: "OK" })
  const code = [
    `import { Provider } from ${JSON.stringify(PROVIDER)}`,
    `import { modelProblem } from ${JSON.stringify(ONBOARD)}`,
    `import { LLM_CONFIG } from ${JSON.stringify(FAKE_LLM)}`,
    // No retries, so the refused connection fails at once; the provider's env does reach the run.
    'const provider = Provider.parse({ llm_config: LLM_CONFIG, env: { YIAN_MODEL_RETRIES: "0" } })',
    "console.log(JSON.stringify(await modelProblem(provider)))",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", "-e", code], {
    cwd: OFFICE,
    env: { PATH: process.env.PATH, VLLM_BASE_URL: `${fake.baseUrl}/v1` },
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), 20_000)))
    const status = await Promise.race([child.exited, timeout])
    clearTimeout(timer)
    // Killed before the output is read: a child that timed out would keep its pipes open.
    child.kill("SIGKILL")
    const stderr = await new Response(child.stderr).text()
    expect(status, stderr).toBe(0)
    const problem: unknown = JSON.parse(await new Response(child.stdout).text())
    expect(typeof problem === "string" && problem.length > 0, stderr).toBe(true)
    expect(fake.requests()).toEqual([])
  } finally {
    child.kill("SIGKILL")
  }
}, 30_000)

test("redact takes the user and password out of urls", () => {
  expect(redact("https://user:pw@h/x and ssh://t@h")).toBe("https://***@h/x and ssh://***@h")
})

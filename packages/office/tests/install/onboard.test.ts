/** Onboarding this machine: the owner's defaults, the in-process model check, and the helpers it uses. */
import { fileURLToPath } from "node:url"
import { expect, test } from "bun:test"
import { loadFlow } from "@ngocbh/yian"
import { Provider } from "../../src/chat/provider.ts"
import { modelProblem, ownerDefaults, redact, runSetup } from "../../src/install/onboard.ts"
import { LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { fakeLlm } from "../chat/helpers.ts"

const KEY = "sk-test-0000000000000000"

const OFFICE = fileURLToPath(new URL("../..", import.meta.url))
const ONBOARD = fileURLToPath(new URL("../../src/install/onboard.ts", import.meta.url))
const PROVIDER = fileURLToPath(new URL("../../src/chat/provider.ts", import.meta.url))
const FAKE_LLM = fileURLToPath(new URL("../../src/testing/fake_llm.ts", import.meta.url))

test("the owner defaults come from the login", () => {
  expect(ownerDefaults("ngocbh", "Hong Ngoc Bui,,,")).toEqual(["Hong Ngoc Bui", "ngocbh"])
  expect(ownerDefaults("Ngoc_Bui", "")).toEqual(["Ngoc_Bui", "ngoc-bui"])
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

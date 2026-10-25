/** Chat test helpers (Python's `tests/chat/conftest.py`): the fake LLM, the chat flow and OpenAI's
 *  sign-in, faked. */
import { onTestFinished } from "bun:test"
import fs from "node:fs"
import { HttpResponse } from "@ngocbh/yian/llm_clients"
import type { Scheduler } from "@ngocbh/yian/platform"
import { FakeLLM } from "../../src/testing/fake_llm.ts"

/** The template's chat flow, as a hire's main points at it. */
export const CHAT_FLOW = fs.readFileSync(
  new URL("../../src/company_template/template/shared/flows/chat.yaml", import.meta.url),
  "utf8",
)

/** A started fake LLM, closed when the current test finishes. Call inside a test. */
export async function fakeLlm(): Promise<FakeLLM> {
  const fake = await FakeLLM.start()
  onTestFinished(() => fake.close())
  return fake
}

// OpenAI's device sign-in, faked: its replies and a token whose signature and refresh are fake secrets.

export const SIGNATURE = "fake-signature-6e2a90d4"
export const REFRESH = "fake-refresh-b81c5f37"

/** A token shaped like OpenAI's, naming `account`; its signature part is a fake secret. */
export function jwt(account = "account-test"): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: account } }
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${SIGNATURE}`
}

export const ACCESS = jwt()

export const USERCODE = new HttpResponse(200, { device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: 1n })
export const PENDING = new HttpResponse(403, { error: "pending" })
export const APPROVED = new HttpResponse(200, { authorization_code: "auth-code", code_verifier: "verifier" })
export const TOKENS = new HttpResponse(200, {
  access_token: ACCESS,
  refresh_token: REFRESH,
  id_token: ACCESS,
  expires_in: 3600n,
})
export const CATALOG = new HttpResponse(200, {
  models: [
    { slug: "gpt-5.5-codex", visibility: "list", priority: 2n },
    { slug: "gpt-5.5", visibility: "list", priority: 1n },
  ],
})

/** A scheduler that moves its clock by each sleep, giving way for ~5 real ms; `now` starts at real time, so a token's
 *  expiry stays real. A sleep of a minute or more (the login's deadline) only ends by its abort, so it never fires
 *  while a test holds a request. */
export function testScheduler(): Scheduler {
  let slept = 0
  return {
    now: () => Date.now() + slept,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        let timer: ReturnType<typeof setTimeout> | undefined
        const abort = () => {
          clearTimeout(timer)
          reject(signal!.reason)
        }
        signal?.addEventListener("abort", abort, { once: true })
        if (ms < 60_000) {
          timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort)
            slept += ms
            resolve()
          }, 5)
        }
      }),
  }
}

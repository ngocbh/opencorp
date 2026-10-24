/** Chat test helpers (Python's `tests/chat/conftest.py`): the fake LLM and the chat flow. */
import { onTestFinished } from "bun:test"
import fs from "node:fs"
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

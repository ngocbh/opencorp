/** Chat test helpers (Python's `tests/chat/conftest.py`): the fake LLM and the chat flow. */
import { onTestFinished } from "bun:test"
import { FakeLLM } from "../../src/testing/fake_llm.ts"
import { MAIN } from "../company/helpers.ts"

/** The chat flow a hire's main points at. A stand-in for the template's shared/flows/chat.yaml until the TS
 *  template lands: Python's has a Python CODE node TS yian can't load. */
export const CHAT_FLOW = MAIN

/** A started fake LLM, closed when the current test finishes. Call inside a test. */
export async function fakeLlm(): Promise<FakeLLM> {
  const fake = await FakeLLM.start()
  onTestFinished(() => fake.close())
  return fake
}

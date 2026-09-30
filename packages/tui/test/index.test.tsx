import { expect, test } from "bun:test"
import { defaultSocket, run } from "../src"

test("exports the application lifecycle and the default office socket", () => {
  expect(typeof run).toBe("function")
  expect(defaultSocket()).toBe(`${process.env.AGENT_CORP_HOME}/office/office.sock`)
})

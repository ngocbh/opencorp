import { afterEach, expect, test } from "bun:test"
import os from "node:os"
import { defaultSocket } from "../../src/office/paths"

const saved = process.env.AGENT_CORP_HOME
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_CORP_HOME
  else process.env.AGENT_CORP_HOME = saved
})

test("the socket lives under AGENT_CORP_HOME, defaulting to ~/.agent-corp", () => {
  process.env.AGENT_CORP_HOME = "/tmp/ach"
  expect(defaultSocket()).toBe("/tmp/ach/office/office.sock")
  delete process.env.AGENT_CORP_HOME
  expect(defaultSocket()).toBe(`${os.homedir()}/.agent-corp/office/office.sock`)
})

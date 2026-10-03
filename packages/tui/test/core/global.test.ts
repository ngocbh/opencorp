import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { Global } from "../../src/core/global"

test("tests keep TUI state out of the real home directory", () => {
  const home = process.env.AGENT_CORP_HOME
  expect(home).toBeString()
  expect(home!.startsWith(path.join(os.homedir(), ".agent-corp"))).toBe(false)
  expect(Global.Path.state).toBe(path.join(home!, "tui", "state"))
})

test("TUI state follows a ~/ AGENT_CORP_HOME the way the office paths do", () => {
  const saved = process.env.AGENT_CORP_HOME
  process.env.AGENT_CORP_HOME = "~/offices/acme"
  try {
    expect(Global.Path.state).toBe(path.join(os.homedir(), "offices", "acme", "tui", "state"))
  } finally {
    process.env.AGENT_CORP_HOME = saved
  }
})

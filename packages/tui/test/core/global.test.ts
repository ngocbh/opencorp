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

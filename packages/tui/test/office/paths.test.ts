import { afterEach, expect, test } from "bun:test"
import os from "node:os"
import { agentCorpHome, defaultSocket } from "../../src/office/paths"

const saved = process.env.AC_HOME
afterEach(() => {
  if (saved === undefined) delete process.env.AC_HOME
  else process.env.AC_HOME = saved
})

test("the socket lives under AC_HOME, defaulting to ~/.agent-corp", () => {
  process.env.AC_HOME = "/tmp/ach"
  expect(defaultSocket()).toBe("/tmp/ach/office/office.sock")
  delete process.env.AC_HOME
  expect(defaultSocket()).toBe(`${os.homedir()}/.agent-corp/office/office.sock`)
})

test("an empty AC_HOME means the default, and a leading ~/ is the home directory, as in Python", () => {
  process.env.AC_HOME = ""
  expect(agentCorpHome()).toBe(`${os.homedir()}/.agent-corp`)
  process.env.AC_HOME = "~/offices/acme"
  expect(agentCorpHome()).toBe(`${os.homedir()}/offices/acme`)
  process.env.AC_HOME = "~"
  expect(agentCorpHome()).toBe(os.homedir())
})

import { afterEach, expect, test } from "bun:test"
import os from "node:os"
import { opencorpHome, defaultSocket } from "../src/paths"

const saved = process.env.OPENCORP_HOME
afterEach(() => {
  if (saved === undefined) delete process.env.OPENCORP_HOME
  else process.env.OPENCORP_HOME = saved
})

test("the socket lives under OPENCORP_HOME, defaulting to ~/.opencorp", () => {
  process.env.OPENCORP_HOME = "/tmp/ach"
  expect(defaultSocket()).toBe("/tmp/ach/office/office.sock")
  delete process.env.OPENCORP_HOME
  expect(defaultSocket()).toBe(`${os.homedir()}/.opencorp/office/office.sock`)
})

test("an empty OPENCORP_HOME means the default, and a leading ~/ is the home directory, as in Python", () => {
  process.env.OPENCORP_HOME = ""
  expect(opencorpHome()).toBe(`${os.homedir()}/.opencorp`)
  process.env.OPENCORP_HOME = "~/offices/acme"
  expect(opencorpHome()).toBe(`${os.homedir()}/offices/acme`)
  process.env.OPENCORP_HOME = "~"
  expect(opencorpHome()).toBe(os.homedir())
})

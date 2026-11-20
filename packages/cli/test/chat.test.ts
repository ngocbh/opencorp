import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { homeFlag, installHooks, localChat } from "../src/chat"

const CHAT = path.join(import.meta.dir, "../src/chat.ts")
/** A static import or re-export of a value, which would load before any chat starts. */
const IMPORT = /^\s*import\b(?!\s+type\b)(?!\s*[(.])/m
const REEXPORT = /^\s*export\s*(?!type\b)(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']/m

test("install's hooks give a chat only where the TUI can draw, and load no TUI", () => {
  expect(installHooks(() => true, ["install", "init"])).toEqual({ chat: localChat })
  expect(installHooks(() => false, ["install", "init"])).toEqual({})
  expect(installHooks(() => false, ["install", "init", "--home", "/tmp/h"])).toEqual({})
  // With --home, the chat is one whose TUI keeps its state there (init_tty.test.ts shows it).
  const chat = installHooks(() => true, ["install", "init", "--home", "/tmp/h"]).chat
  expect(chat).toBeFunction()
  expect(chat).not.toBe(localChat)
  // The install child loads this file for every setup command: it imports only types, so nothing of the TUI's, the
  // client's or the CLI's loads until a chat starts.
  const text = fs.readFileSync(CHAT, "utf8")
  expect(IMPORT.test(text)).toBe(false)
  expect(REEXPORT.test(text)).toBe(false)
  for (const module of ["@opencorp/tui", "@opentui/solid/bun-plugin", "@opencorp/office/server/local"]) {
    expect(text).toContain(`import("${module}")`)
  }
})

test("the home the install takes is its last --home, either form; an empty one is kept, for the install to refuse", () => {
  expect(homeFlag(["install", "init"])).toBeUndefined()
  expect(homeFlag(["install", "init", "--home", "/a", "--home=/b"])).toBe("/b")
  expect(homeFlag(["install", "init", "--home=/b", "--home", "/a"])).toBe("/a")
  expect(homeFlag(["install", "init", "--home="])).toBe("")
  expect(homeFlag(["install", "init", "--home"])).toBeUndefined()
})

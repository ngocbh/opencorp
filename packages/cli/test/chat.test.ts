import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { installHooks, localChat } from "../src/chat"

const CHAT = path.join(import.meta.dir, "../src/chat.ts")
/** A static import or re-export of a value, which would load before any chat starts. */
const IMPORT = /^\s*import\b(?!\s+type\b)(?!\s*[(.])/m
const REEXPORT = /^\s*export\s*(?!type\b)(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']/m

test("install's hooks give a chat only where the TUI can draw, and load no TUI", () => {
  expect(installHooks(() => true)).toEqual({ chat: localChat })
  expect(installHooks(() => false)).toEqual({})
  // The install child loads this file for every setup command: it imports only types, so nothing of the TUI's, the
  // client's or the CLI's loads until a chat starts.
  const text = fs.readFileSync(CHAT, "utf8")
  expect(IMPORT.test(text)).toBe(false)
  expect(REEXPORT.test(text)).toBe(false)
  for (const module of ["@opencorp/tui", "@opentui/solid/bun-plugin", "@opencorp/office/server/local"]) {
    expect(text).toContain(`import("${module}")`)
  }
})

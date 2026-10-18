// Loaded once before the test files: TUI state (kv.json, prompt history, themes) goes to a
// throwaway directory instead of the developer's ~/.opencorp.
import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const home = mkdtempSync(path.join(os.tmpdir(), "opencorp-tui-test-"))
process.env.OPENCORP_HOME = home
// A preload's afterAll runs once, after every test file.
afterAll(() => rmSync(home, { recursive: true, force: true }))

import { expect, test } from "bun:test"
import path from "node:path"

const repo = path.join(import.meta.dir, "..", "..", "..")

// The upstream name stays only where the license and the fork's record need it, and in the alias
// that keeps a theme chosen under the old default name loading.
const RECORD = new Set(["packages/tui/LICENSE", "packages/tui/UPSTREAM", "packages/tui/INVENTORY.md", "packages/tui/test/upstream-name.test.ts"])
const ALIAS = 'packages/tui/src/theme/index.ts:export const RENAMED_THEMES: Record<string, string> = { opencode: "opencorp", agentcorp: "opencorp" }'

test("nothing outside the fork's record says OpenCode", () => {
  const grep = Bun.spawnSync(["git", "grep", "-i", "opencode", "--", "packages"], { cwd: repo })
  const hits = grep.stdout
    .toString()
    .split("\n")
    .filter((line) => line && !RECORD.has(line.split(":")[0]) && line !== ALIAS)
  expect(hits).toEqual([])
})

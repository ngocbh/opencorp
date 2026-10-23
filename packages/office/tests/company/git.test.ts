/** The office's clone of the company repo (Python's `tests/company/test_git.py`). */
import fs from "node:fs"
import path from "node:path"
import { expect, setDefaultTimeout, test } from "bun:test"
import { company, git, gitEnv } from "./helpers.ts"

setDefaultTimeout(30_000)

test("the test helpers git reads only the repos own config and runs no hooks", () => {
  expect(
    gitEnv({ PATH: "/usr/bin:/bin", HOME: "/h", GIT_DIR: "/x", GIT_CONFIG_GLOBAL: "/g", GIT_AUTHOR_NAME: "a" }),
  ).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" })

  const root = company()
  const origins = git(root, "config", "--list", "--show-origin").split("\n")
  expect(origins.filter((line) => !/^(file:\.git\/config|command line:)\t/.test(line))).toEqual([])

  for (const hook of ["pre-commit", "commit-msg"]) {
    fs.writeFileSync(path.join(root, ".git/hooks", hook), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
  }
  git(root, "commit", "-q", "--allow-empty", "-m", "x")
  expect(git(root, "log", "-1", "--format=%s")).toBe("x")

  expect(git(root, "config", "core.excludesFile")).toBe("/dev/null")
  expect(git(root, "config", "core.attributesFile")).toBe("/dev/null")
})

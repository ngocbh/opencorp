/** Build throwaway company repos for tests (Python's `tests/company/conftest.py`). */
import { spawnSync, type SpawnSyncOptions } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { stringify } from "yaml"
import { tempDir } from "../helpers.ts"

/** The inputs the office passes a main flow, which it must declare. */
export const MAIN_INPUTS = `typedefs:
  Person:
    name: str
    handle: str
    title: str
    company: str
    reports_to: str
input:
  person: !Person
  talking_to: !str
`

export const CHAT = `id: chat
name: chat
nodes:
  ask:
    kind: human_input
    prompt: "you> "
    output: str
  reply:
    kind: agent
    input:
      message: \${ask.output}
    output: str
    prompt: "\${message}"
output: \${reply.output}
`

/** `CHAT` as a person's main flow. */
export const MAIN = CHAT.replace("name: chat\n", "name: chat\n" + MAIN_INPUTS)

/** `base` without `GIT_*` variables or unset values, and without the user's or system git config. */
export function gitEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull }
}

/** Runs git in `root` as `t <t@t>` with no hooks and no excludes or attributes files outside the
 *  repo; returns stdout trimmed and throws on a failure. */
function run(root: string, args: string[], options: SpawnSyncOptions): string {
  const result = spawnSync(
    "git",
    [
      "-C", root,
      "-c", "user.name=t",
      "-c", "user.email=t@t",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.excludesFile=/dev/null",
      "-c", "core.attributesFile=/dev/null",
      ...args,
    ],
    { ...options, env: gitEnv(), encoding: "utf8" },
  )
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} exited ${result.status}: ${result.stderr}`)
  return String(result.stdout).trim()
}

/** Runs git in `root` with stdin ignored; returns stdout trimmed. */
export function git(root: string, ...args: string[]): string {
  return run(root, args, { stdio: ["ignore", "pipe", "pipe"] })
}

/** Runs git in `root` with `input` on stdin, for paths that argv can't carry; returns stdout trimmed. */
export function gitInput(root: string, input: Uint8Array, ...args: string[]): string {
  return run(root, args, { input, stdio: ["pipe", "pipe", "pipe"] })
}

/** The files of the base test company, by repo path; objects are written as YAML. */
export function baseFiles(): Record<string, unknown> {
  return {
    "company.yaml": { name: "test-corp", ceo: "ngocbh", defaults: { cost_cap_usd: 5, max_turns: 500 } },
    "people/ngocbh/person.yaml": { handle: "ngocbh", name: "Hong Ngoc Bui", kind: "human", title: "CEO", manager: null },
    "people/minh/person.yaml": {
      handle: "minh",
      name: "Minh",
      kind: "agent",
      title: "Engineer",
      manager: "ngocbh",
      groups: ["eng"],
      main: "../../shared/flows/chat.yaml",
      skills: ["code-review"],
      harnesses: ["composer"],
      harness_policy: { sandbox: "workspace-write", network: false },
    },
    "people/minh/profile.md": "# Minh, Engineer\n",
    "shared/flows/chat.yaml": MAIN,
    "shared/skills/code-review/SKILL.md": "---\nname: code-review\ndescription: Review code.\n---\nReview.\n",
    "groups/eng.yaml": { id: "eng", name: "Engineering", parent: null, head: null },
    "assets/fake.yaml": {
      id: "fake",
      kind: "fake",
      tools: { echo: {} },
      grants: [{ who: "group:eng", can: ["echo"] }],
      secrets: [],
    },
  }
}

/** Writes `files` under `root` (bytes as is, strings as UTF-8, anything else as YAML) and commits
 *  them as the first commit of a new repo on `main`; returns `root`. */
export function writeRepo(root: string, files: Record<string, unknown>): string {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (content instanceof Uint8Array) fs.writeFileSync(file, content)
    else fs.writeFileSync(file, typeof content === "string" ? content : stringify(content))
  }
  git(root, "init", "-q", "-b", "main")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "init")
  return root
}

/** A committed base company repo in `dir`'s `company` folder. Call inside a test. */
export function company(dir = tempDir()): string {
  return writeRepo(path.join(dir, "company"), baseFiles())
}

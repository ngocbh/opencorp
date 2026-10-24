/** Build throwaway company repos for tests (Python's `tests/company/conftest.py`). */
import { spawnSync } from "node:child_process"
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
 *  repo, with `input` on stdin (else stdin ignored); returns stdout trimmed and throws on a failure. */
function run(root: string, args: string[], input?: Uint8Array): string {
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
    { input, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], env: gitEnv(), encoding: "utf8" },
  )
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.status ?? result.signal}: ${result.stderr}`)
  }
  return result.stdout.trim()
}

/** Runs git in `root` with stdin ignored; returns stdout trimmed. */
export function git(root: string, ...args: string[]): string {
  return run(root, args)
}

/** Runs git in `root` with `input` on stdin, for paths that argv can't carry; returns stdout trimmed. */
export function gitInput(root: string, input: Uint8Array, ...args: string[]): string {
  return run(root, args, input)
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

/** The base person file in `people/<folder>/` with `changes` applied. */
export function person(folder: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(baseFiles()[`people/${folder}/person.yaml`] as Record<string, unknown>), ...changes }
}

/** A committed repo in `dir`'s `company` folder: the base files with each override applied (`null`
 *  removes the file); returns its root. Call inside a test. */
export function makeCompany(overrides: Record<string, unknown> = {}, dir = tempDir()): string {
  const files = baseFiles()
  for (const [rel, content] of Object.entries(overrides)) {
    if (content === null) delete files[rel]
    else files[rel] = content
  }
  return writeRepo(path.join(dir, "company"), files)
}

/** A `git` script in `dir` that logs each call (whether its stdin is `/dev/null`, then its args) to
 *  `dir/calls` and runs the real git. */
export function recordingGit(dir: string) {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
  const script = path.join(dir, "git")
  const log = path.join(dir, "calls")
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      "if [ -c /dev/stdin ] && [ ! -t 0 ]; then s=null; else s=other; fi",
      `{ printf '%s' "$s"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> ${JSON.stringify(log)}`,
      `exec ${JSON.stringify(real)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return {
    git: script,
    calls(): { stdin: string; args: string[] }[] {
      if (!fs.existsSync(log)) return []
      return fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [stdin, ...args] = line.split("\t")
          return { stdin: stdin!, args }
        })
    },
  }
}

/** A child flow `echo` that a parent calls through `uses:`. */
export const CHILD = "id: echo\nname: echo\ninput:\n  text: !str\noutput: str\nkind: agent\nprompt: \"${text}\"\n"

/** A flow `chat` that imports `ref` as `echo` and calls it. */
export function parentFlow(ref: string): string {
  return (
    "id: chat\nname: chat\nuses:\n  echo: " + ref + "\nnodes:\n  ask:\n    kind: human_input\n" +
    "    prompt: \"you> \"\n    output: str\n  reply:\n    kind: call\n    call: echo\n" +
    "    input:\n      text: ${ask.output}\noutput: ${reply.output}\n"
  )
}

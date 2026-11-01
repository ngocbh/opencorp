/** Build throwaway company repos for tests (Python's `tests/company/conftest.py`). */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { stringify } from "yaml"
import { tempDir } from "../helpers.ts"

/** The input block a main chat declares: what the office passes a main flow. */
export const MAIN_INPUTS = `typedefs:
  Person:
    name: str
    handle: str
    title: str
    company: str
    reports_to: str
input:
  messages: !Inbox(Message)
  person: !Person
  talking_to: !str
  summary: !str
  history: !list(list(Message))
  turns: !int
  max_turns: !int
`

export const CHAT = `id: chat
name: chat
nodes:
  ask:
    kind: tool
    tool_id: ask
    input:
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

/** A minimal chat-shaped main flow: a LOOP `chat` over a `turn` whose `reply` steers from `messages`. */
export const MAIN = `id: chat
name: chat
${MAIN_INPUTS}defs:
  turn:
    input:
      messages: !Inbox(Message)
      closed: !bool
      turns: !int
      max_turns: !int
    nodes:
      heard:
        kind: tool
        tool_id: take
        input:
          from: \${input.messages}
          take: all
      reply:
        kind: agent
        steer_inbox: \${input.messages}
        input:
          said: \${heard.output.events}
        output: Optional(str)
        prompt:
          - \${said}
    output:
      closed: \${heard.output.closed}
      turns: \${input.turns + 1}
      max_turns: \${input.max_turns}
nodes:
  chat:
    kind: loop
    call: turn
    input:
      messages: \${input.messages}
      closed: false
      turns: \${input.turns}
      max_turns: \${input.max_turns}
    while: not closed and turns < max_turns
output: \${chat.output.turns}
`

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

/** Shell for a stub git to run instead of answering: each way a git call can fail. */
export const GIT_FAILURES = [
  "echo 'fatal: loose object is corrupt' >&2; exit 128",
  "echo 'error: unable to open loose object: Permission denied' >&2; exit 1",
  "kill -KILL $$",
  "exit 0",
]

/** A `git` script in `dir` that runs the shell `failure` instead of git for a call with an argument
 *  containing `match`, and the real git for every other call; returns its path. */
export function failingGit(dir: string, match: string, failure: string): string {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
  const script = path.join(dir, "failing-git")
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `for a in "$@"; do case "$a" in *${JSON.stringify(match)}*) ${failure};; esac; done`,
      `exec ${JSON.stringify(real)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return script
}

/** A child flow `echo` that a parent calls through `uses:`. */
export const CHILD = "id: echo\nname: echo\ninput:\n  text: !str\noutput: str\nkind: agent\nprompt: \"${text}\"\n"

/** A flow `chat` that imports `ref` as `echo` and calls it. */
export function parentFlow(ref: string): string {
  return (
    "id: chat\nname: chat\nuses:\n  echo: " + ref + "\nnodes:\n  ask:\n    kind: tool\n    tool_id: ask\n" +
    "    input:\n      prompt: \"you> \"\n    output: str\n  reply:\n    kind: call\n    call: echo\n" +
    "    input:\n      text: ${ask.output}\noutput: ${reply.output}\n"
  )
}

/** A flow `id` calling each of `refs` through the `uses:` aliases a0, a1, ...; its output is a0's. */
export function usesFlow(id: string, refs: string[]): string {
  const uses = refs.map((ref, i) => `  a${i}: ${ref}\n`).join("")
  const nodes = refs.map((_, i) => `  x${i}:\n    kind: call\n    call: a${i}\n`).join("")
  return `id: ${id}\nname: ${id}\nuses:\n${uses}nodes:\n${nodes}output: \${x0.output}\n`
}

/** A leaf flow `id` with no inputs. */
export function leafFlow(id: string): string {
  return `id: ${id}\nname: ${id}\nnodes:\n  v: !str leaf\noutput: \${v.output}\n`
}

/** Runs git in `root` as `git` does, but returns the exit status instead of throwing on a failure. */
export function gitStatus(root: string, ...args: string[]): number {
  try {
    run(root, args)
    return 0
  } catch (error) {
    const status = /exited (\d+)/.exec((error as Error).message)
    if (status === null) throw error
    return Number(status[1])
  }
}

/** Writes `text` to `rel` in `root` and commits it with `subject`. */
function commitText(root: string, rel: string, text: string, subject: string): void {
  fs.writeFileSync(path.join(root, rel), text)
  git(root, "add", "--", rel)
  git(root, "commit", "-q", "-m", subject)
}

/** A branch `side` and the current branch that each change `rel` in `root` differently, the current branch
 *  checked out. */
function divergedOn(root: string, rel: string): void {
  const branch = git(root, "branch", "--show-current")
  git(root, "checkout", "-q", "-b", "side")
  commitText(root, rel, "side\n", "side")
  git(root, "checkout", "-q", branch)
  commitText(root, rel, `${branch}\n`, branch)
}

/** Leaves `root` mid-merge, `rel` conflicted: MERGE_HEAD set and `rel` unmerged (UU). */
export function startMerge(root: string, rel: string): void {
  divergedOn(root, rel)
  if (gitStatus(root, "merge", "-q", "side") !== 1) throw new Error("the merge did not stop on a conflict")
}

/** Leaves `root` mid-rebase, stopped by a failed `--exec`: `rebase-merge/` and no unmerged path. */
export function startRebaseStop(root: string): void {
  commitText(root, "rebase.txt", "rebase\n", "to rebase")
  if (gitStatus(root, "rebase", "-q", "--exec", "false", "HEAD~1") === 0) throw new Error("the rebase did not stop")
}

/** Leaves `root` mid cherry-pick, `rel` conflicted: CHERRY_PICK_HEAD set. */
export function startCherryPick(root: string, rel: string): void {
  divergedOn(root, rel)
  if (gitStatus(root, "cherry-pick", "side") === 0) throw new Error("the cherry-pick did not stop")
}

/** Leaves `root` mid-revert, `rel` conflicted: REVERT_HEAD set. */
export function startRevert(root: string, rel: string): void {
  commitText(root, rel, "first\n", "first")
  commitText(root, rel, "second\n", "second")
  if (gitStatus(root, "revert", "--no-edit", "HEAD~1") === 0) throw new Error("the revert did not stop")
}

/** Leaves `root` with a cherry-pick of two commits stopped after the first, whose conflict on `rel` was
 *  resolved and committed by hand: `sequencer/` left, no CHERRY_PICK_HEAD. */
export function sequencerOnly(root: string, rel: string): void {
  divergedOn(root, rel)
  git(root, "checkout", "-q", "side")
  commitText(root, "side.txt", "side\n", "side two")
  git(root, "checkout", "-q", "-")
  if (gitStatus(root, "cherry-pick", "side~1", "side") === 0) throw new Error("the cherry-pick did not stop")
  fs.writeFileSync(path.join(root, rel), "resolved\n")
  git(root, "add", "--", rel)
  git(root, "commit", "-q", "--no-edit")
}

/** Leaves `rel` in `root` unmerged (UU) by a `stash pop` that conflicted: no MERGE_HEAD. */
export function stashPopConflict(root: string, rel: string): void {
  fs.writeFileSync(path.join(root, rel), "stashed\n")
  git(root, "stash", "-q")
  commitText(root, rel, "committed\n", "committed")
  if (gitStatus(root, "stash", "pop", "-q") === 0) throw new Error("the stash pop did not conflict")
}

/** A `git` script in `dir` that appends its env, then a `--` line, to `dir/env` and runs the real git. */
export function envGit(dir: string) {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
  const script = path.join(dir, "env-git")
  const log = path.join(dir, "env")
  fs.writeFileSync(
    script,
    ["#!/bin/sh", `{ env; echo --; } >> ${JSON.stringify(log)}`, `exec ${JSON.stringify(real)} "$@"`, ""].join("\n"),
    { mode: 0o755 },
  )
  return {
    git: script,
    /** Each call's env, by variable name. */
    envs(): Map<string, string>[] {
      if (!fs.existsSync(log)) return []
      return fs
        .readFileSync(log, "utf8")
        .split("--\n")
        .filter(Boolean)
        .map((block) => new Map(block.split("\n").filter(Boolean).map((line) => {
          const eq = line.indexOf("=")
          return [line.slice(0, eq), line.slice(eq + 1)] as [string, string]
        })))
    },
  }
}

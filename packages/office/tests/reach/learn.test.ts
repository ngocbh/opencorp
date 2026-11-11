/** Learning the path to HQ: the shell tool the agent runs commands with, save_access, which tests the whole chain
 *  before it saves, and a run of learn_hq with the fake model. */
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import { expect, setDefaultTimeout, test } from "bun:test"
import { ReportedToolError } from "@ngocbh/yian"
import {
  CANCEL,
  DONT_RUN,
  Learning,
  RUN,
  RUN_QUESTION,
  runShell,
  SAVE,
  SAVE_QUESTION,
  saveAccess,
  secretIn,
  shellResult,
  WHAT_SHOULD_CHANGE,
} from "../../src/reach/learn.ts"
import { BEFORE_LEARNING, beforeSaving } from "../../src/reach/risks.ts"
import type { ReachContext } from "../../src/reach/ssh.ts"
import type { FakeSshBehavior } from "../../src/testing/fake_ssh.ts"
import { Script } from "../install/helpers.ts"
import { fakeHome, reachCtx } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A learning run over a fake ssh: its context, the owner's `answers`, and what reached the owner's terminal. */
async function learning(
  answers: string[],
  { behavior, secrets = [], port = 49381, ...more }: { behavior?: FakeSshBehavior; secrets?: string[]; port?: number } & Partial<ReachContext> = {},
) {
  const { dir, fake } = fakeHome(behavior)
  const echoed: string[] = []
  const ctx = await reachCtx(dir, fake, { echo: (t) => void echoed.push(t), ...more })
  const prompter = new Script(answers)
  const stdin = new PassThrough()
  const state = new Learning(ctx, prompter, stdin, secrets, port)
  return { dir, fake, ctx, prompter, stdin, state, echoed }
}

/** What `promise` rejects with; fails the test when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("it resolved")
}

test("a command runs only once the owner approves it, and the model gets its exit, stdout and stderr", async () => {
  const { prompter, state, echoed } = await learning(["1"])
  const got = await runShell({ command: "echo out\necho err >&2; exit 4", why: "see what the login node says" }, state)
  expect(got).toBe("exit 4\nstdout:\nout\nstderr:\nerr")
  expect(prompter.seen).toEqual([
    "The model wants to run a command: see what the login node says",
    "  echo out",
    "  echo err >&2; exit 4",
    RUN_QUESTION,
  ])
  expect(prompter.offered).toEqual([[RUN, DONT_RUN]])
  expect(echoed.join("")).toContain("out\n")
  expect(echoed.join("")).toContain("err\n")
  expect(state.commands).toEqual([{ command: "echo out\necho err >&2; exit 4", code: 4 }])
})

test("a refused command doesn't run and the model is told why", async () => {
  const { dir, prompter, state } = await learning(["2", "not that host"])
  const marker = path.join(dir, "ran")
  const error = await rejection(runShell({ command: `touch '${marker}'`, why: "check" }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toBe("The owner didn't run it: not that host")
  expect(prompter.seen.at(-1)).toBe("Why not? (empty to skip)")
  expect(fs.existsSync(marker)).toBe(false)
  expect(state.commands).toEqual([{ command: `touch '${marker}'`, code: null }])
})

test("an unanswered approval doesn't run", async () => {
  const { dir, state } = await learning(["", ""])
  const marker = path.join(dir, "ran")
  const error = await rejection(runShell({ command: `touch '${marker}'`, why: "check" }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toBe("The owner didn't run it.")
  expect(fs.existsSync(marker)).toBe(false)
})

test("a command with control characters is refused unseen", async () => {
  const { prompter, state } = await learning([])
  for (const command of ["echo \x1b[2Jhi", "echo a\rb", "echo \x9bx"]) {
    const error = await rejection(runShell({ command, why: "x" }, state))
    expect(error).toBeInstanceOf(ReportedToolError)
    expect(error.message).toContain("control characters")
  }
  expect(prompter.seen).toEqual([])
})

test("an ssh that couldn't connect inside a command is named for the model", async () => {
  const { state } = await learning(["1"], { behavior: { login: "refuse" } })
  const got = await runShell({ command: "ssh x true || true", why: "try" }, state)
  expect(got).toStartWith("exit 0\nan ssh in it exited 255: it couldn't connect\n")
  expect(got).toContain("Permission denied")
})

test("commands get our env, stdin from /dev/null, the hq folder and 5 minutes", async () => {
  const { ctx, state } = await learning(["1", "1"], {
    env: { PATH: "/usr/bin:/bin", HOME: "/h", SSH_AUTH_SOCK: "/h/agent", SECRET: "x" },
  })
  const got = await runShell({ command: "env | cut -d= -f1 | sort; [ -t 0 ] || echo nostdin; pwd", why: "env" }, state)
  const names = got
    .split("\n")
    .filter((l) => /^[A-Z_][A-Z0-9_]*$/.test(l) && !["PWD", "SHLVL", "_"].includes(l))
  expect(names).toEqual(["HOME", "OPENCORP_SSH_CONFIG", "OPENCORP_SSH_STATUS", "PATH", "SSH_AUTH_SOCK"])
  expect(got).toContain("\nnostdin\n")
  expect(got).toContain(`\n${ctx.paths.dir}\n`)
  const short = new Learning({ ...ctx, limits: { promptMs: 300, stepMs: 300 } }, new Script(["1"]), new PassThrough(), [], 49381)
  expect(await runShell({ command: "sleep 10", why: "wait" }, short)).toStartWith(
    "stopped: it didn't finish within 5 minutes\n",
  )
})

test("after the owner approves, stdin leaves raw mode and is paused before the command runs", async () => {
  const modes: boolean[] = []
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (on: boolean) => void modes.push(on) })
  const { ctx } = await learning([])
  const seen: { paused: boolean; modes: boolean[] }[] = []
  stdin.resume()
  const state = new Learning(
    { ...ctx, echo: () => void seen.push({ paused: stdin.isPaused(), modes: [...modes] }) },
    new Script(["1"]),
    stdin,
    [],
    49381,
  )
  await runShell({ command: "echo hi >&2", why: "x" }, state)
  expect(seen[0]).toEqual({ paused: true, modes: [false] })
})

test("a result says when there was no output", () => {
  const ran = { code: 0, stdout: "", stderr: "", timedOut: false }
  expect(shellResult(ran, [])).toBe("exit 0\nstdout:\n(none)\nstderr:\n(none)")
  expect(shellResult({ ...ran, stdout: "a\x1b[31mb\n" }, [0])).toBe("exit 0\nstdout:\na[31mb\nstderr:\n(none)")
})

const KEY = "sk-ant-test-0123456789abcdef"
const NOTES = "Log in to login1, then find the job's node with squeue.\n"

test("save_access refuses the model's key, a private key and sshpass, before showing anything", async () => {
  const base64 = Buffer.from(KEY).toString("base64")
  const cases: [Partial<{ script: string; notes: string }>, string][] = [
    [{ script: `export K=${KEY}\n` }, "it holds the model's API key"],
    [{ notes: `the key is ${base64}\n` }, "it holds the model's API key"],
    [{ script: "cat <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\nEOF\n" }, "it holds a private key"],
    [{ script: "sshpass -p hunter2 ssh login1 true\n" }, "it hands a password to ssh"],
    [{ script: "SSHPASS=hunter2 ssh login1 true\n" }, "it hands a password to ssh"],
    [{ script: "echo \x1b[2J\n" }, "control characters"],
  ]
  for (const [files, why] of cases) {
    const { prompter, state, ctx } = await learning([], { secrets: [KEY] })
    const error = await rejection(saveAccess({ script: "echo {}\n", notes: NOTES, risks: [], ...files }, state))
    expect(error).toBeInstanceOf(ReportedToolError)
    expect(error.message).toStartWith("Not saved:")
    expect(error.message).toContain(why)
    expect(error.message).not.toContain(KEY)
    expect(prompter.seen).toEqual([])
    expect(fs.readdirSync(ctx.paths.dir).sort()).toEqual(["cm", "ssh"])
  }
  expect(secretIn("ssh login1 true", [""])).toBeNull()
})

test("save_access shows both files whole and the fixed risks before the setup's own", async () => {
  const { prompter, state, ctx } = await learning(["2", ""])
  const script = "set -eu\nssh login1 true\nprintf '%s\\n' '{}'\n"
  await rejection(saveAccess({ script, notes: "Line one.\n\nLine \u202etwo.\n", risks: ["Duo on the node too: two prompts."] }, state))
  expect(prompter.seen).toEqual([
    `The model wants to save how this machine reaches HQ. ${ctx.paths.script}, which runs on every visit:`,
    "  set -eu",
    "  ssh login1 true",
    "  printf '%s\\n' '{}'",
    `${ctx.paths.notes}:`,
    "  Line one.",
    "  ",
    "  Line <U+202E>two.",
    "Before you save it:",
    ...beforeSaving(ctx.paths).map((line) => `  - ${line}`),
    "  - Duo on the node too: two prompts.",
    SAVE_QUESTION,
    WHAT_SHOULD_CHANGE,
  ])
  expect(prompter.offered).toEqual([[SAVE, CANCEL]])
  expect(BEFORE_LEARNING.some((line) => prompter.seen.includes(line))).toBe(false)
})

test("declining to save tells the model what should change and saves nothing", async () => {
  const { prompter, state, ctx, fake } = await learning(["2", "use squeue"])
  const error = await rejection(saveAccess({ script: "exit 3\n", notes: NOTES, risks: [] }, state))
  expect(error).toBeInstanceOf(ReportedToolError)
  expect(error.message).toBe("Not saved: the owner wants a change: use squeue")
  expect(prompter.seen.at(-2)).toBe(SAVE_QUESTION)
  for (const file of [ctx.paths.script, ctx.paths.notes, ctx.paths.access, ctx.paths.approved]) expect(fs.existsSync(file)).toBe(false)
  expect(fake.calls()).toEqual([])
  expect(state.connection).toBeNull()
  const unanswered = await learning(["", ""])
  expect((await rejection(saveAccess({ script: "exit 3\n", notes: NOTES, risks: [] }, unanswered.state))).message).toBe(
    "Not saved: the owner didn't save it.",
  )
})

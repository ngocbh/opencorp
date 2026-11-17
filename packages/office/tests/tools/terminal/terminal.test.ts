/** A terminal: one session's shells by name, as its host binds them. Calls on one shell queue, waits end together,
 *  close ends them all, a start failure says what to fix, and the gate reads the profile from the shells' sandbox.
 *  Plain PTYs, except the pipes test, which runs in the sandbox where one runs. */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { isPending } from "@ngocbh/yian/tools"
import { type Result, run, SandboxUnavailable } from "../../../src/runtime/sandbox/run.ts"
import { waitFor } from "../../helpers.ts"
import { goldenPolicy, goldenSshPolicy, makePolicy, sandboxAvailable } from "../../runtime/sandbox/helpers.ts"
import { HOST_WHERE, json, openTerminal, permissions, plainShells } from "./helpers.ts"

setDefaultTimeout(30_000)

/** A pipes call's result, as `run` gives it, with `exit`. */
function result(exit: number | null): Result {
  const empty = Buffer.alloc(0)
  return {
    exit, stdout: empty, stderr: empty, stdoutTail: empty, stderrTail: empty, stdoutBytes: 0, stderrBytes: 0,
    timedOut: false, interrupted: false, truncated: false, duration: 0, refused: false,
  }
}

test("a new shell gets the next name, and a named one is reused", async () => {
  const t = openTerminal({ perms: permissions().perms })
  expect(json(await t.call("run", { command: "echo a", why: "x" }))).toMatchObject({ shell: "shell 1", output: "$ echo a\na\n" })
  expect(json(await t.call("run", { command: "echo b", why: "x", shell: "new" }))).toMatchObject({ shell: "shell 2" })
  expect(json(await t.call("run", { command: "echo c", why: "x", shell: "shell 1" }))).toMatchObject({
    shell: "shell 1", output: "$ echo c\nc\n",
  })
  expect(t.terminal.shells().map(({ id, name, state }) => [id, name, state.status])).toEqual([
    ["sh_1", "shell 1", "idle"],
    ["sh_2", "shell 2", "idle"],
  ])
  expect(t.record("sh_1").commands.map((c) => [c.command, c.by])).toEqual([["echo a", "@minh"], ["echo c", "@minh"]])
  expect(t.record("sh_1").profile).toBe("none")
  expect(json(await t.call("read", { shell: "shell 3" }))).toEqual({
    refused: 'no shell is named "shell 3": the shells are shell 1, shell 2; run with no shell starts a new one',
  })
})

test("two calls on one shell queue, and calls on two shells run together", async () => {
  const t = openTerminal({ perms: permissions().perms })
  await t.call("run", { command: "true", why: "x" })
  await t.call("run", { command: "true", why: "x", shell: "new" })
  const [first, second] = await Promise.all([
    t.call("run", { command: "sleep 0.5; echo a", why: "x", shell: "shell 1" }),
    t.call("run", { command: "echo b", why: "x", shell: "shell 1" }),
  ])
  expect(json(first)).toMatchObject({ status: "idle", output: "$ sleep 0.5; echo a\na\n" })
  expect(json(second)).toMatchObject({ status: "idle", output: "$ echo b\nb\n" })
  const started = performance.now()
  const both = await Promise.all([
    t.call("run", { command: "sleep 0.8", why: "x", shell: "shell 1" }),
    t.call("run", { command: "sleep 0.8", why: "x", shell: "shell 2" }),
  ])
  expect(both.map((reply) => json(reply).status)).toEqual(["idle", "idle"])
  expect(performance.now() - started).toBeLessThan(1500)
})

test("interruptWaits ends every waiting reply at once", async () => {
  const t = openTerminal({ perms: permissions().perms })
  await t.call("run", { command: "true", why: "x" })
  const started = performance.now()
  const waiting = Promise.all([
    t.call("run", { command: "sleep 10", why: "x", shell: "shell 1", wait: 60 }),
    t.call("run", { command: "sleep 10", why: "x", wait: 60 }),
  ])
  await waitFor(() => t.terminal.shells().filter(({ state }) => state.status === "running").length === 2, {
    what: "both commands",
  })
  t.terminal.interruptWaits()
  expect((await waiting).map((reply) => json(reply).status)).toEqual(["running", "running"])
  expect(performance.now() - started).toBeLessThan(3000)
  // The shells keep running: only the replies ended.
  expect(t.terminal.shells().map(({ state }) => [state.status, state.command])).toEqual([
    ["running", "sleep 10"],
    ["running", "sleep 10"],
  ])
})

test("close ends every shell and marks its record ended", async () => {
  const t = openTerminal({ perms: permissions().perms })
  await t.call("run", { command: "true", why: "x" })
  await t.call("run", { command: "sleep 30", why: "x", wait: 0 })
  await t.terminal.close()
  expect(t.terminal.shells().map(({ state }) => state.status)).toEqual(["ended", "ended"])
  expect([t.record("sh_1").state, t.record("sh_2").state]).toEqual(["ended", "ended"])
  expect(json(await t.call("run", { command: "true", why: "x" }))).toEqual({ refused: "this terminal has closed" })
})

test("a shell that can't start tells the agent what to fix, and the list shows it failed", async () => {
  const t = openTerminal({
    perms: permissions().perms,
    shells: (dir) => ({
      ...plainShells(dir),
      start: () => {
        throw new SandboxUnavailable('no sandbox for platform "plan9"')
      },
    }),
  })
  const reply = json(await t.call("run", { command: "echo hi", why: "x" }))
  expect(reply).toMatchObject({ shell: "shell 1", status: "failed" })
  expect(reply.error).toBe(
    'the shell couldn\'t start: no sandbox for platform "plan9"; the shell needs a sandbox: on Linux, install ' +
      "bubblewrap (bwrap) and allow unprivileged user namespaces; on macOS, sandbox-exec comes with the system",
  )
  expect(t.terminal.shells().map(({ name, state }) => [name, state.status, state.error])).toEqual([
    ["shell 1", "failed", reply.error as string],
  ])
  expect(t.record("sh_1").state).toBe("failed")
})

test("the gate reads the profile from the shells' sandbox: workspace only for a workspace's, and the SSH-only one's credentials", async () => {
  const ask = async () => ({ verdict: "ask" as const, reason: "asked" })
  // No sandbox: strict, though the host's where says workspace and writable everywhere.
  const none = permissions({ check: ask })
  const bare = openTerminal({ perms: none.perms })
  expect(bare.terminal.profile).toBe("none")
  expect(bare.terminal.where()).toEqual({ profile: "ssh", cwd: HOST_WHERE.cwd, writable: [] })
  await bare.call("run", { command: "touch x", why: "x" })
  await bare.call("run", { command: "cat $F", why: "x" })
  expect(none.held.map((h) => h.card.reason)).toEqual(["Auto's check: asked", "it reads a path named by an expansion: $F"])

  // The SSH-only profile: its temp folder, nothing writable, and the credentials it binds marked.
  const ssh = permissions({ check: ask })
  const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const ticket = path.join(tmp, "krb-ticket")
  const sshPolicy = goldenSshPolicy({ home: "/home/u", hq: "/home/u/.opencorp/hq", tmpdir: tmp, statusFile: "/s", ticket })
  const remote = openTerminal({ perms: ssh.perms, shells: (dir) => ({ ...plainShells(dir), sandbox: sshPolicy }) })
  expect(remote.terminal.profile).toBe("ssh")
  expect(remote.terminal.where()).toEqual({ profile: "ssh", cwd: tmp, writable: [], credentials: [ticket] })
  await remote.call("run", { command: `cat ${ticket}`, why: "x" })
  expect(ssh.held[0]!.card.reason).toBe(`it names a credential path: ${ticket}`)
  fs.rmSync(tmp, { recursive: true, force: true })

  // A workspace's sandbox, pipes or a PTY: the workspace profile, its folder and what it may write.
  for (const kind of ["pipes", "pty"] as const) {
    // Auto's check runs a cd, and asks before anything else it is given.
    const ws = permissions({
      check: async (input) => (input.command.startsWith("cd ") ? { verdict: "run", reason: "moves" } : ask()),
    })
    const t = openTerminal({
      perms: ws.perms,
      shells: (dir) => {
        fs.mkdirSync(path.join(dir, "src"))
        fs.writeFileSync(path.join(dir, "src", "x.ts"), "export {}\n")
        const sandbox = goldenPolicy({ workspace: dir, writable: true, network: false, tmpdir: "/tmp" })
        return kind === "pipes"
          ? { kind, sandbox, run: async () => result(0) }
          : { ...plainShells(dir), sandbox }
      },
    })
    expect(t.terminal.profile).toBe("workspace")
    expect(t.terminal.where()).toEqual({ profile: "workspace", cwd: t.dir, writable: [t.dir, "/tmp"] })
    expect(json(await t.call("run", { command: "touch x", why: "x" }))).toMatchObject({ status: "idle", exit: 0 })
    expect(json(await t.call("run", { command: "cat $F /dev/null", why: "x", shell: "shell 1" }))).toMatchObject({ exit: 0 })
    // A cd in the line still runs on the workspace profile.
    expect(json(await t.call("run", { command: "cd src && cat x.ts", why: "x", shell: "shell 1" }))).toMatchObject({ exit: 0 })
    expect(ws.held).toEqual([])
    expect(t.record("sh_1").profile).toBe("workspace")
  }
})

test("on the SSH-only profile the gate reads a PTY shell's folder as its last command left it", async () => {
  for (const mode of ["auto", "dontAsk"] as const) {
    const { perms, held } = permissions({ mode, check: async () => ({ verdict: "run", reason: "fine" }) })
    const t = openTerminal({
      perms,
      shells: (dir) => {
        const work = path.join(dir, "work")
        fs.mkdirSync(work)
        const hq = path.join(dir, ".opencorp", "hq")
        return { ...plainShells(dir, undefined, work), sandbox: goldenSshPolicy({ home: dir, hq, tmpdir: work, statusFile: "/s" }) }
      },
    })
    const answer = (reason: string) => (result: unknown) =>
      mode === "dontAsk"
        ? expect(result).toBe(`Not run: this session doesn't ask (dontAsk mode): ${reason}.`)
        : expect(isPending(result)).toBe(true)
    const holds = "it reads a folder that holds credentials: ."
    // A new shell starts in the profile's temp folder.
    expect(t.terminal.where().cwd).toBe(path.join(t.dir, "work"))
    expect(json(await t.call("run", { command: "cd ~", why: "go home" }))).toMatchObject({ shell: "shell 1", exit: 0 })
    expect(t.terminal.where("sh_1").cwd).toBe("~")
    answer(holds)(await t.call("run", { command: "grep -r PRIVATE .", why: "x", shell: "shell 1" }))
    // In one line, before any shell has moved.
    answer(holds)(await t.call("run", { command: "cd ~ && grep -r PRIVATE .", why: "x" }))
    // The owner's command may have moved the shell anywhere: relative reads ask until the agent's next command ends.
    t.terminal.shell("sh_1")!.ownerKeys("cd work\r")
    expect(json(await t.call("read", { shell: "shell 1", wait: 5 }))).toMatchObject({ status: "idle" })
    expect(t.terminal.where("sh_1").cwd).toBeNull()
    const lost = "it reads a relative path where the folder isn't known: ."
    answer(lost)(await t.call("run", { command: "grep -r PRIVATE .", why: "x", shell: "shell 1" }))
    expect(json(await t.call("run", { command: "true", why: "x", shell: "shell 1" }))).toMatchObject({ exit: 0 })
    expect(t.terminal.where("sh_1").cwd).toBe("~/work")
    expect(held.map((h) => h.card.reason)).toEqual(mode === "dontAsk" ? [] : [holds, holds, lost])
    expect(t.terminal.shells().map((shell) => shell.name)).toEqual(["shell 1"])
  }
})

describe.skipIf(!sandboxAvailable())("in the sandbox", () => {
  test("a pipes terminal keeps no folder or variable between commands, and refuses type before the gate", async () => {
    const { perms, held, checked } = permissions({ check: async () => ({ verdict: "run", reason: "ok" }) })
    let policy: ReturnType<ReturnType<typeof makePolicy>["make"]> | undefined
    const t = openTerminal({
      perms,
      shells: () => {
        policy = makePolicy().make()
        return { kind: "pipes", sandbox: policy, run: (argv, options) => run(policy!, argv, options) }
      },
    })
    expect(json(await t.call("run", { command: "cd /tmp && X=1 && echo in", why: "x" }))).toMatchObject({ exit: 0 })
    const after = json(await t.call("run", { command: 'pwd; echo "x=$X"', why: "x", shell: "shell 1" }))
    expect(after.output).toBe(`$ pwd; echo "x=$X"\n${policy!.workspace}\nx=\n`)
    const before = checked.length
    expect(json(await t.call("type", { shell: "shell 1", text: "y", why: "x" }))).toMatchObject({
      shell: "shell 1", refused: "this shell takes no input",
    })
    expect([checked.length, held]).toEqual([before, []])
  })
})

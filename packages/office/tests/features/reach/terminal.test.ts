/** Learning's terminal: the agent's shells in an SSH-only sandbox of their own, with the user's ssh config and
 *  ControlMaster no, their records in hq/sessions, and a question before running with no sandbox. The fake ssh lives
 *  in the shells' temp folder, which the sandbox lets it write, and runs on this Bun from the office's source, both
 *  bound read-only, as the SSH-only profile's own tests run it. */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { isPending } from "@ngocbh/yian/tools"
import { makeDirs, ReachPaths } from "../../../src/features/reach/paths.ts"
import { NO_SANDBOX_QUESTION, noSandbox, RUN_UNSANDBOXED, STOP } from "../../../src/features/reach/risks.ts"
import { writeSshFiles } from "../../../src/features/reach/ssh.ts"
import { type Consent, type ConsentAsk, learningTerminal } from "../../../src/features/reach/terminal.ts"
import type { Permissions } from "../../../src/runtime/permissions/policy.ts"
import { SandboxUnavailable } from "../../../src/runtime/sandbox/run.ts"
import { type FakeSshBehavior, fakeControlName, installFakeSsh } from "../../../src/testing/fake_ssh.ts"
import { readRecord } from "../../../src/tools/terminal/record.ts"
import { waitFor } from "../../helpers.ts"
import { sandboxAvailable } from "../../runtime/sandbox/helpers.ts"
import { json, permissions, rule } from "../../tools/terminal/helpers.ts"

setDefaultTimeout(60_000)

const SRC = fileURLToPath(new URL("../../../src/", import.meta.url))
const SESSION = "01JDLEARNSESSION0000000000"
const PLAN9 = 'no sandbox for platform "plan9"'
const RUNS = async () => ({ verdict: "run" as const, reason: "fine" })

/** The user's own ssh config, as the fake reads it where the agent's config includes `~/.ssh/config`: their
 *  connections shared in `~/.ssh/tmp`. */
const userConfig = (ssh: string) => ["Host *", "  ControlMaster auto", `  ControlPath ${ssh}/tmp/%C`, "  User alice"]

/** Learning's terminal over a short temp root: the user's home (`~/.ssh` with their config and `tmp/`, OpenCorp's
 *  home with hq's key, sign-in and the visit's ssh files), and the shells' temp folder holding the fake ssh, which
 *  the visit's wrapper runs. `noSandbox` stands in a policy that can't be built for want of a sandbox; `consent`
 *  answers the owner's question (Stop when it says nothing). The test's end closes the terminal, ends the fake's
 *  masters and removes the root. */
async function learning(o: {
  perms: Permissions
  behavior?: FakeSshBehavior
  noSandbox?: boolean
  consent?: (ask: ConsentAsk) => Promise<string>
}) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  const home = path.join(root, "home")
  const ssh = path.join(home, ".ssh")
  for (const dir of [home, ssh, path.join(ssh, "tmp")]) fs.mkdirSync(dir, { mode: 0o700 })
  fs.writeFileSync(path.join(ssh, "config"), `${userConfig(ssh).join("\n")}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(home, "secret.txt"), "decoy-secret\n")
  const paths = new ReachPaths(path.join(home, ".opencorp"))
  makeDirs(paths)
  fs.writeFileSync(paths.provider, '{"key":"decoy-provider"}\n', { mode: 0o600 })
  fs.writeFileSync(paths.auth, '{"token":"decoy-auth"}\n', { mode: 0o600 })
  const tmpdir = path.join(root, "tmp")
  fs.mkdirSync(tmpdir, { mode: 0o700 })
  const behaviour = { ...o.behavior, userConfig: userConfig(ssh) }
  const fake = installFakeSsh(path.join(tmpdir, "fake"), behaviour)
  await writeSshFiles(paths, fake.ssh, [path.join(ssh, "config"), "/etc/ssh/ssh_config"])
  const live = new Map<string, Uint8Array[]>()
  const asked: ConsentAsk[] = []
  const consent: Consent = async (ask) => {
    asked.push(ask)
    return (await o.consent?.(ask)) ?? ask.default
  }
  const terminal = await learningTerminal({
    paths,
    session: SESSION,
    home,
    ssh: fake.ssh,
    env: { HOME: "/elsewhere", PATH: "/elsewhere/bin" },
    permissions: o.perms,
    consent,
    onShell: (id) => {
      live.set(id, [])
      return { changed: () => {}, output: (chunk) => live.get(id)!.push(chunk) }
    },
    readOnly: [SRC, fs.realpathSync(process.execPath)],
    tmpdir,
    ...(o.noSandbox
      ? {
          policy: async () => {
            throw new SandboxUnavailable(PLAN9)
          },
        }
      : {}),
  })
  onTestFinished(async () => {
    await terminal.close()
    for (const pid of fake.masters()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const tools = terminal.tools()
  let calls = 0
  return {
    root,
    home,
    ssh,
    paths,
    tmpdir,
    fake,
    terminal,
    asked,
    /** Sets the fake's behavior, keeping the user's config. */
    behave: (b: FakeSshBehavior) => fake.set({ ...b, userConfig: userConfig(ssh) }),
    call: (name: keyof typeof tools, args: Record<string, unknown>) =>
      tools[name].call(args, { callId: `r/n/${++calls}/0` }),
    /** The id of the `n`th shell made. */
    id: (n = 0) => terminal.shells()[n]!.id,
    /** The owner's live view of shell `id`, decoded. */
    live: (id: string) => new TextDecoder().decode(Buffer.concat(live.get(id) ?? [])),
    /** Shell `id`'s record folder. */
    recordDir: (id: string) => path.join(paths.sessions, SESSION, "terminal", id),
  }
}

/** Waits until the first shell's command has ended. */
const idle = (t: Awaited<ReturnType<typeof learning>>) =>
  waitFor(() => t.terminal.shells()[0]?.state.status === "idle", { timeout: 20_000, what: "the command to end" })

/** Every regular file under `dir`, links not followed. */
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
}

/** `dir`'s entries, recursively, as paths relative to it. */
const listing = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).sort()

describe.skipIf(!sandboxAvailable())("in the SSH-only sandbox", () => {
  test("learning's shells run in the SSH-only profile, and the gate reads it as ssh", async () => {
    const t = await learning({ perms: permissions({ check: RUNS }).perms })
    expect(t.terminal.profile).toBe("ssh")
    expect(t.terminal.where()).toEqual({ profile: "ssh", cwd: t.tmpdir, writable: [] })
    const command = 'echo "$HOME $TMPDIR $OPENCORP_SSH_CONFIG"; command -v ssh; pwd'
    const reply = json(await t.call("run", { command, why: "look around" }))
    expect(reply).toMatchObject({ shell: "shell 1", status: "idle", exit: 0 })
    // The owner's home as ssh sees it, the shells' own temp folder, the visit's wrapper first on PATH with the
    // agent's config, and nothing of the visit's env.
    expect(reply.output).toBe(`$ ${command}\n${t.home} ${t.tmpdir} ${t.paths.agentConfig}\n${t.paths.wrapper}\n${t.tmpdir}\n`)
    const record = readRecord(t.recordDir(t.id()))!
    expect([record.profile, record.driver]).toEqual(["ssh", "opencorp"])
  })

  test("the agent's ssh reads the user's own config", async () => {
    const t = await learning({ perms: permissions({ check: RUNS }).perms })
    // What ssh would use for h: the agent's ControlMaster no first, then the user's own settings.
    const printed = json(await t.call("run", { command: "ssh -G h", why: "check the config" }))
    expect(printed.output).toBe(
      `$ ssh -G h\ncontrolmaster no\ncontrolpath ${t.ssh}/tmp/${fakeControlName("h")}\nuser alice\n`,
    )
    // The file itself, read-only.
    const config = json(await t.call("run", { command: "cat ~/.ssh/config; echo x >> ~/.ssh/config", why: "x" }))
    expect(config.output).toStartWith(`$ cat ~/.ssh/config; echo x >> ~/.ssh/config\n${userConfig(t.ssh).join("\n")}\n`)
    expect(config.exit).not.toBe(0)
    expect(fs.readFileSync(path.join(t.ssh, "config"), "utf8")).toBe(`${userConfig(t.ssh).join("\n")}\n`)
  })

  test("with a connection of the user's open, the agent's ssh rides it with no password", async () => {
    const t = await learning({ perms: permissions({ check: RUNS }).perms })
    // The user's own master, as their terminal leaves one, at their ControlPath.
    const socket = path.join(t.ssh, "tmp", fakeControlName("h"))
    const master = spawn(t.fake.ssh, ["-M", "-S", socket, "h"], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "ignore", "ignore"] })
    onTestFinished(() => void master.kill("SIGKILL"))
    await waitFor(() => fs.existsSync(socket), { timeout: 15_000, what: "the user's master" })
    // From here a login would ask for a password.
    t.behave({ login: "tty" })
    const rode = json(await t.call("run", { command: "ssh h echo rode", why: "use it", wait: 20 }))
    expect(rode).toMatchObject({ status: "idle", exit: 0, waiting: null })
    expect(rode.output).toBe("$ ssh h echo rode\nrode\n")
    expect(t.fake.logins()).toEqual(["h"])
    expect(t.fake.tty()).toEqual([])
    // It left the user's connection up, and kept none of its own.
    expect(fs.readdirSync(path.join(t.ssh, "tmp"))).toEqual([fakeControlName("h")])
    expect(t.fake.masters()).toEqual([master.pid!])
  })

  test("with none open, it connects directly, asks for the password, and leaves nothing in ~/.ssh", async () => {
    const t = await learning({ perms: permissions({ check: RUNS }).perms, behavior: { login: "tty" } })
    const before = listing(t.ssh)
    const asked = json(await t.call("run", { command: "ssh h echo direct", why: "log in", wait: 20 }))
    expect(asked).toMatchObject({ status: "waiting", waiting: "secret" })
    expect(asked.output).toEndWith("fake password for h: ")
    t.terminal.shell(t.id())!.ownerKeys("pw-typed\r")
    await idle(t)
    const done = json(await t.call("read", { shell: "shell 1", wait: 0 }))
    expect(done).toMatchObject({ status: "idle", exit: 0 })
    expect(done.output).toEndWith("direct\n")
    expect(t.fake.tty()).toEqual(["pw-typed"])
    expect(t.fake.logins()).toEqual(["h"])
    // ControlMaster no: no master kept, and ~/.ssh as it was.
    expect(t.fake.masters()).toEqual([])
    expect(listing(t.ssh)).toEqual(before)
  })

  test("at ssh's password prompt the agent's type is refused, and the owner's keys reach ssh and appear in no record, view or log", async () => {
    const { perms } = permissions({ rules: [rule("allow", "input", "*")], check: RUNS })
    const t = await learning({ perms, behavior: { login: "tty" } })
    expect(json(await t.call("run", { command: "ssh h echo in", why: "log in", wait: 20 }))).toMatchObject({ waiting: "secret" })
    const typed = json(await t.call("type", { shell: "shell 1", text: "agent-pw", why: "log in" }))
    expect(typed.refused).toBe(
      "the program is asking for a password; only the owner types it. Call read to see what happens next.",
    )
    const id = t.id()
    t.terminal.shell(id)!.ownerKeys("s3cret-pw\r")
    await idle(t)
    const view = json(await t.call("read", { shell: "shell 1", from: 0, wait: 0 }))
    expect(view.output).toContain("fake password for h: ")
    expect(view.output).toEndWith("in\n")
    expect(t.fake.tty()).toEqual(["s3cret-pw"])
    await t.terminal.close()
    // The fake ssh's own note of what it read is the one place the password may be.
    const tty = path.join(t.fake.state, "tty.txt")
    const kept = [view.output as string, t.live(id), ...files(t.root).filter((f) => f !== tty).map((f) => fs.readFileSync(f, "latin1"))]
    expect(files(t.recordDir(id)).map((f) => path.basename(f)).sort()).toEqual(["meta.json", "output.log"])
    for (const text of kept) {
      expect(text).not.toContain("s3cret")
      expect(text).not.toContain("agent-pw")
    }
  })

  test("a host-key question takes the agent's yes in auto, and holds on a card in ask", async () => {
    for (const mode of ["auto", "ask"] as const) {
      const { perms, held } = permissions({
        mode, rules: [rule("allow", "command", "ssh h echo in")], check: async () => ({ verdict: "ask", reason: "no" }),
      })
      const t = await learning({ perms, behavior: { login: "host_key" } })
      expect(json(await t.call("run", { command: "ssh h echo in", why: "log in", wait: 0 }))).toMatchObject({ status: "running" })
      await waitFor(() => t.live(t.id()).endsWith("(yes/no/[fingerprint])? "), { timeout: 20_000, what: "the question" })
      const typed = await t.call("type", { shell: "shell 1", text: "yes", why: "accept the key", wait: 20 })
      if (mode === "ask") {
        expect(isPending(typed)).toBe(true)
        expect(held.map((h) => [h.card.action, h.card.into])).toEqual([["yes", "ssh h echo in"]])
        expect(t.fake.tty()).toEqual([])
      } else {
        expect(json(typed)).toMatchObject({ status: "idle", exit: 0 })
        expect(held).toEqual([])
        expect(t.fake.tty()).toEqual(["yes"])
      }
    }
  })

  test("Duo's menu takes the agent's 1 in auto", async () => {
    const { perms, held } = permissions({ check: RUNS })
    const t = await learning({ perms, behavior: { login: "duo" } })
    expect(json(await t.call("run", { command: "ssh h echo in", why: "log in", wait: 0 }))).toMatchObject({ status: "running" })
    await waitFor(() => t.live(t.id()).endsWith("Passcode or option (1-3): "), { timeout: 20_000, what: "Duo's menu" })
    expect(json(await t.call("type", { shell: "shell 1", text: "1", why: "push", wait: 20 }))).toMatchObject({
      status: "idle",
      exit: 0,
    })
    expect(held).toEqual([])
    expect(t.fake.tty()).toEqual(["1"])
  })

  test("hq/provider.json, hq/auth.json, hq/cm and the rest of the home can't be read from learning's shell", async () => {
    const { perms, held } = permissions({ check: RUNS })
    const t = await learning({ perms })
    const { provider, auth, dir: hq, cm } = t.paths
    const command = [
      `cat ${provider} ${auth} ~/secret.txt; echo "[cat $?]"`,
      'echo "-- home"; ls -1A ~',
      `echo "-- hq"; ls -1A ${hq}`,
      `ls -1A ${cm}; echo "[cm $?]"`,
    ].join("\n")
    // The reader asks before a command that names them: here the owner says Yes, and the sandbox still holds.
    expect(isPending(await t.call("run", { command, why: "look" }))).toBe(true)
    expect(held[0]!.card.reason).toBe(`it names a credential path: ${provider}`)
    const reply = json(await t.terminal.runApproved("run", held[0]!.card.args, new AbortController().signal))
    const output = reply.output as string
    expect(output).not.toContain("decoy")
    expect(output).toContain("[cat 1]")
    expect(output).toMatch(/\[cm [12]\]/)
    if (process.platform === "linux") {
      // bubblewrap makes the mount points of what the profile binds, ~/.ssh and hq/ssh, and nothing else of the home.
      const after = (marker: string) => output.slice(output.indexOf(`${marker}\n`) + marker.length + 1).split("\n")
      expect(after("-- home").slice(0, 2)).toEqual([".opencorp", ".ssh"])
      expect(after("-- hq")[0]).toBe("ssh")
      expect(after("-- hq")[1]).toStartWith("ls: cannot access")
    }
  })

  test("the shells' records go to hq/sessions/<id>/terminal/, and the model's view is the screen as it is", async () => {
    const t = await learning({ perms: permissions({ check: RUNS }).perms })
    // A sign-in code, which learning's own output scrubbing hides: the terminal shows it as the screen does.
    const code = `pair#${"A".repeat(22)}`
    const reply = json(await t.call("run", { command: `printf '%s\\n' ${code}`, why: "x" }))
    expect(reply.output).toBe(`$ printf '%s\\n' ${code}\n${code}\n`)
    const id = t.id()
    const dir = t.recordDir(id)
    expect(fs.readdirSync(t.paths.sessions)).toEqual([SESSION])
    expect(fs.readdirSync(path.join(t.paths.sessions, SESSION, "terminal"))).toEqual([id])
    for (const folder of [t.paths.sessions, path.join(t.paths.sessions, SESSION), path.dirname(dir), dir])
      expect(fs.statSync(folder).mode & 0o777).toBe(0o700)
    expect(readRecord(dir)).toMatchObject({
      id, name: "shell 1", kind: "terminal", profile: "ssh", driver: "opencorp", state: "running",
      commands: [{ command: `printf '%s\\n' ${code}`, by: "opencorp", exit: 0 }],
    })
    await t.terminal.close()
    expect(readRecord(dir)!.state).toBe("ended")
    expect(fs.readFileSync(path.join(dir, "output.log"), "utf8")).toContain(`${code}\n`)
  })
})

test("with no sandbox the owner is asked first, Stop by default, and Stop starts no shell", async () => {
  // In ask mode, where any command the gate saw would wait on a card.
  const asking = permissions({ mode: "ask", check: RUNS })
  const t = await learning({ perms: asking.perms, noSandbox: true })
  expect(t.asked).toEqual([
    { lines: noSandbox(t.paths, PLAN9), question: NO_SANDBOX_QUESTION, choices: [RUN_UNSANDBOXED, STOP], default: STOP },
  ])
  expect(json(await t.call("run", { command: "echo hi", why: "x" }))).toEqual({
    refused: `the owner stopped learning's shells: OpenCorp can't sandbox them here (${PLAN9})`,
  })
  expect(json(await t.call("read", { shell: "shell 1" }))).toEqual(json(await t.call("run", { command: "ls", why: "x" })))
  expect([asking.held, asking.checked]).toEqual([[], []])
  expect(t.terminal.shells()).toEqual([])
  expect(fs.existsSync(t.paths.sessions)).toBe(false)
  // On Yes they run with no sandbox, and the gate still reads them as the SSH-only profile.
  const yes = await learning({ perms: permissions({ check: RUNS }).perms, noSandbox: true, consent: async () => RUN_UNSANDBOXED })
  expect(yes.terminal.profile).toBe("none")
  expect(yes.terminal.where()).toEqual({ profile: "ssh", cwd: yes.tmpdir, writable: [] })
  const command = 'echo "$HOME $TMPDIR $OPENCORP_SSH_CONFIG"; command -v ssh; pwd'
  const reply = json(await yes.call("run", { command, why: "x" }))
  expect(reply.output).toBe(`$ ${command}\n${yes.home} ${yes.tmpdir} ${yes.paths.agentConfig}\n${yes.paths.wrapper}\n${yes.tmpdir}\n`)
  expect(readRecord(yes.recordDir(yes.id()))!.profile).toBe("none")
})

test("a shell whose temp folder has gone isn't started elsewhere", async () => {
  const t = await learning({ perms: permissions({ check: RUNS }).perms, noSandbox: true, consent: async () => RUN_UNSANDBOXED })
  fs.rmSync(t.tmpdir, { recursive: true, force: true })
  const reply = json(await t.call("run", { command: "pwd", why: "x" }))
  expect(reply).toMatchObject({ shell: "shell 1", status: "failed" })
  expect(reply.error).toBe(`the shell couldn't start: the shells' folder is not a directory: ${t.tmpdir}`)
})

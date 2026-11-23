// `opencorp hq`'s learning on a real terminal, in tmux: a chat with OpenCorp in the TUI, on the no-office host, whose
// agent drives a shell in the SSH-only sandbox. The fake ssh is compiled and lives outside the test's home, in the
// folder OPENCORP_TEST_SSH_DIR names, so the sandbox runs it. The fake model is the agent's and Auto's check's, and
// every scripted reply has a `match`; each test uses all of them.
import { describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { FakeLLM, LLM_CONFIG, type ScriptedReply } from "@opencorp/office/testing/fake_llm"
import type { FakeSshBehavior } from "@opencorp/office/testing/fake_ssh"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import { builtApp, type Client, client, pidsNaming, reachScript, removeClient } from "./remote"
import { type Terminal, TMUX, terminal } from "./tmux"

setDefaultTimeout(180_000)

/** Words only the learning agent's requests hold, from its system prompt. */
const AGENT = "helping the owner open their OpenCorp HQ"
/** The password typed at the fake ssh's prompts. */
const PASSWORD = "hunter2-swordfish"

/** The agent's call of terminal tool `tool` with `args`, as call `id`; `after` is the call whose result it follows,
 *  or with `match`, what the request holds. */
function term(id: string, tool: string, args: Record<string, unknown>, after?: string, match?: string): ScriptedReply {
  return {
    match: match ?? (after === undefined ? AGENT : `"tool_call_id":"${after}"`),
    tool_calls: [{ id, name: `terminal_${tool}`, arguments: args }],
  }
}

/** The agent's words once call `id`'s result reached it. */
function said(id: string, content: string): ScriptedReply {
  return { match: `"tool_call_id":"${id}"`, content }
}

/** Auto's check's verdict on `command`. */
function check(command: string, verdict: "run" | "ask", reason: string): ScriptedReply {
  return { match: `<command>\\n${command}\\n</command>`, tool_calls: [{ name: "Record", arguments: { verdict, reason } }] }
}

/** Every regular file under `dir` whose bytes hold `text`, links not followed. */
function holding(dir: string, text: string): string[] {
  if (!fs.existsSync(dir)) return []
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => fs.readFileSync(file).includes(text))
}

/** A client with no saved path and its hq/provider.json on a fake model of its own, the fake ssh behaving as
 *  `behavior`, and `opencorp hq --no-open` in a terminal of its own, past "Learn it" and into the chat, until it shows
 *  `see` (`@opencorp auto` by default). The model's replies are `script`'s, queued before the chat opens; `before`
 *  readies the client first. */
async function learning(
  script: ScriptedReply[] | ((c: Client) => ScriptedReply[]),
  behavior: FakeSshBehavior = {},
  { before, office, see = "@opencorp auto" }: { before?: (c: Client) => void; office?: TestOffice; see?: string } = {},
) {
  const llm = await FakeLLM.start()
  onTestFinished(() => llm.close())
  const c = await client(office ?? null, { behavior, compiled: true })
  onTestFinished(() => removeClient(c))
  // A path to learn, never one to approve: nothing saved.
  fs.rmSync(c.dest, { recursive: true, force: true })
  before?.(c)
  fs.writeFileSync(path.join(c.hq, "provider.json"), JSON.stringify({ llm_config: LLM_CONFIG, env: llm.env() }), {
    mode: 0o600,
  })
  llm.script(...(typeof script === "function" ? script(c) : script))
  onTestFinished(() => expect(llm.pending()).toEqual([]))
  const t = terminal(c, ["hq", "--no-open"])
  await t.see("Learn how to reach HQ from here? This uses the model.")
  // The default is Stop; Up picks Learn it.
  t.keys("Up")
  t.keys("Enter")
  await t.see(see)
  return { c, t, llm }
}

/** The model's requests, as text. */
const requests = (llm: FakeLLM) => llm.requests().map((r) => JSON.stringify(r))

/** Call `id`'s result, as the first request that holds it gave it to the model. */
function result(llm: FakeLLM, id: string): string | undefined {
  return llm
    .requests()
    .flatMap((r) => (r.messages as { role: string; tool_call_id?: string; content?: string }[]) ?? [])
    .find((m) => m.role === "tool" && m.tool_call_id === id)?.content
}

/** Ctrl-C twice: the chat ends, and with it the visit, which lists the commands tried and exits 130. */
async function leave(t: Terminal) {
  t.keys("C-c")
  await t.see("Press again to leave")
  t.keys("C-c")
  expect(await t.exit(60_000)).toBe("exit=130")
}

/** The processes naming `text`, but the test's tmux server, whose command line names the client's folders. */
function running(text: string): number[] {
  return pidsNaming(text).filter((pid) => {
    try {
      return !fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith(`${TMUX}\0`)
    } catch {
      return false
    }
  })
}

/** Process `pid`'s command line, NUL-separated, or "" once it is gone. */
function argv(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
  } catch {
    return ""
  }
}

/** The processes of this user whose working folder is in `dir`: the session's worker runs in its session's folder,
 *  and OpenCorp's connection shell in hq. */
function workingIn(dir: string): number[] {
  return fs.readdirSync("/proc").flatMap((name) => {
    if (!/^[0-9]+$/.test(name) || Number(name) === process.pid) return []
    try {
      const cwd = fs.readlinkSync(`/proc/${name}/cwd`)
      return cwd === dir || cwd.startsWith(`${dir}/`) ? [Number(name)] : []
    } catch {
      return []
    }
  })
}

/** Nothing of `c` is left running, its workers included, once a process that is exiting has had a few seconds to
 *  go, and every shell's record has ended. */
async function nothingLeft(c: Client) {
  const left = () => [...running(c.hq), ...running(c.fakeDir), ...workingIn(c.hq)]
  for (const deadline = performance.now() + 5000; left().length > 0 && performance.now() < deadline; )
    await Bun.sleep(100)
  expect(running(c.hq)).toEqual([])
  expect(running(c.fakeDir)).toEqual([])
  expect(workingIn(c.hq)).toEqual([])
  const sessions = path.join(c.hq, "sessions")
  for (const session of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
    const records = path.join(sessions, session, "terminal")
    for (const id of fs.existsSync(records) ? fs.readdirSync(records) : []) {
      const meta = JSON.parse(fs.readFileSync(path.join(records, id, "meta.json"), "utf8"))
      expect([id, meta.state]).not.toEqual([id, "running"])
    }
  }
}

describe.skipIf(!TMUX)("learning, a chat with OpenCorp on a real terminal", () => {
  test("learning's shell opens itself at ssh's password; the owner types it there; it reaches the fake ssh and no record, log or model request", async () => {
    const { c, t, llm } = await learning(
      [
        // A remote command that only reads runs in auto with no check.
        term("call_ssh", "run", { command: "ssh login1 true", why: "log in to login1" }),
        term("call_read", "read", { shell: "shell 1", wait: 120 }, "call_ssh"),
        said("call_read", "Logged in to login1."),
      ],
      { hosts: { login1: { login: "tty" } } },
    )
    await t.see("fake password for login1:")
    await t.see("type your password here")
    t.type(PASSWORD)
    await t.see("Logged in to login1.")
    expect(c.fake.tty()).toEqual([PASSWORD])
    await leave(t)
    expect(t.screen()).toContain("The commands the agent ran:")
    expect(t.screen()).toContain("(exit 0) ssh login1 true")
    // The password reached the fake ssh alone: no request, record, log or file of the home's, and not the screen.
    expect(requests(llm).some((r) => r.includes(PASSWORD))).toBe(false)
    expect(result(llm, "call_read")).toContain("fake password for login1:")
    expect(holding(c.root, PASSWORD)).toEqual([])
    expect(holding(c.fakeDir, PASSWORD)).toEqual([path.join(c.fakeDir, "state", "tty.txt")])
    expect(t.screen()).not.toContain(PASSWORD)
    await nothingLeft(c)
  })

  test("the fake the real CLI runs in the agent's shell can't read a canary in the test's home", async () => {
    const CANARY = "canary-in-the-home"
    let canary = ""
    const { c, t, llm } = await learning(
      (c) => [
        term("call_cat", "run", { command: `ssh login1 cat ${(canary = path.join(c.root, "canary.txt"))}`, why: "look" }),
        said("call_cat", "It isn't there."),
      ],
      {},
      { before: (c) => fs.writeFileSync(path.join(c.root, "canary.txt"), `${CANARY}\n`) },
    )
    await t.see("It isn't there.")
    // The fake ran, in the sandbox: its log is in the folder the sandbox binds, and the home's file wasn't there.
    expect(c.fake.calls().some((argv) => argv.join(" ").endsWith(`login1 cat ${canary}`))).toBe(true)
    expect(result(llm, "call_cat")).toContain("No such file or directory")
    expect(requests(llm).some((r) => r.includes(CANARY))).toBe(false)
    await leave(t)
    await nothingLeft(c)
  })

  test("in auto the agent answers the host-key question and Duo's 1 with no card", async () => {
    const { c, t, llm } = await learning(
      [
        term("call_key", "run", { command: "ssh login1 true", why: "log in to login1", wait: 3 }),
        term("call_yes", "type", { shell: "shell 1", text: "yes", why: "accept login1's host key", wait: 20 }, "call_key"),
        term("call_duo", "run", { shell: "shell 1", command: "ssh login2 true", why: "log in to login2", wait: 3 }, "call_yes"),
        term("call_one", "type", { shell: "shell 1", text: "1", why: "push to Duo", wait: 20 }, "call_duo"),
        said("call_one", "Both logged in."),
      ],
      { hosts: { login1: { login: "host_key" }, login2: { login: "duo" } } },
    )
    await t.see("Both logged in.")
    expect(c.fake.tty()).toEqual(["yes", "1"])
    expect(c.fake.logins()).toEqual(["login1", "login2"])
    expect(result(llm, "call_key")).toContain("Are you sure you want to continue connecting")
    expect(result(llm, "call_duo")).toContain("Passcode or option (1-3)")
    expect(JSON.parse(result(llm, "call_one")!)).toMatchObject({ status: "idle", exit: 0 })
    // No card, and no check: a prompt's short answer runs in auto.
    expect(requests(llm).some((r) => r.includes("<input>"))).toBe(false)
    expect(t.screen()).not.toContain("enter confirm")
    await leave(t)
    await nothingLeft(c)
  })

  test("after Shift+Tab to ask, the agent's command waits on a card in the chat, and Yes runs it in the SSH-only shell", async () => {
    let canary = ""
    const { c, t, llm } = await learning(
      (c) => [
        { match: AGENT, content: "Ready when you are." },
        term("call_look", "run", { command: `echo in-the-shell; cat ${(canary = path.join(c.root, "canary.txt"))}`, why: "look" }, undefined, "Look around"),
        said("call_look", "Looked."),
      ],
      {},
      { before: (c) => fs.writeFileSync(path.join(c.root, "canary.txt"), "canary-in-the-home\n") },
    )
    await t.see("Ready when you are.")
    for (const mode of ["default", "ask"]) {
      t.keys("BTab")
      await t.see(`@opencorp ${mode}`)
    }
    t.type("Look around")
    await t.see(`echo in-the-shell; cat ${canary}`)
    await t.see("enter confirm")
    // The card names the tool as the model called it, terminal_run, so it reads as a shell command.
    await t.see("Shell command", 5_000)
    // Nothing runs until the owner's Yes: a digit only selects.
    t.keys("1")
    await Bun.sleep(500)
    expect(result(llm, "call_look")).toBeUndefined()
    t.keys("Enter")
    await t.see("Looked.")
    const ran = result(llm, "call_look")!
    expect(ran).toContain("in-the-shell")
    // The SSH-only shell: the home's file isn't in it.
    expect(ran).toContain("No such file or directory")
    expect(ran).not.toContain("canary-in-the-home")
    await leave(t)
    await nothingLeft(c)
  })

  test("with a connection of the owner's open, the agent's ssh asks for nothing", async () => {
    const { c, t, llm } = await learning(
      [term("call_ride", "run", { command: "ssh login1 echo rode-it", why: "check" }), said("call_ride", "It rode yours.")],
      {},
      {
        // The owner's own connection to login1, shared at their ControlPath in ~/.ssh, as their terminal leaves it.
        before: (c) => {
          const cm = path.join(c.root, ".ssh", "cm")
          fs.mkdirSync(cm, { recursive: true, mode: 0o700 })
          fs.chmodSync(path.join(c.root, ".ssh"), 0o700)
          const userConfig = ["Host *", `  ControlPath ${cm}/%C`]
          c.fake.set({ persistMs: 170_000, userConfig })
          const opened = spawnSync(c.fake.ssh, ["-o", "ControlMaster=auto", "-o", `ControlPath=${cm}/%C`, "login1", "true"], {
            env: { PATH: "/usr/bin:/bin" },
            timeout: 20_000,
          })
          expect(opened.status).toBe(0)
          // A new login would now ask.
          c.fake.set({ persistMs: 170_000, userConfig, hosts: { login1: { login: "tty" } } })
        },
      },
    )
    await t.see("It rode yours.")
    expect(result(llm, "call_ride")).toContain("rode-it")
    expect(c.fake.tty()).toEqual([])
    expect(c.fake.logins()).toEqual(["login1"])
    await leave(t)
    expect(running(c.hq)).toEqual([])
    expect(workingIn(c.hq)).toEqual([])
  })

  test("logged in once in its shell, the agent's typed commands ask for nothing more", async () => {
    const { c, t, llm } = await learning(
      [
        term("call_login", "run", { command: "ssh login1", why: "log in once", wait: 120 }),
        term("call_wait", "read", { shell: "shell 1", wait: 5 }, "call_login"),
        term("call_one", "type", { shell: "shell 1", text: "echo typed-one", why: "first", wait: 5 }, "call_wait"),
        term("call_two", "type", { shell: "shell 1", text: "echo typed-two", why: "second", wait: 5 }, "call_one"),
        said("call_two", "Both ran in the one login."),
      ],
      { hosts: { login1: { login: "tty" } }, interactive: true },
    )
    await t.see("type your password here")
    t.type(PASSWORD)
    await t.see("Both ran in the one login.")
    expect(result(llm, "call_one")).toContain("typed-one")
    expect(result(llm, "call_two")).toContain("typed-two")
    expect(c.fake.tty()).toEqual([PASSWORD])
    expect(c.fake.logins()).toEqual(["login1"])
    expect(requests(llm).some((r) => r.includes(PASSWORD))).toBe(false)
    await leave(t)
    await nothingLeft(c)
  })

  test("the save card reads whole; the chain test asks once in OpenCorp's connection shell; then the chat closes and the visit prints Connected.", async () => {
    const app = builtApp(fs.mkdtempSync("/tmp/oc-app-"))
    const remote = await startOffice({ hq: { tcp: false, app_dir: app } })
    onTestFinished(async () => {
      await remote.stop()
      fs.rmSync(app, { recursive: true, force: true })
    })
    const risks = Array.from({ length: 30 }, (_, i) => `Risk ${i + 1}: something the owner should know.`)
    const { c, t } = await learning(
      [
        {
          match: AGENT,
          tool_calls: [
            { id: "call_save", name: "save_access", arguments: { script: reachScript(remote), notes: "Through login1.\n", risks } },
          ],
        },
        said("call_save", "HQ is reachable from here now."),
      ],
      { hosts: { login1: { login: "tty" } } },
      // The card is up at once, in place of the prompt and its mode.
      { office: remote, see: "OpenCorp wants to save how this machine reaches HQ" },
    )
    await t.see("Read to the end")
    expect(t.screen()).not.toContain("Test it, then save it")
    t.keys("End")
    await t.see("Test it, then save it")
    t.keys("Enter")
    // The chain test's ssh asks in OpenCorp's connection shell, which opens itself.
    await t.see("fake password for login1:")
    await t.see("type your password here")
    t.type(PASSWORD)
    await t.see("Connected.")
    expect(t.screen()).not.toContain("@opencorp")
    // One login: the node's hop rode the login node's master the replay left.
    expect(c.fake.tty()).toEqual([PASSWORD])
    // Saved under the host it reaches first.
    expect(fs.readFileSync(path.join(c.dest, "reach.sh"), "utf8")).toBe(reachScript(remote))
    t.keys("C-c")
    expect(await t.exit()).toBe("exit=0")
    expect(holding(c.root, PASSWORD)).toEqual([])
    expect(c.fake.masters()).toEqual([])
    await nothingLeft(c)
  })

  test("a model error ends the chat, and the visit says why", async () => {
    const { c, t } = await learning([{ error: 400, match: AGENT }], {}, { see: "opencorp hq: learning failed:" })
    expect(await t.exit()).toBe("exit=1")
    expect(t.screen()).toContain("scripted error 400")
    await nothingLeft(c)
  })

  test("Ctrl-C twice ends the visit and every shell, and lists the commands tried", async () => {
    const { c, t } = await learning([
      term("call_sleep", "run", { command: "sleep 3141", why: "wait a while", wait: 1 }),
      term("call_touch", "run", { command: "touch marker", why: "mark it" }, "call_sleep"),
      check("touch marker", "ask", "it writes a file"),
    ])
    // At the card the second command waits on, the owner leaves.
    await t.see("Asking because: Auto's check: it writes a file")
    await leave(t)
    expect(t.screen()).toContain("The commands the agent ran:")
    expect(t.screen()).toContain("(no exit) sleep 3141")
    expect(t.screen()).not.toContain("touch marker")
    // The shell's command goes with it, once it has had a few seconds to.
    const sleeping = () => running("3141").filter((pid) => argv(pid) === "sleep\u00003141\u0000")
    for (const deadline = performance.now() + 5000; sleeping().length > 0 && performance.now() < deadline; )
      await Bun.sleep(100)
    expect(sleeping()).toEqual([])
    await nothingLeft(c)
  })
})

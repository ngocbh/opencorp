// `opencorp hq` from another machine on a real terminal, in tmux: the approval question and ssh's password prompts
// share it, and every key meant for ssh reaches ssh.
import { afterAll, beforeAll, describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import { builtApp, type Client, client, pidsNaming, removeClient, WRAPPER } from "./remote"

setDefaultTimeout(30_000)

const TMUX = Bun.which("tmux", { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" })

/** `s` as one sh word. */
const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** A tmux server of its own (`-L`), killed and its socket removed when the test finishes, running `opencorp hq --no-open` for `c` in a
 *  120x40 window; the command's exit status lands in `<root>/exit`. */
function terminal(c: Client) {
  const server = `oc-hq-${randomBytes(4).toString("hex")}`
  const tmux = (...args: string[]) =>
    execFileSync(TMUX!, ["-L", server, ...args], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })
  const exitFile = path.join(c.root, "exit")
  // tmux 2.7 has no `new-session -e`: the env goes in the command.
  const env = Object.entries({ ...c.env, TERM: "xterm" }).map(([k, v]) => sq(`${k}=${v}`))
  const command = `env -i ${env.join(" ")} ${sq(WRAPPER)} hq --no-open; echo exit=$? > ${sq(exitFile)}`
  tmux("-f", "/dev/null", "new-session", "-d", "-s", "hq", "-x", "120", "-y", "40", command)
  onTestFinished(() => {
    try {
      tmux("kill-server")
    } catch {}
    // With no TMUX_TMPDIR in its env, the server's socket is here; tmux 2.7 leaves it once the server has gone.
    fs.rmSync(path.join("/tmp", `tmux-${process.getuid!()}`, server), { force: true })
  })
  const screen = () => {
    try {
      return tmux("capture-pane", "-p", "-t", "hq")
    } catch {
      return ""
    }
  }
  return {
    screen,
    /** Waits until the window shows `text`. */
    async see(text: string, ms = 60_000) {
      const deadline = performance.now() + ms
      while (!screen().includes(text)) {
        if (fs.existsSync(exitFile)) throw new Error(`opencorp hq ended before showing ${text}: ${fs.readFileSync(exitFile, "utf8")}`)
        if (performance.now() > deadline) throw new Error(`no ${text} within ${ms} ms:\n${screen()}`)
        await Bun.sleep(100)
      }
    },
    keys: (...keys: string[]) => void tmux("send-keys", "-t", "hq", ...keys),
    /** Types `text` as is, then Enter. */
    type: (text: string) => {
      tmux("send-keys", "-t", "hq", "-l", text)
      tmux("send-keys", "-t", "hq", "Enter")
    },
    /** The `exit=N` line, once the command ended. */
    async exit(ms = 30_000) {
      const deadline = performance.now() + ms
      while (!fs.existsSync(exitFile) || !fs.readFileSync(exitFile, "utf8").includes("\n")) {
        if (performance.now() > deadline) throw new Error(`opencorp hq didn't end within ${ms} ms:\n${screen()}`)
        await Bun.sleep(100)
      }
      return fs.readFileSync(exitFile, "utf8").trim()
    },
  }
}

describe.skipIf(!TMUX)("on a real terminal", () => {
  let remote: TestOffice
  let app: string
  beforeAll(async () => {
    app = builtApp(fs.mkdtempSync("/tmp/oc-app-"))
    remote = await startOffice({ hq: { tcp: false, app_dir: app } })
  }, 120_000)
  afterAll(async () => {
    await remote?.stop()
    fs.rmSync(app, { recursive: true, force: true })
  })

  // This can't show that the visit quiets stdin after the question: clack already leaves raw mode and stops reading
  // when its prompt closes, so here the keys reach ssh either way. office's visit.test.ts checks the call itself.
  test("after approving reach.sh, ssh reads the one password from the terminal, and Bun takes none of the keys", async () => {
    const c = await client(remote, { behavior: { hosts: { login1: { login: "tty" } } }, approved: false })
    onTestFinished(() => removeClient(c))
    const t = terminal(c)
    await t.see("Run this reach.sh on every visit?")
    // The default is Stop; Up picks Use it.
    t.keys("Up")
    t.keys("Enter")
    await t.see("fake password for login1:")
    t.type("hunter2")
    await t.see("Connected.")
    // The node's hop rode login1's master: no second prompt.
    expect(c.fake.tty()).toEqual(["hunter2"])
    expect(t.screen()).not.toContain("fake password for node1:")
    t.keys("C-c")
    expect(await t.exit()).toBe("exit=0")
    expect(c.fake.masters()).toEqual([])
    expect(pidsNaming(c.hq)).toEqual([])
  }, 120_000)

  test("with a password on both hosts it asks once per host", async () => {
    const c = await client(remote, { behavior: { hosts: { login1: { login: "tty" }, node1: { login: "tty" } } } })
    onTestFinished(() => removeClient(c))
    const t = terminal(c)
    await t.see("fake password for login1:")
    t.type("hunter2")
    await t.see("fake password for node1:")
    t.type("hunter3")
    await t.see("Connected.")
    expect(c.fake.tty()).toEqual(["hunter2", "hunter3"])
    t.keys("C-c")
    expect(await t.exit()).toBe("exit=0")
    expect(c.fake.masters()).toEqual([])
    expect(pidsNaming(c.hq)).toEqual([])
  }, 120_000)
})

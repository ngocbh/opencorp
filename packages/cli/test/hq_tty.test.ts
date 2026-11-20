// `opencorp hq` from another machine on a real terminal, in tmux: the approval question and ssh's password prompts
// share it, and every key meant for ssh reaches ssh. Learning, a chat in the TUI, is instrument_tty.test.ts's.
import { afterAll, beforeAll, describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fakeControlName } from "@opencorp/office/testing/fake_ssh"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import { builtApp, type Client, client, pidsNaming, removeClient } from "./remote"
import { type Terminal, TMUX, terminal as tmuxTerminal } from "./tmux"

setDefaultTimeout(30_000)

/** `opencorp hq --no-open` (and `args`) for `c` in a terminal of its own. */
function terminal(
  c: Client,
  { args = [], ...opts }: { args?: string[]; term?: string; size?: [number, number] } = {},
): Terminal {
  return tmuxTerminal(c, ["hq", "--no-open", ...args], opts)
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
    await t.see("Run this 3-line reach.sh on every visit?")
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

  test("with the client's own ControlPath, a visit asks once and leaves the login master in that folder", async () => {
    const c = await client(remote)
    onTestFinished(() => removeClient(c))
    const mine = path.join(c.root, "mine")
    fs.mkdirSync(mine, { mode: 0o700 })
    // The client's ~/.ssh/config, which the fake reads where the visit's config includes it.
    c.fake.set({
      hosts: { login1: { login: "tty" } },
      userConfig: ["Host login1", "  ControlMaster auto", `  ControlPath ${mine}/%C`, "  ControlPersist 60"],
    })
    const t = terminal(c)
    await t.see("fake password for login1:")
    t.type("hunter2")
    await t.see("Connected.")
    expect(c.fake.tty()).toEqual(["hunter2"])
    // The node's hop rode the client's own login master: hq/cm holds only OpenCorp's node master.
    expect(fs.readdirSync(c.cm)).toEqual(["node"])
    t.keys("C-c")
    expect(await t.exit()).toBe("exit=0")
    expect(fs.readdirSync(c.cm)).toEqual([])
    expect(fs.lstatSync(path.join(mine, fakeControlName("login1"))).isSocket()).toBe(true)
    // What's left is the client's login master alone, for their terminals to reuse.
    const left = c.fake.masters()
    expect(left).toHaveLength(1)
    expect(pidsNaming(c.hq)).toEqual(left)
  }, 120_000)
})

/** What a visit says where the TUI can't draw. */
const NEEDS_TUI = "opencorp hq: learning needs a terminal the TUI can draw on"

/** Ctrl-C at a numbered question (a dumb terminal, so the terminal sends SIGINT): the process has to end at once, with
 *  no read left pending on stdin to hold it. `question` as the screen shows it, its trailing space trimmed. */
async function ctrlCEndsIt(t: ReturnType<typeof terminal>, question: string): Promise<void> {
  await t.see(question)
  const sent = performance.now()
  t.keys("C-c")
  while (!t.ended() && performance.now() - sent < 5000) await Bun.sleep(20)
  expect(performance.now() - sent).toBeLessThan(1000)
  expect(await t.exit(5000)).toBe("exit=130")
}

describe.skipIf(!TMUX)("on a dumb terminal", () => {
  test("learning says it needs a terminal the TUI can draw on, without asking", async () => {
    const c = await client(null)
    onTestFinished(() => removeClient(c))
    const t = terminal(c, { term: "dumb" })
    expect(await t.exit()).toBe("exit=3")
    expect(t.screen()).toContain(NEEDS_TUI)
    expect(t.screen()).not.toContain("Learn how to reach HQ from here?")
    expect(fs.readdirSync(c.hq)).toEqual([])
  }, 60_000)

  test("so does relearning, exiting 1", async () => {
    const c = await client(null)
    onTestFinished(() => removeClient(c))
    fs.writeFileSync(path.join(c.hq, "reach.sh"), "exit 3\n", { mode: 0o600 })
    const t = terminal(c, { term: "dumb", args: ["--relearn"] })
    expect(await t.exit()).toBe("exit=1")
    expect(t.screen()).toContain(NEEDS_TUI)
    expect(t.screen()).not.toContain("Relearn?")
  }, 60_000)

  test("Ctrl-C at the numbered question to approve reach.sh ends it at once", async () => {
    const c = await client(null)
    onTestFinished(() => removeClient(c))
    fs.writeFileSync(path.join(c.hq, "reach.sh"), "exit 3\n", { mode: 0o600 })
    await ctrlCEndsIt(terminal(c, { term: "dumb" }), "Run this 1-line reach.sh on every visit? [Stop]:")
    expect(pidsNaming(c.hq)).toEqual([])
  }, 60_000)
})

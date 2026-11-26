// `opencorp init` on a real terminal, in tmux: the model, the password and the remote on the plain terminal, then the
// interview, a chat with OpenCorp in the TUI on the no-office host, whose card the owner says Yes to; then the office
// opens. `opencorp onboard` asks all of its questions on the plain terminal, then the office opens. Each test's home is
// a temp folder whose office.json names a fake model of its own, which answers the model check; every scripted reply
// has a `match`, and each test uses all of them.
import { describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { execFileSync, spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { FakeLLM, LLM_CONFIG, type ScriptedReply } from "@opencorp/office/testing/fake_llm"
import { pidsNaming, WRAPPER } from "./remote"
import { type Terminal, TMUX, terminal } from "./tmux"

setDefaultTimeout(180_000)

/** The model check's request. */
const CHECK = "Reply with the single word OK."
/** The owner's first message in the interview's chat. */
const FIRST = "Set up my company"
/** The password typed at init's prompts. */
const PASSWORD = "pw-sentinel-5d1f-tty"
/** What the agent proposes. */
const ACME = {
  company: "Acme Robotics",
  owner: { name: "Hong Ngoc Bui", handle: "ngocbh", title: "CEO" },
  teammates: [{ name: "Minh", handle: "minh", title: "Engineer", about: "Builds the robots' firmware." }],
}

/** The agent's call of propose_company with `args`, as call `id`, once the request holds `match`. */
function propose(id: string, match: string, args: Record<string, unknown> = ACME): ScriptedReply {
  return { match, tool_calls: [{ id, name: "propose_company", arguments: args }] }
}

/** The agent's words once call `id`'s result reached it. */
function said(id: string, content: string): ScriptedReply {
  return { match: `"tool_call_id":"${id}"`, content }
}

/** Every regular file under `dir` whose bytes hold `text`, links not followed. */
function holding(dir: string, text: string): string[] {
  if (!fs.existsSync(dir)) return []
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => fs.readFileSync(file).includes(text))
}

/** A temp home whose `office/connections/office.json` names a fake model of its own, queued with `script`; a project
 *  folder to run init in; and the env init runs with, nothing else of this process's. */
async function setUp(script: ScriptedReply[]) {
  const llm = await FakeLLM.start()
  onTestFinished(() => llm.close())
  // Short, for the office's socket paths.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc888."))
  const home = path.join(root, "h")
  const project = path.join(root, "project")
  fs.mkdirSync(project)
  const connections = path.join(home, "office", "connections")
  fs.mkdirSync(connections, { recursive: true, mode: 0o700 })
  for (const dir of [home, path.join(home, "office")]) fs.chmodSync(dir, 0o700)
  const provider = { llm_config: LLM_CONFIG, env: llm.env() }
  fs.writeFileSync(path.join(connections, "office.json"), JSON.stringify(provider), { mode: 0o600 })
  llm.script(...script)
  const env = { HOME: root, PATH: "/usr/bin:/bin", OPENCORP_BUN: process.execPath }
  return { llm, root, home, project, env }
}

type Home = Awaited<ReturnType<typeof setUp>>

/** `opencorp init --home <home> --service background` in a terminal of its own, in the project folder. When the test
 *  finishes, after the terminal is gone: the office is stopped, the home goes, and every scripted reply must have been
 *  used (checked last, so a failure there can't skip the cleanup). */
function init(c: Home): Terminal {
  const t = terminal(c, ["init", "--home", c.home, "--service", "background"], { cwd: c.project })
  onTestFinished(() => {
    execFileSync(WRAPPER, ["stop", "--home", c.home], { env: c.env, stdio: "ignore", timeout: 60_000 })
    fs.rmSync(c.root, { recursive: true, force: true })
  })
  onTestFinished(() => expect(c.llm.pending()).toEqual([]))
  return t
}

/** The model, the password twice and no remote, on the plain terminal; then the chat's TUI, once it shows `see`. */
async function untilTheChat(t: Terminal, see = "@opencorp auto") {
  await t.see("Step 1 of 5: Model")
  await t.see("Step 2 of 5: Password")
  await t.see("Your password, to log in new devices with")
  t.type(PASSWORD)
  await t.see("Your password again")
  t.type(PASSWORD)
  await t.see("Step 3 of 5: Remote")
  await t.see("Git remote URL")
  // The default: None for now.
  t.keys("Enter")
  await t.see(see)
}

/** Ctrl-C twice once the chat is idle (`idle`): the chat ends, and with it init, which exits 130. */
async function leave(t: Terminal) {
  await idle(t)
  t.keys("C-c")
  await t.see("Press again to leave")
  t.keys("C-c")
  expect(await t.exit(60_000)).toBe("exit=130")
}

/** Waits until the prompt no longer offers `esc to interrupt`: the employee neither works nor waits. A reply's text
 *  shows before its turn ends, and Ctrl-C while the employee works interrupts the turn and never counts toward
 *  leaving. */
async function idle(t: Terminal, ms = 60_000) {
  const deadline = performance.now() + ms
  while (t.screen().includes("esc to interrupt")) {
    if (performance.now() > deadline) throw new Error(`still at work after ${ms} ms:\n${t.screen()}`)
    await Bun.sleep(100)
  }
}

/** Nothing of the home's is left running, the tmux server aside, once a few seconds have passed. */
async function nothingLeft(c: Home) {
  const left = () =>
    pidsNaming(c.root).filter((pid) => {
      try {
        return !fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith(`${TMUX}\0`)
      } catch {
        return false
      }
    })
  for (const deadline = performance.now() + 5000; left().length > 0 && performance.now() < deadline; )
    await Bun.sleep(100)
  expect(left()).toEqual([])
}

describe.skipIf(!TMUX)("init on a real terminal: the plain steps, then a chat with OpenCorp", () => {
  test("init asks the password without echo and the remote on the terminal, then opens the chat", async () => {
    const c = await setUp([
      { match: CHECK, content: "OK" },
      { match: FIRST, content: "What should your company be called?" },
    ])
    const t = init(c)
    await t.see("Step 1 of 5: Model")
    await t.see(`Model provider: up to date at ${path.join(c.home, "office", "connections", "office.json")}`)
    await t.see("Your password, to log in new devices with")
    t.type(PASSWORD)
    await t.see("Your password again")
    expect(t.screen()).not.toContain(PASSWORD)
    t.type(PASSWORD)
    await t.see("Git remote URL (type it, or pick None for now)")
    expect(t.screen()).toContain("None for now")
    expect(t.alternate()).toBe(false)
    t.keys("Enter")
    await t.see("@opencorp auto")
    await t.see("What should your company be called?")
    expect(t.alternate()).toBe(true)
    await leave(t)
    expect(holding(c.root, PASSWORD)).toEqual([])
    expect(JSON.stringify(c.llm.requests())).not.toContain(PASSWORD)
    await nothingLeft(c)
  })

  test("init's interview is a chat with OpenCorp: its question shows, the owner's answer typed in the chat reaches it, and the company card reads whole before Yes", async () => {
    // Thirty teammates: more than the card has rows for.
    const teammates = Array.from({ length: 30 }, (_, i) => ({
      name: `Mate ${i + 1}`,
      handle: `mate-${i + 1}`,
      title: "Engineer",
      about: "Builds things.",
    }))
    const c = await setUp([
      { match: CHECK, content: "OK" },
      { match: FIRST, content: "What should your company be called?" },
      propose("call_propose", "Acme Robotics", { ...ACME, teammates }),
      said("call_propose", "What should change?"),
    ])
    const t = init(c)
    await untilTheChat(t, "What should your company be called?")
    t.type("Acme Robotics")
    await t.see("OpenCorp wants to create this company")
    await t.see("Read to the end")
    expect(t.screen()).not.toContain("Yes, create it")
    t.keys("End")
    await t.see("Yes, create it")
    expect(t.screen()).toContain("Mate 30 (@mate-30), Engineer: Builds things.")
    t.keys("Down")
    t.keys("Enter")
    await t.see("What should change?")
    const answered = c.llm
      .requests()
      .flatMap((r) => (r.messages as { role: string; tool_call_id?: string; content?: string }[]) ?? [])
      .find((m) => m.role === "tool" && m.tool_call_id === "call_propose")?.content
    expect(answered).toBe("The owner wants changes; ask what to change")
    await leave(t)
    expect(fs.existsSync(path.join(c.home, "company"))).toBe(false)
    // The chat's TUI keeps what the owner typed under --home, as the office's TUI does, so offboard removes it; none
    // of it goes to $HOME/.opencorp.
    expect(holding(path.join(c.home, "tui"), "Acme Robotics")).not.toEqual([])
    expect(fs.existsSync(path.join(c.root, ".opencorp"))).toBe(false)
    await nothingLeft(c)
  })

  test("after Yes the chat closes, nothing more is asked, the company has the chat's answers, and the office opens", async () => {
    const c = await setUp([
      { match: CHECK, content: "OK" },
      propose("call_propose", FIRST),
      said("call_propose", "Acme Robotics is ready."),
    ])
    const t = init(c)
    await untilTheChat(t, "OpenCorp wants to create this company")
    await t.see("Yes, create it")
    t.keys("Enter")
    // The office's TUI, in the project folder, as the CEO: nothing was asked on the terminal in between.
    await t.see("Who do you want to talk to?", 120_000)
    const company = path.join(c.home, "company")
    expect(fs.readFileSync(path.join(company, "company.yaml"), "utf8")).toContain('name: "Acme Robotics"')
    expect(fs.readFileSync(path.join(company, "people", "ngocbh", "person.yaml"), "utf8")).toContain("password_hash")
    expect(fs.readFileSync(path.join(company, "people", "minh", "memory", "profile.md"), "utf8")).toBe(
      "# Minh, Engineer\n\nBuilds the robots' firmware.\n",
    )
    expect(holding(c.root, PASSWORD)).toEqual([])
    // Neither the chat's TUI nor the office's keeps anything in $HOME/.opencorp.
    expect(fs.existsSync(path.join(c.root, ".opencorp"))).toBe(false)
    expect(t.ended()).toBe(false)
  })

  test("leaving the chat stops init with 130, and no company is made", async () => {
    const c = await setUp([{ match: CHECK, content: "OK" }, propose("call_propose", FIRST)])
    const t = init(c)
    // The owner leaves with the card open.
    await untilTheChat(t, "OpenCorp wants to create this company")
    await leave(t)
    expect(fs.existsSync(path.join(c.home, "company"))).toBe(false)
    expect(fs.existsSync(path.join(c.home, "identity.json"))).toBe(false)
    await nothingLeft(c)
  })

  test("a session the model fails says why on the terminal and exits 1; the next init checks the model first", async () => {
    const c = await setUp([
      { match: CHECK, content: "OK" },
      { match: FIRST, error: 400 },
    ])
    const t = init(c)
    await untilTheChat(t, "opencorp init: the model couldn't run the interview:")
    expect(await t.exit()).toBe("exit=1")
    expect(t.screen()).toContain("scripted error 400")
    expect(t.screen()).toContain("it checks the model first and offers to set it up again")
    expect(fs.existsSync(path.join(c.home, "company"))).toBe(false)
    await nothingLeft(c)
    // The next init checks the kept model before anything else, and offers to set it up again.
    c.llm.script({ match: CHECK, error: 500 })
    fs.rmSync(path.join(c.root, "exit"))
    const again = terminal(c, ["init", "--home", c.home, "--service", "background"], { cwd: c.project })
    await again.see("The model didn't answer:")
    await again.see("Set up the model again")
    expect(again.screen()).not.toContain("Step 2 of 5: Password")
    expect(again.alternate()).toBe(false)
    again.keys("C-c")
    expect(await again.exit()).toBe("exit=130")
  })
})

/** `password`'s salted scrypt hash in the PHC form a person.yaml keeps, at a low cost so the test stays quick. */
function phc(password: string): string {
  const salt = crypto.randomBytes(16)
  const b64 = (bytes: Buffer) => bytes.toString("base64").replace(/=+$/, "")
  const key = crypto.scryptSync(password, salt, 32, { N: 2 ** 10, r: 8, p: 1 })
  return `$scrypt$ln=10,r=8,p=1$${b64(salt)}$${b64(key)}`
}

/** `opencorp <argv>` through the wrapper with `c.env` in `cwd`, `input` on stdin; resolves to its exit code and output,
 *  killed after 120 s. Async, since the fake model it may call answers from this process. */
function opencorp(c: Home, argv: string[], input: string, cwd: string): Promise<{ code: number | null; out: string }> {
  const child = spawn(WRAPPER, argv, { cwd, env: c.env, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk))
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk))
  child.stdin.on("error", () => {})
  child.stdin.end(input)
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
  return new Promise((resolve) =>
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    }),
  )
}

/** `opencorp onboard --home <c.home> --from <first> --service background` in a terminal of its own (`term`), in the
 *  project folder, where `first` is a company made first by `opencorp init --provider-stdin` in `<c.root>/first`, its
 *  office stopped, whose CEO @ngocbh has PASSWORD. The first home's init checks its model; the second home's onboard
 *  keeps the model its office.json names. When the test finishes, after the terminal is gone, both offices are
 *  stopped, the home goes, and every scripted reply must have been used. */
async function onboarding(c: Home, term?: string): Promise<Terminal> {
  const first = path.join(c.root, "first")
  const stop = (home: string) =>
    execFileSync(WRAPPER, ["stop", "--home", home], { env: c.env, stdio: "ignore", timeout: 60_000 })
  let t: Terminal | undefined
  // The hooks run in the order they are added: the terminal's own, added after this one, ends it first, and the last
  // one stops the second office and removes the home.
  onTestFinished(() => {
    stop(first)
    if (!t) fs.rmSync(c.root, { recursive: true, force: true })
  })
  const flags = ["--company", "Acme Robotics", "--name", "Hong Ngoc Bui", "--handle", "ngocbh", "--no-device"]
  const provider = JSON.stringify({ llm_config: LLM_CONFIG, env: c.llm.env() })
  const argv = ["init", "--home", first, "--provider-stdin", ...flags, "--service", "background"]
  const made = await opencorp(c, argv, provider, c.root)
  expect(made.code, made.out).toBe(0)
  stop(first)
  // The CEO gets a password, as `opencorp password` would give them one.
  const company = path.join(first, "company")
  const person = path.join(company, "people", "ngocbh", "person.yaml")
  fs.appendFileSync(person, `password_hash: ${JSON.stringify(phc(PASSWORD))}\n`)
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: company,
      env: { ...c.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: "ignore",
      timeout: 30_000,
    })
  git("add", "-A")
  git("commit", "-qm", "Give the CEO a password")
  const command = ["onboard", "--home", c.home, "--from", company, "--service", "background"]
  t = terminal(c, command, { cwd: c.project, ...(term ? { term } : {}) })
  onTestFinished(() => {
    stop(c.home)
    fs.rmSync(c.root, { recursive: true, force: true })
  })
  onTestFinished(() => expect(c.llm.pending()).toEqual([]))
  return t
}

describe.skipIf(!TMUX)("onboard on a real terminal: every question on the plain terminal, then the office", () => {
  test("onboard --from the first home's company asks which human you are and their password on the terminal, then opens the office", async () => {
    const c = await setUp([{ match: CHECK, content: "OK" }])
    const t = await onboarding(c)
    await t.see("Step 1 of 4: Company")
    await t.see("Which of them are you?")
    expect(t.screen()).toContain("ngocbh")
    expect(t.alternate()).toBe(false)
    t.keys("Enter")
    await t.see("@ngocbh's password (not shown)")
    t.type("not-the-password-1")
    await t.see("That doesn't work: wrong password")
    t.type(PASSWORD)
    await t.see(`Model provider: up to date at ${path.join(c.home, "office", "connections", "office.json")}`)
    expect(t.screen()).not.toContain(PASSWORD)
    expect(t.alternate()).toBe(false)
    // The office's TUI, in the project folder, as @ngocbh on this device.
    await t.see("Who do you want to talk to?", 120_000)
    expect(t.alternate()).toBe(true)
    const me = JSON.parse(fs.readFileSync(path.join(c.home, "identity.json"), "utf8"))
    expect(me.handle).toBe("ngocbh")
    expect(fs.readFileSync(path.join(c.home, "company", "people", "ngocbh", "person.yaml"), "utf8")).toContain(me.device)
    expect(holding(c.root, PASSWORD)).toEqual([])
    expect(t.ended()).toBe(false)
  })

  test("on a dumb terminal onboard asks line by line, the password unshown, and opens no office", async () => {
    const c = await setUp([{ match: CHECK, content: "OK" }])
    const t = await onboarding(c, "dumb")
    await t.see("Step 1 of 4: Company")
    // A numbered list and a line to answer it on, not a drawn one.
    await t.see("Which of them are you? [ngocbh]:")
    expect(t.screen()).toContain("1. ngocbh")
    expect(t.alternate()).toBe(false)
    t.keys("Enter")
    await t.see("@ngocbh's password (not shown)")
    t.type(PASSWORD)
    await t.see("Done. Run `opencorp` in a project folder to talk to your team.", 120_000)
    expect(await t.exit(60_000)).toBe("exit=0")
    expect(t.screen()).not.toContain(PASSWORD)
    expect(t.alternate()).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(c.home, "identity.json"), "utf8")).handle).toBe("ngocbh")
    expect(holding(c.root, PASSWORD)).toEqual([])
  })
})

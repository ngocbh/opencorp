// The owner and an employee both write to Claude Code, on a real office, in the TUI on a real terminal, in tmux of the
// test's own: the employee hands the work to Claude Code (the fake, which the office runs as `OPENCORP_CLAUDE_BIN`),
// the owner opens its session as the chat's child session and writes to it mid-turn, and both messages reach Claude
// Code labelled with their authors, in the one turn; the employee's reply carries what the owner said.
import { afterAll, beforeAll, describe, expect, onTestFinished, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { createOfficeClient } from "@opencorp/client"
import { type FakeClaude, installFakeClaude } from "@opencorp/office/testing/fake_claude"
import { startOffice, type TestOffice } from "@opencorp/office/testing/office"
import { pidsNaming } from "./remote"
import { TMUX, terminal } from "./tmux"

setDefaultTimeout(180_000)

/** Words only the chat's requests hold, from its system prompt. */
const CHAT = "You work in the office alongside"

/** Waits until `done()`. */
async function until(done: () => boolean | Promise<boolean>, what: string, ms = 60_000) {
  for (const deadline = performance.now() + ms; !(await done()); await Bun.sleep(100))
    if (performance.now() > deadline) throw new Error(`never: ${what}`)
}

/** Every regular file under `dir` named `name`. */
function named(dir: string, name: string): string[] {
  return (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name))
}

describe.skipIf(!TMUX)("the owner and an employee both write to Claude Code, in the TUI", () => {
  let office: TestOffice
  let fake: FakeClaude
  let root: string
  beforeAll(async () => {
    // Short, for the socket paths; the fake, Claude Code's config folder and the office's own home (the owner's, as
    // its harnesses see it), outside the office's OPENCORP_HOME: nothing reads or writes the real home.
    root = fs.realpathSync(fs.mkdtempSync("/tmp/oc888."))
    fake = installFakeClaude(path.join(root, "fake"), { version: "2.1.325" })
    const config = path.join(root, "claude-config")
    const owner = path.join(root, "owner")
    for (const dir of [config, owner]) fs.mkdirSync(dir, { mode: 0o700 })
    office = await startOffice({ env: { OPENCORP_CLAUDE_BIN: fake.claude, CLAUDE_CONFIG_DIR: config, HOME: owner } })
  }, 180_000)
  afterAll(async () => {
    await office?.stop()
    // Nothing of the fake's outlives the office, and nothing was written to the owner's Claude Code config.
    expect(fs.readdirSync(path.join(root, "claude-config"))).toEqual([])
    for (const deadline = performance.now() + 5000; pidsNaming(root).length > 0 && performance.now() < deadline; )
      await Bun.sleep(100)
    const left = pidsNaming(root)
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true })
    expect(left).toEqual([])
  })

  test("the employee's message and the owner's, sent mid-turn from the child session, reach Claude Code in one turn, each labelled", async () => {
    // minh uses Claude Code, as the owner commits it to the company.
    const company = path.join(office.home, "company")
    const file = path.join(company, "people", "minh", "person.yaml")
    const yaml = fs.readFileSync(file, "utf8")
    const tools = /^tools:.*(?:\n[ \t]*-.*)*$/m
    expect(yaml).toMatch(tools)
    fs.writeFileSync(file, yaml.replace(tools, "tools: [yian, claude]"))
    const identity = ["-c", "user.name=Ngoc", "-c", "user.email=ngoc@example.com"]
    execFileSync("git", ["-C", company, ...identity, "commit", "-qam", "people: minh uses Claude Code"], {
      env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      timeout: 10_000,
    })
    fake.set({
      version: "2.1.325",
      turns: [[{ say: "Looking at the build." }, { sleep: 15 }, { say: "Fixed it, on the staging database." }]],
    })
    office.llm.forget()
    office.llm.script(
      { match: CHAT, tool_calls: [{ id: "call_start", name: "claude_start", arguments: { message: "Fix the build.", wait: 120 } }] },
      { match: `"tool_call_id":"call_start"`, content: "Claude Code fixed the build on staging, as you said." },
    )
    const cwd = path.join(root, "project")
    fs.mkdirSync(cwd)
    const client = createOfficeClient({ socket: office.socket })
    const chat = await client.sessions.create({ person: "minh", cwd })
    const home = path.join(root, "home")
    fs.mkdirSync(home)
    const env = { HOME: home, PATH: "/usr/bin:/bin", OPENCORP_HOME: office.home, OPENCORP_BUN: process.execPath }
    const t = terminal({ env, root }, ["-s", chat.id])
    onTestFinished(() => expect(office.llm.pending()).toEqual([]))
    await t.see("@minh auto")
    t.type("Hand the build to Claude Code.")
    // The line under the prompt counts Claude Code's session while it runs; ↓ opens the picker on it, and Enter opens
    // it as the chat's child session.
    await t.see("1 Claude Code session")
    t.keys("Down")
    await t.see("Claude Code: claude 1")
    t.keys("Enter")
    await t.see("driven by @minh")
    await t.see("Looking at the build.")
    t.type("Use the staging database.")
    await t.see("Fixed it, on the staging database.")
    // The palette's way back goes to the chat, where minh read both.
    t.keys("C-p")
    await t.see("Commands")
    t.keys("-l", "Go back to the chat")
    await t.see("Go back to the chat that drives")
    t.keys("Enter")
    await t.see("Claude Code fixed the build on staging, as you said.")

    // Claude Code read both, each inside its author's label, the owner's sent as next, in the one turn.
    const users = fake.log().filter((e) => e.dir === "in" && e.msg?.type === "user").map((e) => e.msg!)
    expect(users.map((m) => m.message.content[0].text)).toEqual([
      '<authored_message author="@minh">\nFix the build.\n</authored_message>',
      '<authored_message author="Ngoc (owner)">\nUse the staging database.\n</authored_message>',
    ])
    expect(users.map((m) => m.priority)).toEqual(["next", "next"])
    const result = fake.log().find((e) => e.dir === "out" && e.msg?.type === "result")!.msg!
    expect(result.user_message_uuids).toEqual(users.map((m) => m.uuid))
    // minh's reply held what the owner said, its author the office's.
    const reply = office.llm
      .requests()
      .flatMap((r) => (r.messages as { role: string; tool_call_id?: string; content?: string }[]) ?? [])
      .find((m) => m.role === "tool" && m.tool_call_id === "call_start")?.content
    expect(JSON.parse(reply!).output).toEqual([
      { author: "@minh", text: "Fix the build." },
      { author: "claude", text: "Looking at the build." },
      { author: "Ngoc (owner)", text: "Use the staging database." },
      { author: "claude", text: "Fixed it, on the staging database." },
    ])
    // The child session, and its record in the chat's folder.
    const [child] = (await client.sessions.instruments(chat.id)).filter((i) => i.kind === "claude")
    expect(child).toMatchObject({ name: "claude 1", driver: "minh", profile: "harness" })
    expect(await client.sessions.get(child!.id)).toMatchObject({ kind: "instrument", harness: "claude", instrument_of: chat.id })
    const [log] = named(path.join(office.home, "office"), "conversation.log").filter((f) => f.includes(child!.id))
    expect(fs.readFileSync(log!, "utf8")).toContain('<authored_message author="Ngoc (owner)">\nUse the staging database.')
    // The chat ends, and its Claude Code session with it.
    await client.sessions.end(chat.id)
    await until(async () => (await client.sessions.get(child!.id)).status === "ended", "the Claude Code session's end")
  })
})

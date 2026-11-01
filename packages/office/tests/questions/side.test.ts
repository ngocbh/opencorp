/** A side session's run spec, its discussion and its seed file (Python's `tests/questions/test_side.py`). */
import { expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { RunLogEntry } from "@ngocbh/yian/run"
import type { Message, Part, Session } from "@opencorp/protocol"
import { type RunSpec, sideSpec } from "../../src/chat/run_spec.ts"
import { HarnessError } from "../../src/chat/state.ts"
import { Transcript } from "../../src/chat/transcript.ts"
import { FlowOutsideRepo, loadConfined } from "../../src/company/flows.ts"
import { CompanyGit } from "../../src/company/git.ts"
import { loadRepo } from "../../src/company/loader.ts"
import { Monitor } from "../../src/perm/monitor.ts"
import { discussion, readSeed, SEED_FILE, writeSeed } from "../../src/questions/side.ts"
import { PrivateFileError, SecretStore } from "../../src/secrets.ts"
import { newId, type SessionRecord } from "../../src/store/store.ts"
import { READ_TOOLS } from "../../src/tools/workspace.ts"
import type { Delivery } from "../../src/worker/job.ts"
import { fakeLlm, logPrefix, makeHarness, ROOT, send, TemplateOffice, waitingChat } from "../chat/helpers.ts"
import { baseFiles, person, writeRepo } from "../company/helpers.ts"
import { tempDir, waitFor } from "../helpers.ts"
import { sandboxAvailable } from "../sandbox/helpers.ts"
import { openStore, question, session } from "../store/helpers.ts"
import { advanceJob, run, type TestWorker } from "../worker/helpers.ts"

setDefaultTimeout(30_000)

function text(t: string): Part {
  return { id: newId(), type: "text", text: t }
}

function tool(): Part {
  return {
    id: newId(),
    type: "tool",
    call_id: "c1",
    tool: "read_file",
    state: "completed",
    input: { path: "a" },
    output: "secret file text",
    error: null,
  }
}

function message(sessionId: string, parts: Part[], role: "user" | "assistant" = "assistant"): Message {
  return { id: newId(), session_id: sessionId, role, author: null, parts, created_at: new Date().toISOString() }
}

/** Each entry as its role and text. */
function pairs(entries: { role: string; text: string }[]): [string, string][] {
  return entries.map((e) => [e.role, e.text])
}

test("the discussion is human messages and final reply text", () => {
  const store = openStore()
  const side = store.createSession(session({ kind: "side", status: "idle" }))
  const messages = [
    message(side.id, [text("why not fail fast?")], "user"),
    message(side.id, [text("Let me look."), tool(), text("The sandbox is rate-limited.")]),
    message(side.id, [text("ok"), text("and retries?")], "user"),
    message(side.id, [tool()]), // a reply that was stopped before any text
  ]
  const transcript = { messages: () => messages, runningReply: () => null }
  expect(pairs(discussion(store, transcript, side.id))).toEqual([
    ["user", "why not fail fast?"],
    ["assistant", "The sandbox is rate-limited."],
    ["user", "ok\n\nand retries?"],
  ])
})

/** A template office whose tool calls first deliver `delivery` to the run and wait for its reply. */
class DeliverDuringTool extends TemplateOffice {
  constructor(private readonly delivery: Delivery) {
    super()
  }

  override async toolCall(worker: TestWorker, group: string, name: string, args: Record<string, unknown>) {
    await worker.deliver(this.delivery)
    const delivered = () => this.replies.some((reply) => reply.id === this.delivery.id)
    await waitFor(delivered, { timeout: 10_000, what: "the reply" })
    return await super.toolCall(worker, group, name, args)
  }
}

test("an idle side sessions last reply is final", () => {
  const store = openStore()
  const side = store.createSession(session({ kind: "side", status: "idle", run_ids: ["r1"] }))
  const messages = [message(side.id, [text("why?")], "user"), { ...message(side.id, [text("Because")]), id: "r1:9" }]
  const transcript = { messages: () => messages, runningReply: () => "r1:1" }
  expect(pairs(discussion(store, transcript, side.id))).toEqual([
    ["user", "why?"],
    ["assistant", "Because"],
  ])
})

// starting: its first reply runs; waiting: held at its cost cap, the reply not final; ending: End's copy can land
// while the reply it stops still runs
test.each(["starting", "busy", "waiting", "ending"] as const)("a reply still running is not in the discussion [%s]", async (left) => {
  const fake = await fakeLlm()
  fake.script({ content: "Let me look.", tool_calls: [{ id: "c1", name: "toolbox_stub" }] }, { content: "Because" })
  const runs = tempDir()
  const job = await waitingChat(fake, "chat", {}, { runs })
  const office = new DeliverDuringTool(send("during", "and retries?"))
  await run(advanceJob(job, { deliver: [send("s1", "why?")] }), office, { env: fake.env() })
  const store = openStore()
  const side = store.createSession(session({ kind: "side", status: left, run_ids: ["r1"] }))
  const reply = (entry: RunLogEntry) => entry.nodeId === "chat#0/reply"
  const step = (entry: RunLogEntry) => (entry.envelope.record as unknown as { step: { kind: string } }).step
  /** The discussion read from the log's leading records while `keep` holds. */
  const upTo = (keep: (entry: RunLogEntry) => boolean) => {
    const cut = tempDir()
    logPrefix(job.log, keep, cut)
    return discussion(store, new Transcript(cut), side.id)
  }
  // The send is committed but not read yet: a queued message, which stays.
  const beforeSteer = upTo((entry) => !(reply(entry) && entry.kind === "node_step" && step(entry).kind === "steer"))
  expect(pairs(beforeSteer)).toEqual([
    ["user", "why?"],
    ["user", "and retries?"],
  ])
  // The reply is split by the steer and still running: both halves are left out.
  const beforeEnd = upTo((entry) => !(reply(entry) && entry.kind === "node_succeeded"))
  expect(beforeEnd.map((e) => e.role)).toEqual(["user", "user"])
  // The reply is final once it finished, though the session still says busy or waiting.
  expect(pairs(upTo(() => true))).toEqual([
    ["user", "why?"],
    ["assistant", "Let me look."],
    ["user", "and retries?"],
    ["assistant", "Because"],
  ])
})

test("a seed is a private file read back as written", () => {
  const root = tempDir()
  const dir = path.join(root, "sessions", "s1")
  const file = path.join(dir, SEED_FILE)
  const mode = (p: string) => fs.lstatSync(p).mode & 0o777
  writeSeed(dir, "SEED")
  expect(mode(dir)).toBe(0o700)
  expect(mode(file)).toBe(0o600)
  expect(readSeed(dir)).toBe("SEED")

  const open = path.join(root, "open")
  fs.mkdirSync(open, { mode: 0o700 })
  fs.writeFileSync(path.join(open, SEED_FILE), "old")
  fs.chmodSync(path.join(open, SEED_FILE), 0o644)
  writeSeed(open, "SEED")
  expect(mode(path.join(open, SEED_FILE))).toBe(0o600)
  expect(readSeed(open)).toBe("SEED")

  expect(readSeed(path.join(root, "sessions", "s2"))).toBeNull()

  const linked = path.join(root, "linked")
  const target = path.join(root, "target")
  fs.mkdirSync(linked, { mode: 0o700 })
  fs.writeFileSync(target, "TARGET", { mode: 0o600 })
  fs.symlinkSync(target, path.join(linked, SEED_FILE))
  expect(() => readSeed(linked)).toThrow()
  writeSeed(linked, "SEED")
  expect(fs.lstatSync(path.join(linked, SEED_FILE)).isFile()).toBe(true)
  expect(readSeed(linked)).toBe("SEED")
  expect(fs.readFileSync(target, "utf8")).toBe("TARGET")

  fs.chmodSync(file, 0o640)
  expect(() => readSeed(dir)).toThrow()

  const shared = path.join(root, "shared")
  fs.mkdirSync(shared)
  fs.chmodSync(shared, 0o777)
  expect(() => writeSeed(shared, "SEED")).toThrow(PrivateFileError)
  expect(fs.readdirSync(shared)).toEqual([])
  fs.writeFileSync(path.join(shared, SEED_FILE), "PLANTED", { mode: 0o600 })
  expect(() => readSeed(shared)).toThrow(PrivateFileError)

  const real = path.join(root, "real")
  const alias = path.join(root, "alias")
  fs.mkdirSync(real, { mode: 0o700 })
  fs.writeFileSync(path.join(real, SEED_FILE), "REAL", { mode: 0o600 })
  fs.symlinkSync(real, alias)
  expect(() => writeSeed(alias, "SEED")).toThrow(PrivateFileError)
  expect(() => readSeed(alias)).toThrow(PrivateFileError)
  expect(fs.readdirSync(real)).toEqual([SEED_FILE])
  expect(fs.readFileSync(path.join(real, SEED_FILE), "utf8")).toBe("REAL")
})

const SIDE_CHAT_FLOW = "shared/flows/side_chat.yaml"

/** Stands in for `WorkspaceTools`: building a spec's tools never runs the workspace. */
const NO_WORKSPACE = {
  call: (): never => {
    throw new Error("the workspace is never called")
  },
  interrupt: (): never => {
    throw new Error("the workspace is never interrupted")
  },
}

/** The base company with human lan (no side chat flow in it), its git, a store, a monitor, and `side`: a side
 *  session about a question from a session of minh's, with `over` applied, and its spec. */
async function office() {
  const dir = tempDir()
  const root = writeRepo(path.join(dir, "company"), {
    ...baseFiles(),
    "people/lan/person.yaml": { handle: "lan", name: "Lan", kind: "human", title: "Designer", manager: "ngocbh" },
  })
  const git = new CompanyGit(root, path.join(dir, "worktrees"))
  const store = openStore()
  const monitor = new Monitor(root, store, new SecretStore(path.join(dir, "secrets")))
  const repo = loadRepo(root)
  const head = await git.head()
  const asker = store.createSession(session({ repo_commit: head }))
  const asked = store.addQuestion(question(asker.id))
  const side = (over: Partial<Session> = {}) => {
    const s = store.createSession(
      session({ repo_commit: head, kind: "side", question_id: asked.id, status: "starting", ...over }),
    )
    const spec = sideSpec({ store, git, repo, session: s, workspace: NO_WORKSPACE, monitor, question: asked })
    return { session: s, spec }
  }
  return { dir, git, head, repo, side }
}

test("a side run gets the askers identity and who opened it", async () => {
  const o = await office()
  expect(o.side().spec.inputs).toEqual({
    person: {
      name: "Minh",
      handle: "minh",
      title: "Engineer",
      company: "test-corp",
      reports_to: "You report to Hong Ngoc Bui (@ngocbh).",
    },
    talking_to: "You're talking with Hong Ngoc Bui (@ngocbh), the CEO and your manager.",
    max_turns: 500,
    history_budget: o.repo.company!.defaults!.side_seed_max_chars + 32000,
  })
  expect(o.side({ opened_by: "lan" }).spec.inputs.talking_to).toBe("You're talking with Lan (@lan), your peer.")
})

test("a side run offers read tools then work items", async () => {
  const { session: side, spec } = (await office()).side()
  const groups = spec.groups({ session: side, runId: "run-1" })
  expect(Object.entries(groups).map(([g, t]) => [g, Object.keys(t)])).toEqual([
    ["workspace", ["read_file", "list", "search"]],
    ["work_items", ["list_work_items", "read_work_item"]],
  ])
})

const LINKS = [SIDE_CHAT_FLOW, "shared/flows"]

test.each(LINKS)("a side chat flow linked from outside the pin is refused [%s]", async (link) => {
  const o = await office()
  const pin = await o.git.pin(o.head)
  const flows = path.join(o.dir, "outside", "flows")
  fs.cpSync(path.join(pin, "shared/flows"), flows, { recursive: true }) // the other flows stay reachable
  fs.writeFileSync(path.join(flows, "side_chat.yaml"), fs.readFileSync(path.join(ROOT, SIDE_CHAT_FLOW)))
  // A pin's folders stay writable; only its files are read-only.
  if (link === "shared/flows") fs.rmSync(path.join(pin, "shared/flows"), { recursive: true })
  fs.symlinkSync(link === SIDE_CHAT_FLOW ? path.join(flows, "side_chat.yaml") : flows, path.join(pin, link))
  await expect(loadConfined(pin, path.join(pin, SIDE_CHAT_FLOW))).rejects.toBeInstanceOf(FlowOutsideRepo)
})

const SIDE_FLOW = fs.readFileSync(path.join(ROOT, SIDE_CHAT_FLOW), "utf8")

type Harness = Awaited<ReturnType<typeof makeHarness>>

/** A `starting` side session in `cwd` about a question from a main chat of minh's, both at the company's head, with
 *  `over`. */
async function sideOf(h: Harness, cwd: string, over: Partial<Session> = {}): Promise<SessionRecord> {
  const head = await h.office.git.head()
  const asker = h.store.createSession(session({ cwd, repo_commit: head }))
  const asked = h.store.addQuestion(question(asker.id))
  return h.store.createSession(
    session({ cwd, repo_commit: head, kind: "side", question_id: asked.id, status: "starting", ...over }),
  )
}

/** The HTTP status `spec`'s workspace shell gets from the fake LLM at `url`, followed by the shell's `[exit N]` line
 *  when curl fails: the output starts with `000` when it can't connect. */
async function curl(workspace: RunSpec["workspace"], url: string): Promise<string> {
  return (await workspace!.call("shell", { command: `curl -s -m 5 -o /dev/null -w '%{http_code}' ${url}` })).output
}

/** A harness whose company gives minh a workspace-write, online `harness_policy` and ships the side chat flow, a
 *  `notes.txt` in its folder, and a `starting` side session there. */
async function sideInFolder(fake: Awaited<ReturnType<typeof fakeLlm>>) {
  const minh = person("minh", { harness_policy: { sandbox: "workspace-write", network: true } })
  const h = await makeHarness(fake, {
    files: { [SIDE_CHAT_FLOW]: SIDE_FLOW, "people/minh/person.yaml": minh },
    defaults: { side_seed_max_chars: 1000 },
  })
  const notes = path.join(h.folder, "notes.txt")
  fs.writeFileSync(notes, "the build is red\n")
  return { h, notes, side: await sideOf(h, h.folder) }
}

test("a side run reads the workspace but cannot change it", async () => {
  // minh's own harness_policy is workspace-write and online; a side chat is read-only and offline anyway (its tools
  // run under the sandbox, so the sandbox test below checks them).
  const { h, side } = await sideInFolder(await fakeLlm())
  const spec = await h.harness.spec(side)
  expect([spec.flow, spec.chat.turn]).toEqual([SIDE_CHAT_FLOW, "chat/heard"])
  expect(spec.inputs.history_budget).toBe(1000 + 32000)
  const groups = spec.groups({ session: side, runId: "run-1" })
  expect(Object.keys(groups).sort()).toEqual(["work_items", "workspace"])
  expect(Object.keys(groups.workspace!)).toEqual([...READ_TOOLS])
})

test.if(sandboxAvailable())("a side chats workspace refuses the writes and network a main chat has", async () => {
  const fake = await fakeLlm()
  const { h, notes, side } = await sideInFolder(fake)
  const spec = await h.harness.spec(side)
  const read = spec.groups({ session: side, runId: "run-1" }).workspace!.read_file!
  expect(String(await read.call({ path: "notes.txt" }))).toContain("the build is red")
  await spec.workspace!.call("write_file", { path: "notes.txt", content: "fixed\n" })
  expect(fs.readFileSync(notes, "utf8")).toBe("the build is red\n")
  expect(await curl(spec.workspace, fake.baseUrl)).toMatch(/^000/)
  const main = await h.harness.spec({ ...side, kind: "main", question_id: null })
  await main.workspace!.call("write_file", { path: "notes.txt", content: "fixed\n" })
  expect(fs.readFileSync(notes, "utf8")).toBe("fixed\n")
  expect(await curl(main.workspace, fake.baseUrl)).toMatch(/^[1-5]\d\d\n\[exit 0\]$/)
})

test("a side run in the office files is refused", async () => {
  const h = await makeHarness(await fakeLlm(), { files: { [SIDE_CHAT_FLOW]: SIDE_FLOW } })
  const error = await h.harness.spec(await sideOf(h, h.office.paths.company)).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(HarnessError)
  expect([(error as HarnessError).status, (error as HarnessError).code]).toEqual([422, "unsafe_workspace"])
})

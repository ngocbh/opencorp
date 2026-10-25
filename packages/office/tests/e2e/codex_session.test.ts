/** The phase 3 milestone (design §11) end to end: `opencorp init` through the checkout wrapper starts a TS office
 *  in the background, and requests over its socket run a Codex session on `fake_codex.ts`, put first on `PATH` as
 *  `codex`: a streamed part, an approval card answered, the turn's end and the session's. It joins the cut-over
 *  gate (§10.4). Nothing touches the owner's home, a real Codex or a real service manager. */
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import type { LiveEvent, Question, Session } from "@opencorp/protocol"
import { expect, test } from "bun:test"
import { parse, stringify } from "yaml"
import { args } from "../../src/install/proc.ts"
import * as fc from "../../src/testing/fake_codex.ts"
import { FakeLLM, LLM_CONFIG } from "../../src/testing/fake_llm.ts"
import { git, gitEnv } from "../company/helpers.ts"
import { frames, request } from "../daemon/helpers.ts"
import { ps, shortDir, waitFor } from "../helpers.ts"

const REPO = path.resolve(import.meta.dirname, "../../../..")
const OPENCORP = path.join(REPO, "packages/cli/bin/opencorp")
const FAKE = path.join(REPO, "packages/office/src/testing/fake_codex.ts")
const SERVICE_TOOLS = ["launchctl", "systemctl", "loginctl", "tmux"]

/** `s` single-quoted for sh. */
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** Writes an executable sh script at `file`. */
function script(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/sh\n${body}`, { mode: 0o755 })
}

/** Sends `method target` with `body` as JSON over `socket`; resolves with the status and the parsed body. */
async function call(socket: string, method: string, target: string, body?: unknown) {
  const sent = body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  const reply = await request(socket, method, target, sent)
  return { status: reply.status, body: reply.json() as any }
}

/** The body of a 200 reply to `method target`; throws with the reply otherwise. */
async function ok(socket: string, method: string, target: string, body?: unknown) {
  const reply = await call(socket, method, target, body)
  if (reply.status !== 200) throw new Error(`${method} ${target}: ${reply.status} ${JSON.stringify(reply.body)}`)
  return reply.body
}

/** Runs `argv` with `input` on stdin; resolves with its exit code and output, killing it after 120 s. Async, since
 *  the fake LLM it calls answers from this process. */
function run(argv: string[], input: string, opts: { cwd: string; env: Record<string, string> }) {
  const child = spawn(argv[0]!, argv.slice(1), { ...opts, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  // An init that exits before reading stdin, or fails to spawn, reports through `close` or `error` instead.
  child.stdin.on("error", () => {})
  child.stdin.end(input)
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** The pids of every process, other than this one, whose command line contains `root`. */
function under(root: string): number[] {
  return execFileSync(ps(), ["-wwaxo", "pid=,command="], {
    env: { LC_ALL: "C.UTF-8" },
    encoding: "utf8",
    timeout: 5000,
  })
    .split("\n")
    .filter((line) => line.includes(root))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => pid !== process.pid)
}

/** Stops the office on `home` (SIGTERM, then SIGKILL after 15 s) and SIGKILLs every process naming `root`; fails if
 *  one is still listed after 5 s. */
async function stopAll(root: string, home: string): Promise<void> {
  const pidfile = path.join(home, "office", "office.pid")
  if (fs.existsSync(pidfile)) {
    const pid = Number.parseInt(fs.readFileSync(pidfile, "utf8"), 10)
    // The pid may have been reused by another process: signal it only while its command line names this home.
    const ours = () => args(pid, ps())?.includes(home) ?? false
    // The office may exit between the check and the signal (ESRCH).
    if (ours()) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {}
      try {
        await waitFor(() => !ours(), { timeout: 15_000, what: "the office to stop" })
      } catch {
        try {
          if (ours()) process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
  }
  for (const pid of under(root)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  await waitFor(() => under(root).length === 0, { timeout: 5000, what: "every process under the test's folder to go" })
}

test(
  "a codex session on a wrapper started office streams a part takes a card answer and ends",
  async () => {
    const root = shortDir()
    const home = path.join(root, "h")
    fs.mkdirSync(path.join(home, "office"), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(home, "office", "hq.json"), JSON.stringify({ tcp: false }))
    const codexDir = path.join(root, "codex")
    fs.mkdirSync(codexDir)
    const rpcLog = path.join(codexDir, "rpc.jsonl")
    const scriptFile = path.join(codexDir, "script.json")
    fs.writeFileSync(
      scriptFile,
      JSON.stringify({
        turns: [
          [
            ...fc.agentMessage("m1", "I'll create hello.txt."),
            fc.commandStarted("c1", "touch hello.txt"),
            fc.commandApproval(1, "c1", "touch hello.txt"),
            fc.command("c1", "touch hello.txt")[1],
            ...fc.agentMessage("m2", "Done."),
          ],
        ],
      }),
    )
    const tools = path.join(root, "tools", "bin")
    fs.mkdirSync(tools, { recursive: true })
    // Bun in a fixed cwd and env, reading no .env or bunfig.toml there.
    script(
      path.join(tools, "codex"),
      `cd ${q(codexDir)} || exit 1\n` +
        `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=${q(codexDir)} ${q(process.execPath)} --no-install ` +
        `--no-env-file --config=/dev/null ${q(FAKE)} --script ${q(scriptFile)} --log ${q(rpcLog)} "$@"\n`,
    )
    const calls = path.join(root, "calls.log")
    for (const name of SERVICE_TOOLS) script(path.join(tools, name), `echo "${name} $*" >> ${q(calls)}\nexit 1\n`)
    const workspace = path.join(root, "project")
    fs.mkdirSync(workspace)
    fs.writeFileSync(path.join(workspace, "README.md"), "# Demo\n\nStatus: TODO\n")
    const { OPENCORP_CODEX_BIN: _, ...base } = gitEnv(process.env)
    const env = {
      ...base,
      PATH: `${tools}:${process.env.PATH}`,
      OPENCORP_HOME: home,
      OPENCORP_BUN: process.execPath,
    }
    const socket = path.join(home, "office", "office.sock")
    const llm = await FakeLLM.start()
    let events: http.ClientRequest | undefined
    let failed = false
    try {
      llm.script({ content: "OK", match: "Reply with the single word OK." })
      const init = await run(
        [
          OPENCORP,
          "init",
          "--home",
          home,
          "--provider-stdin",
          "--company",
          "Acme",
          "--name",
          "Ngoc",
          "--handle",
          "ngocbh",
          "--service",
          "background",
          "--no-device",
        ],
        JSON.stringify({ llm_config: LLM_CONFIG, env: llm.env() }),
        { cwd: home, env },
      )
      if (init.code !== 0 || !init.stdout.includes("with you as CEO and Minh (@minh)"))
        throw new Error(`opencorp init exited ${init.code}:\n${init.stdout}${init.stderr}`)

      // The office loads a session's person from the company's HEAD, so the edit is committed.
      const company = path.join(home, "company")
      const personFile = path.join(company, "people", "minh", "person.yaml")
      const minh = parse(fs.readFileSync(personFile, "utf8")) as Record<string, unknown>
      minh.harnesses = ["composer", "codex"]
      fs.writeFileSync(personFile, stringify(minh))
      git(company, "commit", "-qam", "minh uses codex")

      // The folder holding the pinned codex's folder is refused as a workspace.
      const refused = await call(socket, "POST", "/sessions", {
        person: "minh",
        cwd: path.join(root, "tools"),
        harness: "codex",
      })
      expect([refused.status, refused.body.error]).toEqual([422, "unsafe_workspace"])

      const cwd = fs.realpathSync(workspace)
      const created: Session = await ok(socket, "POST", "/sessions", { person: "minh", cwd, harness: "codex" })
      expect(created.harness).toBe("codex")
      const sid = created.id
      const statusIs = async (want: string) => ((await ok(socket, "GET", `/sessions/${sid}`)) as Session).status === want
      await waitFor(() => statusIs("idle"), { timeout: 60_000, what: "the Codex session to load" })

      let connected = false
      let streamError: unknown
      const live: LiveEvent[] = []
      /** Whether `check()` holds; throws the event stream's error once it has one. */
      const streamed = (check: () => boolean) => {
        if (streamError !== undefined) throw streamError
        return check()
      }
      events = http.request({ socketPath: socket, path: `/events?session=${sid}`, agent: false }, (res) => {
        // The cleanup's destroy cuts the stream, which then errors with nobody reading it.
        res.on("error", () => {})
        void (async () => {
          for await (const [kind, , data] of frames(res)) {
            if (kind === "comment" && data === "connected") connected = true
            else if (kind === "live") live.push(data as LiveEvent)
          }
        })().catch((error) => (streamError = error))
      })
      events.on("error", () => {})
      events.end()
      await waitFor(() => streamed(() => connected), { what: "the event stream" })

      expect(await ok(socket, "POST", `/sessions/${sid}/prompt`, { text: "Create hello.txt" })).toEqual({ ok: true })
      await waitFor(
        () => streamed(() => live.some((e) => ["part.updated", "part.delta"].includes(e.type) && e.session_id === sid)),
        { what: "a streamed part" },
      )

      const card: Question = await waitFor(
        async () => ((await ok(socket, "GET", `/questions?session=${sid}&status=open`)) as Question[])[0],
        { what: "the approval card" },
      )
      expect(card.source).toBe("harness")
      expect(card.options).toContain("Approve")
      const answer = { answer: "Approve", answer_kind: "option" }
      const answered: Question = await ok(socket, "POST", `/questions/${card.id}/answer`, answer)
      expect(answered.status).toBe("consumed")

      await waitFor(() => statusIs("idle"), { what: "the turn to end" })
      const entries = () =>
        fs
          .readFileSync(rpcLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { dir: string; msg: Record<string, any> })
      await waitFor(() => entries().some((e) => e.dir === "out" && e.msg.method === "turn/completed"), {
        what: "the fake to complete the turn",
      })
      const read = entries()
      expect(read.some((e) => e.dir === "in" && e.msg.method === "thread/start")).toBe(true)
      const replies = read.filter((e) => e.dir === "in" && e.msg.id === 1 && !("method" in e.msg))
      expect(replies.map((e) => e.msg.result)).toEqual([{ decision: "accept" }])

      expect(await ok(socket, "POST", `/sessions/${sid}/end`)).toEqual({ ok: true })
      await waitFor(() => statusIs("ended"), { what: "the session to end" })
      expect(await ok(socket, "GET", `/sessions/${sid}/messages`)).toEqual([])
      expect(fs.existsSync(calls)).toBe(false)
    } catch (error) {
      failed = true
      throw error
    } finally {
      events?.destroy()
      try {
        try {
          await stopAll(root, home)
        } finally {
          await llm.close()
        }
      } catch (error) {
        // The body's failure is the cause to report; a cleanup error replaces only a pass.
        if (!failed) throw error
      }
    }
  },
  180_000,
)

/** Instrument routes: a session's live instruments, a shell's screen for a late join, and the approver's keys, size and
 *  close.
 *  Each test opens its own shell on a plain PTY (or a pipes shell on a stand-in call) and adds it to the office's
 *  registry, as a terminal's host does; no route opens one. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, onTestFinished, setDefaultTimeout, spyOn, test } from "bun:test"
import { Instrument, type InstrumentScreen, type LiveEvent, now } from "@opencorp/protocol"
import { spawnPty } from "../../../src/platform.ts"
import { newToken } from "../../../src/runtime/auth/tokens.ts"
import { PING } from "../../../src/runtime/bus.ts"
import type { LiveInstrument } from "../../../src/runtime/sessions/instruments.ts"
import type { Result } from "../../../src/runtime/sandbox/run.ts"
import { newId } from "../../../src/runtime/store/store.ts"
import type { Office } from "../../../src/server/office.ts"
import { type FakeSsh, installFakeSsh } from "../../../src/testing/fake_ssh.ts"
import { type PipeHost, PipeShell } from "../../../src/tools/terminal/pipes.ts"
import { InstrumentRecord } from "../../../src/tools/terminal/record.ts"
import { PtyShell, type ShellState } from "../../../src/tools/terminal/shell.ts"
import { waitFor } from "../../helpers.ts"
import { session } from "../../runtime/store/helpers.ts"
import { CEO, type Reply, addHuman, bearer, giveDevice, makeOffice, request, served } from "../helpers.ts"

setDefaultTimeout(30_000)

const STARTING: ShellState = { status: "starting", waiting: null, command: null, exit: null, error: null }

/** A served office acting on device tokens, with a device for the CEO and one for ava, another human; `logs` gets the
 *  office's log and the request pipeline's lines. */
async function office() {
  const logs: string[] = []
  const o = makeOffice({ log: (line) => logs.push(line) })
  const { sock } = await served(o, { tokens: true, log: (line) => logs.push(line) })
  addHuman(o.paths.company, "ava")
  const ceoToken = newToken()
  const avaToken = newToken()
  giveDevice(o.paths.company, CEO, "mac", ceoToken)
  giveDevice(o.paths.company, "ava", "pc", avaToken)
  return { office: o, sock, logs, ceo: bearer(ceoToken), ava: bearer(avaToken) }
}

/** A fresh folder, removed when the test finishes. */
function folder(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-inst-")))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** What a terminal's host adds for `shell()`, a shell of session `sessionId` that may not be open yet: its state as the
 *  shell has it, the owner's keys and Ctrl-C through `ownerKeys`, the size it was last given, and the owner's close,
 *  whose closer `closedBy` gets. */
function hosted(
  sessionId: string,
  id: string,
  shell: () => PtyShell | PipeShell | undefined,
  size: { cols: number; rows: number } | null,
  closedBy: string[] = [],
): LiveInstrument & { close(by: string): Promise<void> } {
  const created = now()
  return {
    id,
    interactive: size !== null,
    info: () => {
      const { status, waiting, command, error } = shell()?.state() ?? STARTING
      return {
        id,
        session_id: sessionId,
        kind: "terminal",
        name: shell()?.name ?? "shell 1",
        driver: "minh",
        profile: "none",
        interactive: size !== null,
        size,
        status,
        waiting,
        command,
        error,
        created_at: created,
        updated_at: now(),
      }
    },
    keys: (data) => shell()?.ownerKeys(data),
    interrupt: () => shell()?.ownerKeys("\x03"),
    resize: (cols, rows) => {
      size = { cols, rows }
      const pty = shell()
      if (pty instanceof PtyShell) pty.resize(cols, rows)
    },
    close: async (by) => {
      closedBy.push(by)
      await shell()?.close()
    },
  }
}

/** A record for shell `id` in a fresh folder. */
function record(id: string): { record: InstrumentRecord; dir: string } {
  const dir = path.join(folder(), "record")
  const meta = { id, name: "shell 1", kind: "terminal" as const, profile: "none", driver: "minh", started: now() }
  return { record: new InstrumentRecord(dir, meta), dir }
}

/** A PTY shell of session `sessionId` in `office`'s registry, its PATH starting with `fake`'s ssh; closed when the test
 *  finishes. */
async function ptyShell(office: Office, sessionId: string, fake?: FakeSsh) {
  const id = newId()
  const dir = folder()
  const { record: rec, dir: recordDir } = record(id)
  let shell: PtyShell | undefined
  onTestFinished(() => shell?.close())
  office.instruments.add(sessionId, hosted(sessionId, id, () => shell, { cols: 80, rows: 24 }))
  shell = await PtyShell.open(id, "shell 1", {
    start: (argv, io) => spawnPty(argv, { cwd: dir, env: io.env, cols: io.cols, rows: io.rows, onData: io.onData }),
    env: { PATH: `${fake ? `${fake.bin}:` : ""}/usr/bin:/bin`, TERM: "xterm-256color", HOME: dir },
    record: rec,
    driver: "minh",
    changed: () => office.instruments.updated(sessionId, id),
    output: (chunk) => office.instruments.output(sessionId, id, chunk),
  })
  return { shell, id, recordDir }
}

/** A pipes shell of session `sessionId` in `office`'s registry, whose one command's call prints what `print` is given
 *  and runs until it is stopped. */
function pipesShell(office: Office, sessionId: string) {
  const id = newId()
  const { record: rec } = record(id)
  let print: (text: string) => void = () => {}
  const run: PipeHost["run"] = (_argv, options) =>
    new Promise<Result>((resolve) => {
      print = (text) => options.onOutput?.("stdout", Buffer.from(text))
      print("started\n")
      options.signal?.addEventListener("abort", () => {
        const empty = Buffer.alloc(0)
        resolve({
          exit: null,
          stdout: empty,
          stderr: empty,
          stdoutTail: empty,
          stderrTail: empty,
          stdoutBytes: 0,
          stderrBytes: 0,
          timedOut: false,
          interrupted: true,
          truncated: false,
          duration: 0,
          refused: false,
        })
      })
    })
  let shell: PipeShell | undefined
  const closedBy: string[] = []
  office.instruments.add(sessionId, hosted(sessionId, id, () => shell, null, closedBy))
  shell = PipeShell.open(id, "shell 1", {
    run,
    record: rec,
    driver: "minh",
    changed: () => office.instruments.updated(sessionId, id),
    output: (chunk) => office.instruments.output(sessionId, id, chunk),
  })
  onTestFinished(() => shell?.close())
  return { shell, id, print: (text: string) => print(text), closedBy }
}

/** A fake ssh in a short folder of its own, removed when the test finishes. */
function fakeSsh(): FakeSsh {
  const dir = fs.realpathSync(fs.mkdtempSync("/tmp/oc-"))
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }))
  return installFakeSsh(dir, { login: "tty" })
}

/** POSTs `body` as JSON. */
function post(sock: string, target: string, body: unknown, headers: Record<string, string>): Promise<Reply> {
  return request(sock, "POST", target, {
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

const errorOf = (r: Reply) => [r.status, (r.json() as { error: string }).error]

test("a session lists its instruments", async () => {
  const t = await office()
  const s = t.office.store.createSession(session({ opened_by: CEO }))
  const other = t.office.store.createSession(session({ opened_by: CEO }))
  const { id } = await ptyShell(t.office, s.id)
  let r = await request(t.sock, "GET", `/sessions/${s.id}/instruments`, { headers: t.ceo })
  expect(r.status).toBe(200)
  const [listed] = Instrument.array().parse(r.json())
  expect(listed).toMatchObject({ id, session_id: s.id, name: "shell 1", status: "idle", size: { cols: 80, rows: 24 } })
  // Anyone who may read the session may read its list; another session lists none of them.
  r = await request(t.sock, "GET", `/sessions/${s.id}/instruments`, { headers: t.ava })
  expect((r.json() as Instrument[]).map((i) => i.id)).toEqual([id])
  r = await request(t.sock, "GET", `/sessions/${other.id}/instruments`, { headers: t.ceo })
  expect([r.status, r.json()]).toEqual([200, []])
  r = await request(t.sock, "GET", `/sessions/${newId()}/instruments`, { headers: t.ceo })
  expect(errorOf(r)).toEqual([404, "not_found"])
  r = await request(t.sock, "GET", `/sessions/${s.id}/instruments/${newId()}/screen`, { headers: t.ceo })
  expect(errorOf(r)).toEqual([404, "not_found"])
})

test("the approver's keys reach the shell, and at an echo-off prompt nothing records or logs them", async () => {
  const t = await office()
  const s = t.office.store.createSession(session({ opened_by: CEO }))
  const fake = fakeSsh()
  const { shell, id, recordDir } = await ptyShell(t.office, s.id, fake)
  const sub = t.office.bus.subscribe(s.id)
  onTestFinished(() => sub.close())
  const said = (["log", "info", "warn", "error", "debug"] as const).map((name) => spyOn(console, name))
  onTestFinished(() => said.forEach((spy) => spy.mockRestore()))

  const asked = await shell.run("ssh h true", 10_000)
  expect(asked).toMatchObject({ status: "waiting", waiting: "secret" })
  const keys = `/sessions/${s.id}/instruments/${id}/keys`
  // In two pieces, as an owner's keys come.
  expect((await post(t.sock, keys, { data: "pw-0wn" }, t.ceo)).json()).toEqual({ ok: true })
  expect((await post(t.sock, keys, { data: "er\r" }, t.ceo)).json()).toEqual({ ok: true })
  const done = await shell.read({ waitMs: 10_000 })
  expect(done).toMatchObject({ status: "idle", exit: 0 })
  expect(fake.tty()).toEqual(["pw-0wner"])

  // The shell echoed none of it, so no view, record, event or log holds it.
  const screen = (await request(t.sock, "GET", `/sessions/${s.id}/instruments/${id}/screen`, { headers: t.ceo }))
    .json() as InstrumentScreen
  const events: string[] = []
  for (let item = await sub.next(0); item !== null && item !== PING; item = await sub.next(0)) {
    events.push(JSON.stringify(item[1]))
    const bytes = item[0] === "live" ? item[1].data.data : undefined
    if (typeof bytes === "string") events.push(Buffer.from(bytes, "base64").toString())
  }
  const saidText = said.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" ")))
  const records = fs.readdirSync(recordDir).map((name) => fs.readFileSync(path.join(recordDir, name), "utf8"))
  const places = [
    ["the model's view", asked.output + done.output],
    ["the screen", Buffer.from(screen.data, "base64").toString()],
    ["the live events", events.join("\n")],
    ["the record", records.join("\n")],
    ["the console", saidText.join("\n")],
    ["the logs", t.logs.join("\n")],
  ]
  for (const [place, text] of places) expect([place, /pw-|0wn/.test(text!)]).toEqual([place, false])
  expect(Buffer.from(screen.data, "base64").toString()).toContain("fake password for h: ")
  // The instrument shows the agent's command, and nothing built from the keys.
  const list = await request(t.sock, "GET", `/sessions/${s.id}/instruments`, { headers: t.ceo })
  expect((list.json() as Instrument[])[0]).toMatchObject({ status: "idle", command: null })
})

test("anyone else's keys are refused", async () => {
  const t = await office()
  // A chat's opener types into its shells, even over the CEO; a chat nobody opened falls to the CEO at its commit.
  const byAva = t.office.store.createSession(session({ opened_by: "ava" }))
  const unopened = t.office.store.createSession(session({ repo_commit: await t.office.git.head() }))
  for (const [s, may, other] of [
    [byAva, t.ava, t.ceo],
    [unopened, t.ceo, t.ava],
  ] as const) {
    const { shell, id } = await ptyShell(t.office, s.id)
    await shell.run("cat", 300)
    const keys = `/sessions/${s.id}/instruments/${id}/keys`
    expect(errorOf(await post(t.sock, keys, { data: "refused-line\r" }, other))).toEqual([403, "forbidden"])
    expect(errorOf(await post(t.sock, keys, { data: "x" }, {}))).toEqual([401, "unauthenticated"])
    expect((await post(t.sock, keys, { data: "allowed-line\r" }, may)).json()).toEqual({ ok: true })
    const screen = async () => {
      const r = await request(t.sock, "GET", `/sessions/${s.id}/instruments/${id}/screen`, { headers: may })
      return Buffer.from((r.json() as InstrumentScreen).data, "base64").toString()
    }
    // The terminal echoes the line and cat prints it back.
    await waitFor(async () => (await screen()).split("allowed-line").length === 3, { what: "cat's line" })
    expect(await screen()).not.toContain("refused-line")
    expect((await shell.read({ waitMs: 0 })).output).not.toContain("refused-line")
  }
  // Keys to an instrument the session doesn't have.
  const r = await post(t.sock, `/sessions/${byAva.id}/instruments/${newId()}/keys`, { data: "x" }, t.ava)
  expect(errorOf(r)).toEqual([404, "not_found"])
})

test("keys to an ended shell are 409", async () => {
  const t = await office()
  const s = t.office.store.createSession(session({ opened_by: CEO }))
  const { shell, id } = await ptyShell(t.office, s.id)
  await shell.close()
  await waitFor(() => t.office.instruments.list(s.id)[0]?.status === "ended", { what: "the shell's end" })
  // An ended shell stays listed, with its scrollback, until its host removes it.
  let r = await post(t.sock, `/sessions/${s.id}/instruments/${id}/keys`, { data: "ls\r" }, t.ceo)
  expect(errorOf(r)).toEqual([409, "not_live"])
  r = await post(t.sock, `/sessions/${s.id}/instruments/${id}/size`, { cols: 100, rows: 30 }, t.ceo)
  expect(errorOf(r)).toEqual([409, "not_live"])
  r = await request(t.sock, "GET", `/sessions/${s.id}/instruments/${id}/screen`, { headers: t.ceo })
  expect(r.status).toBe(200)
  // Once its host removes it, it is gone.
  t.office.instruments.remove(s.id, id)
  r = await post(t.sock, `/sessions/${s.id}/instruments/${id}/keys`, { data: "ls\r" }, t.ceo)
  expect(errorOf(r)).toEqual([404, "not_found"])
})

test("keys and a size to a shell still starting are 409, never dropped", async () => {
  const t = await office()
  const s = t.office.store.createSession(session({ opened_by: CEO }))
  // A shell its host has listed but that hasn't opened yet.
  const id = newId()
  const got: string[] = []
  const starting = hosted(s.id, id, () => undefined, { cols: 80, rows: 24 })
  t.office.instruments.add(s.id, { ...starting, keys: (data) => got.push(data), resize: () => got.push("resize") })
  expect(t.office.instruments.list(s.id)[0]!.status).toBe("starting")
  let r = await post(t.sock, `/sessions/${s.id}/instruments/${id}/keys`, { data: "ls\r" }, t.ceo)
  expect(errorOf(r)).toEqual([409, "not_live"])
  r = await post(t.sock, `/sessions/${s.id}/instruments/${id}/size`, { cols: 100, rows: 30 }, t.ceo)
  expect(errorOf(r)).toEqual([409, "not_live"])
  expect(got).toEqual([])
})

test("a pipes shell takes the owner's Ctrl-C as an interrupt, and refuses other keys", async () => {
  const t = await office()
  const s = t.office.store.createSession(session({ opened_by: CEO }))
  const pipes = pipesShell(t.office, s.id)
  const keys = `/sessions/${s.id}/instruments/${pipes.id}/keys`
  const running = await pipes.shell.run("make", 300)
  expect(running).toMatchObject({ status: "running", output: "$ make\nstarted\n" })
  pipes.print("after the agent's read\n")
  for (const data of ["y\r", "\x03\r", "x\x03"]) {
    expect(errorOf(await post(t.sock, keys, { data }, t.ceo))).toEqual([409, "not_interactive"])
  }
  expect(pipes.shell.state().status).toBe("running")
  expect(errorOf(await post(t.sock, keys, { data: "\x03" }, t.ava))).toEqual([403, "forbidden"])
  let r = await post(t.sock, `/sessions/${s.id}/instruments/${pipes.id}/size`, { cols: 100, rows: 30 }, t.ceo)
  expect(errorOf(r)).toEqual([409, "not_interactive"])
  r = await post(t.sock, keys, { data: "\x03" }, t.ceo)
  expect(r.json()).toEqual({ ok: true })
  // The command stops, and the agent reads on from where it was: the owner's interrupt moved nothing of its place.
  const read = await pipes.shell.read({ waitMs: 5000 })
  expect(read).toMatchObject({ status: "idle", exit: null })
  expect(read.output).toStartWith("after the agent's read\n")
})

test("only the approver closes a shell, as themselves; one starting or ended is 409, and an instrument with no close is 409", async () => {
  const t = await office()
  // A chat's opener closes its shells, even over the CEO.
  const s = t.office.store.createSession(session({ opened_by: "ava" }))
  const pipes = pipesShell(t.office, s.id)
  const close = `/sessions/${s.id}/instruments/${pipes.id}/close`
  const closing = (headers: Record<string, string>) => request(t.sock, "POST", close, { headers })
  expect(errorOf(await closing(t.ceo))).toEqual([403, "forbidden"])
  expect((await closing(t.ceo)).json()).toMatchObject({ message: "only @ava may close this session's shells" })
  expect(errorOf(await closing({}))).toEqual([401, "unauthenticated"])
  expect([pipes.closedBy, pipes.shell.state().status]).toEqual([[], "idle"])
  expect((await closing(t.ava)).json()).toEqual({ ok: true })
  expect([pipes.closedBy, pipes.shell.state().status]).toEqual([["ava"], "ended"])
  // An ended one stays listed, and takes no second close.
  expect(errorOf(await closing(t.ava))).toEqual([409, "not_live"])
  expect(pipes.closedBy).toEqual(["ava"])
  // One still starting, and one its host can't close, as OpenCorp's own connection shell.
  const starting = newId()
  t.office.instruments.add(s.id, hosted(s.id, starting, () => undefined, null))
  let r = await request(t.sock, "POST", `/sessions/${s.id}/instruments/${starting}/close`, { headers: t.ava })
  expect(errorOf(r)).toEqual([409, "not_live"])
  const other = pipesShell(t.office, s.id)
  const { close: _, ...unclosable } = hosted(s.id, newId(), () => other.shell, null)
  t.office.instruments.add(s.id, unclosable)
  r = await request(t.sock, "POST", `/sessions/${s.id}/instruments/${unclosable.id}/close`, { headers: t.ava })
  expect(errorOf(r)).toEqual([409, "not_supported"])
  r = await request(t.sock, "POST", `/sessions/${s.id}/instruments/${newId()}/close`, { headers: t.ava })
  expect(errorOf(r)).toEqual([404, "not_found"])
})

test("only the approver resizes a shell, and the instrument carries its new size", async () => {
  const t = await office()
  const s = t.office.store.createSession(session({ opened_by: CEO }))
  const { shell, id } = await ptyShell(t.office, s.id)
  const sub = t.office.bus.subscribe(s.id)
  onTestFinished(() => sub.close())
  const size = `/sessions/${s.id}/instruments/${id}/size`
  expect(errorOf(await post(t.sock, size, { cols: 120, rows: 40 }, t.ava))).toEqual([403, "forbidden"])
  expect(errorOf(await post(t.sock, size, { cols: 2, rows: 40 }, t.ceo))).toEqual([422, "invalid_body"])
  expect((await post(t.sock, size, { cols: 100, rows: 30 }, t.ceo)).json()).toEqual({ ok: true })
  const item = await sub.next(1000)
  expect(item).toMatchObject(["live", { type: "instrument.updated", data: { id, size: { cols: 100, rows: 30 } } }])
  expect(Instrument.parse((item as ["live", LiveEvent])[1].data)).toMatchObject({ size: { cols: 100, rows: 30 } })
  const list = await request(t.sock, "GET", `/sessions/${s.id}/instruments`, { headers: t.ceo })
  expect((list.json() as Instrument[])[0]!.size).toEqual({ cols: 100, rows: 30 })
  // The PTY takes it.
  expect((await shell.run("stty size", 5000)).output).toBe("$ stty size\n30 100\n")
})

test("the screen of a running shell holds its output", async () => {
  const t = await office()
  const s = t.office.store.createSession(session({ opened_by: CEO }))
  const { shell, id } = await ptyShell(t.office, s.id)
  const reply = await shell.run("echo screen-$((6 * 7)); sleep 30", 500)
  expect(reply.status).toBe("running")
  const r = await request(t.sock, "GET", `/sessions/${s.id}/instruments/${id}/screen`, { headers: t.ava })
  expect(r.status).toBe(200)
  const screen = r.json() as InstrumentScreen
  const text = Buffer.from(screen.data, "base64").toString()
  expect(text).toBe("$ echo screen-$((6 * 7)); sleep 30\r\nscreen-42\r\n")
  expect([screen.offset, screen.end]).toEqual([0, Buffer.byteLength(text)])
})

/** One node attempt over the socket: its detail from its records (GET /runs/{id}/nodes/{seq}) and its view through
 *  yian's `nodeView` on the views thread (GET /runs/{id}/nodes/{seq}/view), from real runs (an agent against the fake
 *  model, a memory input, a CODE node, a CALL and a LOOP, their STARTs and ENDs) and synthetic logs (a failure, open
 *  and restarted attempts, values too large to show whole). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { FileMemory } from "@ngocbh/yian"
import { RunNodeDetail, type RunNodeValue, RunNodeView } from "@opencorp/protocol"
import type { Office } from "../../../src/server/office.ts"
import { RunLogs } from "../../../src/runtime/runs/service.ts"
import { newId } from "../../../src/runtime/store/store.ts"
import { FakeLLM } from "../../../src/testing/fake_llm.ts"
import { tempDir } from "../../helpers.ts"
import {
  CALL_FLOW,
  CODED_LOOP_FLOW,
  CODED_LOOP_HELPERS,
  chatLog,
  committed,
  expanded,
  failed,
  MEMORY_FLOW,
  realRun,
  REPLY_FLOW,
  resumed,
  runStarted,
  startCommitted,
  started,
  succeeded,
} from "../../runtime/runs/helpers.ts"
import { session } from "../../runtime/store/helpers.ts"
import { CEO, makeOffice, type Reply, request, served } from "../helpers.ts"

let fake: FakeLLM
beforeAll(async () => {
  fake = await FakeLLM.start()
})
afterAll(() => fake.close())

/** A served office whose Run Logs read a log under `codeRoot`, the pinned worktree (none without it). */
async function servedNodes(
  codeRoot?: string,
  options: Partial<ConstructorParameters<typeof RunLogs>[0]> = {},
): Promise<{ office: Office; sock: string }> {
  const office = makeOffice({ log: () => {} })
  office.runs = new RunLogs({
    store: office.store,
    runsDir: office.paths.runs,
    index: () => new Map(),
    ...(codeRoot === undefined ? {} : { pin: async () => codeRoot }),
    ...options,
  })
  const { sock } = await served(office)
  return { office, sock }
}

/** A store row of a new ended session for the log at `log` (or the log text `log`), copied into the office's runs.
 *  Returns the run id. */
function place(office: Office, log: string | Buffer): string {
  const runId = newId()
  const { id } = office.store.createSession(session({ status: "ended" }))
  office.store.addRun({
    runId,
    sessionId: id,
    driver: CEO,
    flow: "chat",
    flowPath: "shared/flows/chat.yaml",
    connection: null,
    model: null,
    configSha256: null,
    replacesRunId: null,
    createdAt: "2026-10-20T10:00:00.000Z",
  })
  const file = office.runs.logPath(runId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof log === "string" ? fs.readFileSync(log) : log)
  return runId
}

const get = (sock: string, target: string) => request(sock, "GET", target)

/** The seq of the latest attempt of `nodeId`, from the node page. */
async function seqOf(sock: string, runId: string, nodeId: string): Promise<number> {
  const page = (await get(sock, `/runs/${runId}/nodes`)).json() as { nodes: { seq: number; node_id: string }[] }
  const found = page.nodes.find((n) => n.node_id === nodeId)
  if (!found) throw new Error(`no attempt of ${nodeId}`)
  return found.seq
}

/** Node `nodeId`'s detail, checked against the protocol. */
async function detail(sock: string, runId: string, nodeId: string): Promise<RunNodeDetail> {
  const r = await get(sock, `/runs/${runId}/nodes/${await seqOf(sock, runId, nodeId)}`)
  expect(r.status).toBe(200)
  return RunNodeDetail.parse(r.json())
}

/** Node `nodeId`'s view, checked against the protocol. */
async function view(sock: string, runId: string, nodeId: string): Promise<RunNodeView> {
  const r = await get(sock, `/runs/${runId}/nodes/${await seqOf(sock, runId, nodeId)}/view`)
  expect([r.status, r.status === 200 ? null : r.text]).toEqual([200, null])
  return RunNodeView.parse(r.json())
}

/** Each row as [name, type, value, missing]. */
const rows = (values: RunNodeValue[] | null | undefined) =>
  values === null ? null : (values ?? []).map((v) => [v.name, v.type ?? null, v.value ?? null, v.missing ?? null])

/** The `at` of record `seq` in the log `file`. */
function atOf(file: string, seq: number): string {
  return (JSON.parse(fs.readFileSync(file, "utf8").split("\n")[seq]!) as { at: string }).at
}

const DERIVED = "derived from other values"

test("an agent node: its detail at once from its records, and its view with each input and output typed", async () => {
  const dir = tempDir()
  fake.script({ content: "Sure, I'll look." })
  const { log, codeRoot } = await realRun(dir, REPLY_FLOW, {}, "r1", { inputs: { message: "Hi." }, fake })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  const d = await detail(sock, runId, "reply")
  expect([d.node.kind, d.node.status, d.model, d.failure]).toEqual(["agent", "succeeded", "stub", null])
  expect([d.started_at, d.ended_at]).toEqual([atOf(log, d.node.seq), atOf(log, d.node.end_seq!)])
  // The reply's commit holds it; the new messages' names only the steps it was read from.
  expect(rows(d.outputs)).toEqual([["output", "str", "Sure, I'll look.", null], ["new_messages", null, null, DERIVED]])
  expect(d.outputs!.every((o) => typeof o.seq === "number")).toBe(true)
  const v = await view(sock, runId, "reply")
  expect([v.kind, v.missing, rows(v.inputs)]).toEqual(["agent", null, [["message", "str", "Hi.", null]]])
  const outputs = v.outputs ?? []
  expect(outputs.map((o) => [o.name, o.type, o.missing ?? null, o.seq ?? null])).toEqual([
    ["output", "str", null, null],
    ["new_messages", "list(Message)", null, null],
  ])
  expect(outputs[0]!.value).toBe("Sure, I'll look.")
  expect(JSON.stringify(outputs[1]!.value)).toContain("Sure, I'll look.")
})

test("a memory input is what the run recorded of the memory; an optional input the run wasn't given says so", async () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, "mem"))
  const notes = new FileMemory({ root: path.join(dir, "mem"), id: "notes" })
  fake.script({ content: "Noted." })
  const { log, codeRoot } = await realRun(dir, MEMORY_FLOW, {}, "r1", { inputs: { message: "Hi.", notes }, fake })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  const reply = await view(sock, runId, "reply")
  const memory = reply.inputs!.find((i) => i.name === "notes")!
  expect([memory.type, memory.missing ?? null]).toEqual(["FileMemory", null])
  expect(memory.value).toMatchObject({ identity: "notes", type: "FileMemory", recall: { text: "" } })
  // Its settings' ints are JSON numbers, and no store's location shows.
  expect((memory.value as { settings: Record<string, unknown> }).settings.max_files).toBe(1000)
  expect(JSON.stringify(memory.value)).not.toContain(path.join(dir, "mem"))
  const start = await view(sock, runId, "__start__")
  expect(rows(start.inputs)!.map(([name, type, , missing]) => [name, type, missing])).toEqual([
    ["message", "str", null],
    ["notes", "FileMemory", null],
    ["extra", "Optional(str)", "not given"],
  ])
})

test("a code node, the run's START and END, and a flow call whose outputs are its END's", async () => {
  const dir = tempDir()
  const { log, codeRoot } = await realRun(dir, CALL_FLOW, { "helpers.ts": CODED_LOOP_HELPERS }, "r1", {
    inputs: { topic: "owls" },
  })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  const prep = await detail(sock, runId, "c/prep")
  expect([prep.node.kind, prep.model, rows(prep.outputs)]).toEqual(["code", null, [["output", "str", "ready", null]]])
  expect(rows((await view(sock, runId, "c/prep")).outputs)).toEqual([["output", "str", "ready", null]])
  // The run's START holds what it was given, as one record.
  const start = await detail(sock, runId, "__start__")
  expect([start.node.kind, rows(start.outputs)]).toEqual(["start", [["output", "object", { topic: "owls" }, null]]])
  const startView = await view(sock, runId, "__start__")
  expect([rows(startView.inputs), rows(startView.outputs)]).toEqual([
    [["topic", "str", "owls", null]],
    [["output", '{"topic":str}', { topic: "owls" }, null]],
  ])
  const end = await view(sock, runId, "__end__")
  expect([end.kind, rows(end.inputs), rows(end.outputs)]).toEqual([
    "end", [["said", "Any", "owls!", null]], [["output", '{"said":Any}', { said: "owls!" }, null]],
  ])
  // A call expands; what it came to is its END's: its outcome and when it ended in its detail, what it returned in its
  // view, beside the inputs the call bound.
  const call = await detail(sock, runId, "c")
  expect([call.node.kind, call.node.status, call.outcome]).toEqual(["call", "expanded", "succeeded"])
  const callEnd = await detail(sock, runId, "c/__end__")
  expect(call.ended_at).toBe(callEnd.ended_at)
  expect(rows(call.outputs)).toEqual([["output", null, null, DERIVED]])
  const callView = await view(sock, runId, "c")
  expect([callView.kind, rows(callView.inputs), rows(callView.outputs)]).toEqual([
    "call", [["text", "str", "owls", null]], [["output", '{"loud":Any,"ready":str}', { loud: "owls!", ready: "ready" }, null]],
  ])
  expect([prep.outcome, start.outcome]).toEqual([null, null])
})

test("a child flow's START and END are rebuilt in their view, the END with what it gathered", async () => {
  const dir = tempDir()
  const { log, codeRoot } = await realRun(dir, CALL_FLOW, { "helpers.ts": CODED_LOOP_HELPERS }, "r1", {
    inputs: { topic: "owls" },
  })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  expect(rows((await detail(sock, runId, "c/__start__")).outputs)).toEqual([["output", null, null, DERIVED]])
  const start = await view(sock, runId, "c/__start__")
  expect([start.kind, rows(start.inputs), rows(start.outputs)]).toEqual([
    "start", [["text", "str", "owls", null]], [["output", '{"text":str}', { text: "owls" }, null]],
  ])
  const end = await view(sock, runId, "c/__end__")
  expect([end.kind, rows(end.inputs)]).toEqual(["end", [["loud", "Any", "owls!", null], ["ready", "str", "ready", null]]])
})

test("a loop turn's START and END, and the loop's last turn, which returns the loop's value", async () => {
  const dir = tempDir()
  const { log, codeRoot } = await realRun(dir, CODED_LOOP_FLOW, { "helpers.ts": CODED_LOOP_HELPERS })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  expect(rows((await view(sock, runId, "l#0/__start__")).inputs)).toEqual([["n", "int", 0, null]])
  expect(rows((await view(sock, runId, "l#1/__start__")).inputs)).toEqual([["n", "int", 1, null]])
  expect(rows((await view(sock, runId, "l#0/__end__")).outputs)).toEqual([["output", '{"n":Any}', { n: 1 }, null]])
  // The loop came to what its last turn's driver committed; a driver that expanded came to nothing of its own.
  const loop = await detail(sock, runId, "l")
  expect([loop.node.status, loop.outcome]).toEqual(["expanded", "succeeded"])
  expect(rows((await view(sock, runId, "l")).outputs)).toEqual([["output", '{"n":Any}', { n: 2 }, null]])
  const driver = await detail(sock, runId, "l~1")
  expect([driver.node.status, driver.outcome, driver.outputs]).toEqual(["expanded", null, []])
  const last = await view(sock, runId, "l~2")
  expect([last.kind, rows(last.inputs), rows(last.outputs)]).toEqual([
    "loop", [["n", "Any", 2, null]], [["output", '{"n":Any}', { n: 2 }, null]],
  ])
})

test("a run whose flow no longer loads: its view says why, with what its records hold", async () => {
  const dir = tempDir()
  const { log, codeRoot } = await realRun(dir, CALL_FLOW, { "helpers.ts": CODED_LOOP_HELPERS }, "r1", {
    inputs: { topic: "owls" },
  })
  fs.rmSync(path.join(codeRoot, "helpers.ts"))
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  const end = await view(sock, runId, "c/__end__")
  expect([end.kind, end.inputs]).toEqual([null, null])
  expect(end.missing).toMatch(/^the run's flow doesn't load: .*helpers\.ts/)
  expect(rows(end.outputs)).toEqual([["output", null, null, end.missing ?? null]])
  // A value its commit holds still shows, without its type.
  expect(rows((await view(sock, runId, "c/prep")).outputs)).toEqual([["output", null, "ready", null]])
  // The detail doesn't need the flow.
  expect(rows((await detail(sock, runId, "c/prep")).outputs)).toEqual([["output", "str", "ready", null]])
})

test("a view's long values are cut as an opened record's are, across the whole view", async () => {
  const dir = tempDir()
  const big = "a".repeat(1_500_000)
  fake.script({ content: big })
  const { log, codeRoot } = await realRun(dir, REPLY_FLOW, {}, "r1", { inputs: { message: big }, fake })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  // Each fits alone; together they are over what one view shows, so each string is cut at 4K characters.
  expect(((await detail(sock, runId, "reply")).outputs![0]!.value as string).length).toBe(1_500_000)
  const v = await view(sock, runId, "reply")
  expect(v.inputs!.map((i) => [i.name, (i.value as string).length, i.cut])).toEqual([["message", 4097, [""]]])
  expect([(v.outputs![0]!.value as string).length, v.outputs![0]!.cut]).toEqual([4097, [""]])
})

test("a view the office can't read, or of a log over the limit, is a 409 that names only why", async () => {
  // A synthetic log's flow was built in code: yian can't replay it.
  const { office, sock } = await servedNodes()
  const runId = place(office, Buffer.concat([runStarted(0), startCommitted(1), started(2, "x"), failed(3, "x", "boom")]))
  const r = await get(sock, `/runs/${runId}/nodes/2/view`)
  expect([r.status, (r.json() as { error: string }).error]).toEqual([409, "not_supported"])
  expect((r.json() as { message: string }).message).toBe("this office can't read this node's values (RangeError)")
  expect(r.text).not.toContain(office.runs.logPath(runId))
  const small = await servedNodes(undefined, { callBytes: 100 })
  const large = place(small.office, chatLog(path.join(tempDir(), "log.jsonl")))
  const too = await get(small.sock, `/runs/${large}/nodes/1/view`)
  expect([too.status, (too.json() as { error: string }).error]).toEqual([409, "too_large"])
})

test("a failed node has its error and traceback whole, and no outputs", async () => {
  const { office, sock } = await servedNodes()
  const log = Buffer.concat([runStarted(0), startCommitted(1), started(2, "x"), failed(3, "x", "AuthError: 401")])
  const runId = place(office, log)
  const d = await detail(sock, runId, "x")
  expect([d.node.status, d.node.end_seq, d.outputs]).toEqual(["failed", 3, []])
  expect(d.failure).toEqual({ message: "AuthError: 401", traceback: "Traceback", cut: [], size: null })
  expect(d.ended_at).toBe("2026-10-20T10:00:00.000Z")
})

test("an open and a restarted attempt have no end, outputs or failure; a synthetic value shows as committed", async () => {
  const { office, sock } = await servedNodes()
  const dir = tempDir()
  const file = chatLog(path.join(dir, "log.jsonl"))
  fs.appendFileSync(file, Buffer.concat([resumed(20, ["chat#2/ask"]), started(21, "chat#2/ask")]))
  const runId = place(office, file)
  const at = (seq: number) => get(sock, `/runs/${runId}/nodes/${seq}`).then((r) => RunNodeDetail.parse(r.json()))
  const restarted = await at(19)
  const open = await at(21)
  for (const [d, status] of [[restarted, "restarted"], [open, "open"]] as const) {
    expect([d.node.node_id, d.node.status, d.node.end_seq, d.ended_at, d.outputs, d.failure]).toEqual([
      "chat#2/ask", status, null, null, [], null,
    ])
    expect(d.started_at).toBe("2026-10-20T10:00:00.000Z")
  }
  // A record its node commits is one value; a case has none, and its route whole.
  expect(rows((await detail(sock, runId, "chat#1/reply")).outputs)).toEqual([["output", "object", { output: "hello" }, null]])
  const route = await detail(sock, runId, "chat#1/route")
  expect([route.node.status, route.node.handle, route.outputs]).toEqual(["routed", "reply", []])
})

test("a long output in the detail is cut as an opened record's is", async () => {
  const { office, sock } = await servedNodes()
  const big = "a".repeat(3_000_000)
  const log = Buffer.concat([
    runStarted(0), startCommitted(1), started(2, "f/x"), committed(3, "f/x", big, "str"), succeeded(4, "f/x", 3),
  ])
  const runId = place(office, log)
  const x = await detail(sock, runId, "f/x")
  expect([(x.outputs![0]!.value as string).length, x.outputs![0]!.cut]).toEqual([4097, [""]])
})

test("a seq that starts no attempt is a 404, a bad one a 422 that doesn't echo it, and HEAD is refused", async () => {
  const { office, sock } = await servedNodes()
  const runId = place(office, chatLog(path.join(tempDir(), "log.jsonl")))
  const status = async (target: string, method = "GET") => {
    const r: Reply = await request(sock, method, target)
    return [r.status, (r.json() as { error?: string } | null)?.error ?? null, r.text.includes("x9")]
  }
  // Seq 5 is a commit, not a start.
  for (const end of ["", "/view"]) {
    expect(await status(`/runs/${runId}/nodes/5${end}`)).toEqual([404, "not_found", false])
    expect(await status(`/runs/${runId}/nodes/999${end}`)).toEqual([404, "not_found", false])
    expect(await status(`/runs/${newId()}/nodes/1${end}`)).toEqual([404, "not_found", false])
    expect(await status(`/runs/${runId}/nodes/x9${end}`)).toEqual([422, "invalid_body", false])
  }
  expect((await request(sock, "HEAD", `/runs/${runId}/nodes/1/view`)).status).toBe(405)
})

test("a flow call that failed inside, or still runs, came to that, with nothing returned", async () => {
  const { office, sock } = await servedNodes()
  const head = [runStarted(0), startCommitted(1), started(2, "c"), expanded(3, "c"), started(4, "c/x")]
  const broke = await detail(sock, place(office, Buffer.concat([...head, failed(5, "c/x", "boom")])), "c")
  expect([broke.node.status, broke.outcome, broke.outputs, broke.ended_at]).toEqual(["expanded", "failed", [], null])
  const running = await detail(sock, place(office, Buffer.concat(head)), "c")
  expect([running.outcome, running.outputs]).toEqual(["open", []])
})

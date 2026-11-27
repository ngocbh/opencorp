/** One node attempt's detail over the socket: GET /runs/{id}/nodes/{seq}, from real runs (an agent against the fake
 *  model, a CODE node, a CALL and a LOOP, their STARTs and ENDs) and synthetic logs (a failure, open and restarted
 *  attempts, values too large to show whole). */
import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { RunNodeDetail, type RunNodeValue } from "@opencorp/protocol"
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
  line,
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

/** A served office whose Run Logs replay a log under `codeRoot`, the pinned worktree (none without it). */
async function servedNodes(codeRoot?: string): Promise<{ office: Office; sock: string }> {
  const office = makeOffice({ log: () => {} })
  office.runs = new RunLogs({
    store: office.store,
    runsDir: office.paths.runs,
    index: () => new Map(),
    ...(codeRoot === undefined ? {} : { pin: async () => codeRoot }),
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

/** Each row as [name, type, value, missing]. */
const rows = (values: RunNodeValue[] | undefined) =>
  (values ?? []).map((v) => [v.name, v.type ?? null, v.value ?? null, v.missing ?? null])

/** The `at` of record `seq` in the log `file`. */
function atOf(file: string, seq: number): string {
  return (JSON.parse(fs.readFileSync(file, "utf8").split("\n")[seq]!) as { at: string }).at
}

test("an agent node: its kind, model, when it started and ended, its reply and its new messages", async () => {
  const dir = tempDir()
  fake.script({ content: "Sure, I'll look." })
  const { log, codeRoot } = await realRun(dir, REPLY_FLOW, {}, "r1", { inputs: { message: "Hi." }, fake })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  const d = await detail(sock, runId, "reply")
  expect([d.node.kind, d.node.status, d.model, d.failure]).toEqual(["agent", "succeeded", "stub", null])
  expect([d.started_at, d.ended_at]).toEqual([atOf(log, d.node.seq), atOf(log, d.node.end_seq!)])
  const outputs = d.outputs ?? []
  expect(outputs.map((o) => [o.name, o.type, o.missing ?? null])).toEqual([
    ["output", "str", null],
    ["new_messages", "list[object]", null],
  ])
  expect(outputs[0]!.value).toBe("Sure, I'll look.")
  // The messages commit holds only its steps: its value is rebuilt from the log.
  expect(Array.isArray(outputs[1]!.value)).toBe(true)
  expect(JSON.stringify(outputs[1]!.value)).toContain("Sure, I'll look.")
  expect(d.inputs).toEqual([])
})

test("a code node, and the run's START and END, each a row per field of the record it received or returned", async () => {
  const dir = tempDir()
  const { log, codeRoot } = await realRun(dir, CALL_FLOW, { "helpers.ts": CODED_LOOP_HELPERS }, "r1", {
    inputs: { topic: "owls" },
  })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  const prep = await detail(sock, runId, "c/prep")
  expect([prep.node.kind, prep.model, rows(prep.outputs), prep.inputs]).toEqual([
    "code", null, [["output", "str", "ready", null]], [],
  ])
  const start = await detail(sock, runId, "__start__")
  expect([start.node.kind, rows(start.outputs), start.inputs]).toEqual(["start", [["topic", null, "owls", null]], []])
  // The run's END holds its value, so the log names nothing it read.
  const end = await detail(sock, runId, "__end__")
  expect([end.node.kind, rows(end.outputs), end.inputs]).toEqual(["end", [["said", null, "owls!", null]], []])
  // A call expands; what it came to is its END's: its outcome, what it returned, and when it ended.
  const call = await detail(sock, runId, "c")
  expect([call.node.kind, call.node.status, call.outcome, rows(call.outputs), call.inputs]).toEqual([
    "call", "expanded", "succeeded", [["loud", null, "owls!", null], ["ready", null, "ready", null]], [],
  ])
  const callEnd = await detail(sock, runId, "c/__end__")
  expect(call.ended_at).toBe(callEnd.ended_at)
  expect([prep.outcome, start.outcome]).toEqual([null, null])
})

test("a child flow's START and END are rebuilt from the log, the END with what it gathered", async () => {
  const dir = tempDir()
  const { log, codeRoot } = await realRun(dir, CALL_FLOW, { "helpers.ts": CODED_LOOP_HELPERS }, "r1", {
    inputs: { topic: "owls" },
  })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  const start = await detail(sock, runId, "c/__start__")
  expect([start.node.kind, rows(start.outputs), start.inputs]).toEqual(["start", [["text", null, "owls", null]], []])
  const end = await detail(sock, runId, "c/__end__")
  expect(end.node.kind).toBe("end")
  expect(rows(end.outputs)).toEqual([["loud", null, "owls!", null], ["ready", null, "ready", null]])
  expect(rows(end.inputs)).toEqual([["input", "object", { text: "owls" }, null], ["prep.output", "str", "ready", null]])
  // Each row names the commit that holds it.
  expect((end.inputs ?? []).every((v) => v.seq > 0 && v.seq < end.node.seq)).toBe(true)

  // Without the pinned worktree, a derived value isn't rebuilt; a value its commit holds still shows.
  const bare = await servedNodes()
  const again = place(bare.office, log)
  const unbuilt = await detail(bare.sock, again, "c/__end__")
  expect(rows(unbuilt.outputs)).toEqual([["output", null, null, "not_rebuilt"]])
  expect(rows(unbuilt.inputs)).toEqual([["input", null, null, "not_rebuilt"], ["prep.output", "str", "ready", null]])
  expect(unbuilt.node.kind).toBeNull()
})

test("a loop turn's START and END, and the loop's last turn with the END it read", async () => {
  const dir = tempDir()
  const { log, codeRoot } = await realRun(dir, CODED_LOOP_FLOW, { "helpers.ts": CODED_LOOP_HELPERS })
  const { office, sock } = await servedNodes(codeRoot)
  const runId = place(office, log)
  const start = await detail(sock, runId, "l#0/__start__")
  expect([start.node.kind, rows(start.outputs), start.inputs]).toEqual(["start", [["n", null, 0, null]], []])
  const second = await detail(sock, runId, "l#1/__start__")
  expect(rows(second.outputs)).toEqual([["n", null, 1, null]])
  const end = await detail(sock, runId, "l#0/__end__")
  expect([end.node.kind, rows(end.outputs), rows(end.inputs)]).toEqual([
    "end", [["n", null, 1, null]], [["input", "object", { n: 0 }, null]],
  ])
  // The driver of the last turn commits the loop's output, read from that turn's END, a pool name of another flow.
  // The loop came to what its last turn's driver committed; a driver that expanded came to nothing of its own.
  const loop = await detail(sock, runId, "l")
  expect([loop.node.status, loop.outcome, rows(loop.outputs)]).toEqual(["expanded", "succeeded", [["n", null, 2, null]]])
  const driver = await detail(sock, runId, "l~1")
  expect([driver.node.status, driver.outcome, driver.outputs]).toEqual(["expanded", null, []])
  const last = await detail(sock, runId, "l~2")
  expect([last.node.kind, rows(last.outputs), rows(last.inputs)]).toEqual([
    "loop", [["output", "object", { n: 2 }, null]], [["l#1/__end__", "object", { n: 2 }, null]],
  ])
})

test("a failed node has its error and traceback whole, and no outputs", async () => {
  const { office, sock } = await servedNodes()
  const log = Buffer.concat([runStarted(0), startCommitted(1), started(2, "x"), failed(3, "x", "AuthError: 401")])
  const runId = place(office, log)
  const d = await detail(sock, runId, "x")
  expect([d.node.status, d.node.end_seq, d.outputs, d.inputs]).toEqual(["failed", 3, [], []])
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
  // A record its node commits is one value, its fields not split; a case has none, and its route whole.
  expect(rows((await detail(sock, runId, "chat#1/reply")).outputs)).toEqual([["output", "object", { output: "hello" }, null]])
  const route = await detail(sock, runId, "chat#1/route")
  expect([route.node.status, route.node.handle, route.outputs]).toEqual(["routed", "reply", []])
})

test("long values are cut as an opened record's are, across the whole detail", async () => {
  const { office, sock } = await servedNodes()
  const big = "a".repeat(1_500_000)
  const log = Buffer.concat([
    runStarted(0), startCommitted(1),
    started(2, "f/x"), committed(3, "f/x", big, "str"), succeeded(4, "f/x", 3),
    started(5, "f/y"), committed(6, "f/y", big, "str"), succeeded(7, "f/y", 6),
    started(8, "f/__end__"),
    line(9, "pool_commit", { node_id: "f/__end__", key: "f", from: { "f/x": 3n, "f/y": 6n } }),
    succeeded(10, "f/__end__", 9),
  ])
  const runId = place(office, log)
  // Each fits alone; together they are over what one detail shows, so each string is cut at 4K characters.
  const x = await detail(sock, runId, "f/x")
  expect([(x.outputs![0]!.value as string).length, x.outputs![0]!.cut]).toEqual([1_500_000, []])
  const end = await detail(sock, runId, "f/__end__")
  expect(end.inputs!.map((v) => [v.name, (v.value as string).length, v.cut])).toEqual([
    ["x.output", 4097, [""]],
    ["y.output", 4097, [""]],
  ])
})

test("a seq that starts no attempt is a 404, a bad one a 422 that doesn't echo it, and HEAD is refused", async () => {
  const { office, sock } = await servedNodes()
  const runId = place(office, chatLog(path.join(tempDir(), "log.jsonl")))
  const status = async (target: string, method = "GET") => {
    const r: Reply = await request(sock, method, target)
    return [r.status, (r.json() as { error?: string } | null)?.error ?? null, r.text.includes("x9")]
  }
  // Seq 5 is a commit, not a start.
  expect(await status(`/runs/${runId}/nodes/5`)).toEqual([404, "not_found", false])
  expect(await status(`/runs/${runId}/nodes/999`)).toEqual([404, "not_found", false])
  expect(await status(`/runs/${newId()}/nodes/1`)).toEqual([404, "not_found", false])
  expect(await status(`/runs/${runId}/nodes/x9`)).toEqual([422, "invalid_body", false])
  expect((await request(sock, "HEAD", `/runs/${runId}/nodes/1`)).status).toBe(405)
})

test("a flow call that failed inside, or still runs, came to that, with nothing returned", async () => {
  const { office, sock } = await servedNodes()
  const head = [runStarted(0), startCommitted(1), started(2, "c"), expanded(3, "c"), started(4, "c/x")]
  const broke = await detail(sock, place(office, Buffer.concat([...head, failed(5, "c/x", "boom")])), "c")
  expect([broke.node.status, broke.outcome, broke.outputs, broke.ended_at]).toEqual(["expanded", "failed", [], null])
  const running = await detail(sock, place(office, Buffer.concat(head)), "c")
  expect([running.outcome, running.outputs]).toEqual(["open", []])
})

test("a wide fan-in shows its first 100 inputs and how many more, and stops reading at what one detail shows", async () => {
  const { office, sock } = await servedNodes()
  /** A log whose `f/__end__` gathers `n` commits, each of `size` characters. */
  const fanIn = (n: number, size: number) => {
    const out = [runStarted(0), startCommitted(1)]
    const from: Record<string, bigint> = {}
    let seq = 2
    for (let i = 0; i < n; i++) {
      const id = `f/x${String(i).padStart(3, "0")}`
      out.push(started(seq, id), committed(seq + 1, id, "v".repeat(size), "str"), succeeded(seq + 2, id, seq + 1))
      from[id] = BigInt(seq + 1)
      seq += 3
    }
    out.push(started(seq, "f/__end__"), line(seq + 1, "pool_commit", { node_id: "f/__end__", key: "f", from }),
             succeeded(seq + 2, "f/__end__", seq + 1))
    return Buffer.concat(out)
  }
  const wide = await detail(sock, place(office, fanIn(150, 10)), "f/__end__")
  expect([wide.inputs!.length, wide.inputs_more]).toEqual([100, 50])
  expect([wide.inputs![0]!.name, wide.inputs![99]!.name]).toEqual(["x000.output", "x099.output"])
  // 30 values of 200,000 characters: reading stops once one detail's worth is read, and what was read is cut.
  const heavy = await detail(sock, place(office, fanIn(30, 200_000)), "f/__end__")
  expect(heavy.inputs!.length).toBeLessThan(30)
  expect(heavy.inputs!.length + heavy.inputs_more!).toBe(30)
  expect(heavy.inputs!.every((v) => (v.value as string).length === 4097 && v.cut!.length === 1)).toBe(true)
})

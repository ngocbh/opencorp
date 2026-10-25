/** The run-log reader: a lazy, bounded index per log with its node table; node and record pages; plain reads only. */
import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import {
  BIG_LINE,
  CHUNK,
  cost,
  CUT_CHARS,
  DEPTH_CAP,
  ERROR_KEPT,
  EVENT_BYTES,
  FIELD_CHARS,
  HUGE_LINE,
  LINE_CAP,
  logStream,
  LRU_LOGS,
  nodePage,
  PAGE_BYTES,
  PAGE_SCAN,
  readEvent,
  readEvents,
  type ReadOn,
  readOn,
  refresh,
  RunLogReader,
  SCHEMA,
  SPARSE_BYTES,
  UnreadableLog,
  UnsupportedSchema,
} from "../../src/runs/reader.ts"
import { kindOf, recordedKinds } from "../../src/runs/nodes.ts"
import { tempDir } from "../helpers.ts"
import {
  chatLog,
  CODED_LOOP_FLOW,
  CODED_LOOP_HELPERS,
  committed,
  expanded,
  failed,
  FP,
  line,
  LOOP_FLOW,
  realRun,
  resumed,
  routed,
  runStarted,
  started,
  succeeded,
  waiting,
  woken,
} from "./helpers.ts"

/** Writes the records `parts` to `r.jsonl` in a fresh folder; returns its path. */
function logOf(...parts: Buffer[]): string {
  const file = path.join(tempDir(), "r.jsonl")
  fs.writeFileSync(file, Buffer.concat(parts))
  return file
}

/** `data` split into its lines, each with its newline. */
function linesOf(data: Buffer): Buffer[] {
  const out: Buffer[] = []
  for (let start = 0; start < data.length;) {
    const end = data.indexOf(0x0a, start) + 1 || data.length
    out.push(data.subarray(start, end))
    start = end
  }
  return out
}

/** A commit by `nodeId` whose line is exactly `size` bytes, its value `{output}` padded with `fill`. */
function commitOfSize(seq: number, nodeId: string, size: number, fill: string): Buffer {
  const bare = committed(seq, nodeId, { output: "" })
  return committed(seq, nodeId, { output: fill.repeat(size - bare.length) })
}

/** What `refresh(file, null)` throws. */
async function refused(file: string): Promise<Error> {
  try {
    await refresh(file, null)
  } catch (error) {
    return error as Error
  }
  throw new Error("refresh read the log")
}

test("the summary has the first records facts and the open nodes", async () => {
  const index = await refresh(chatLog(path.join(tempDir(), "r.jsonl")), null)
  expect([index.fingerprint, index.learnable, index.models]).toEqual([FP, true, { "chat/reply": "stub" }])
  expect([[...index.open.keys()], index.lastSeq]).toEqual([["chat#2/ask"], 19])
})

test("an unknown envelope field makes the log unreadable", async () => {
  const error = await refused(logOf(runStarted(0), line(1, "node_started", { node_id: "a" }, { trace_id: "t-1" })))
  expect(error).toBeInstanceOf(UnreadableLog)
  expect(error.message).toBe("This log has a line this office can't read (line 2)")
})

test.each([
  [23, "This log uses run-log schema 23, which this office can't read"],
  [21, "This log uses run-log schema 21, which is older than this office supports"],
  ["sk-" + "a".repeat(40), "This log uses a run-log schema this office can't read"],
  [true, "This log uses a run-log schema this office can't read"],
])("an unknown or retired schema stops that log with a message [%s]", async (schema, message) => {
  // An int schema is written as an int; anything else could be any text and is never echoed.
  const raw = typeof schema === "number" ? BigInt(schema) : schema
  const error = await refused(logOf(runStarted(0), line(1, "node_started", { node_id: "a" }, { schema: raw })))
  expect(error).toBeInstanceOf(UnsupportedSchema)
  expect(error.message).toBe(message)
})

test("a line that isnt a record or a seq out of order makes the log unreadable", async () => {
  const message = "This log has a line this office can't read (line 2)"
  for (const second of [Buffer.from("[1, 2]\n"), started(2, "a"), line(1, "node_started", { node_id: "a" }, {
    run_id: "sk-" + "b".repeat(40),
  })]) {
    const error = await refused(logOf(runStarted(0), second))
    expect(error).toBeInstanceOf(UnreadableLog)
    expect(error.message).toBe(message)
  }
})

test("a line over the line cap makes the log unreadable before yian reads it", async () => {
  const error = await refused(logOf(runStarted(0), committed(1, "a", { output: "x".repeat(LINE_CAP + 1024) })))
  expect(error).toBeInstanceOf(UnreadableLog)
  expect(error.message).toBe("This log has a record too large to read (line 2)")
  const file = logOf(runStarted(0), started(1, "a"))
  const index = await refresh(file, null)
  fs.appendFileSync(file, committed(2, "a", { output: "x".repeat(LINE_CAP + 1024) }))
  const again = await refresh(file, index).catch((caught: Error) => caught)
  expect(again).toBeInstanceOf(UnreadableLog)
  expect((again as Error).message).toBe("This log has a record too large to read (line 3)")
})

test("an unterminated tail over the line cap is left unread", async () => {
  const file = chatLog(path.join(tempDir(), "r.jsonl"))
  const whole = fs.readFileSync(file)
  fs.appendFileSync(file, Buffer.alloc(LINE_CAP + 1024, "x"))
  const index = await refresh(file, null)
  expect([index.lastSeq, index.offset]).toEqual([19, whole.length])
})

test("a torn last line is left for later", async () => {
  const file = chatLog(path.join(tempDir(), "r.jsonl"))
  const whole = fs.readFileSync(file)
  fs.writeFileSync(file, Buffer.concat([whole, started(20, "chat#2/x").subarray(0, -5)]))
  const index = await refresh(file, null)
  expect([index.lastSeq, index.offset]).toEqual([19, whole.length])
})

test("the node table has every attempt with its outcome", async () => {
  const index = await refresh(logOf(
    runStarted(0), started(1, "chat"), expanded(2, "chat"), started(3, "chat#0/route"),
    routed(4, "chat#0/route", "reply"), started(5, "chat#0/reply"), failed(6, "chat#0/reply", "boom ".repeat(100)),
    started(7, "m#0/a"), started(8, "m#1/a"), committed(9, "m#0/a", {}), succeeded(10, "m#0/a", 9),
  ), null)
  expect(index.nodes.map((a) => [a.nodeId, a.status, a.handle, a.endSeq])).toEqual([
    ["chat", "expanded", null, 2], ["chat#0/route", "routed", "reply", 4], ["chat#0/reply", "failed", null, 6],
    ["m#0/a", "succeeded", null, 10], ["m#1/a", "open", null, null],
  ])
  // The error is kept up to ERROR_KEPT; it is cut to ERROR_CHARS only when shown.
  expect(index.nodes[2]!.error).toBe("boom ".repeat(100).slice(0, ERROR_KEPT - 1) + "…")
  expect([...index.open.keys()]).toEqual(["m#1/a"])
})

test("a node error is kept up to error kept its cut marked", async () => {
  const index = await refresh(logOf(runStarted(0), started(1, "a"), failed(2, "a", "x".repeat(5000))), null)
  const error = index.nodes[0]!.error!
  expect([ERROR_KEPT, error.length, error.endsWith("x…")]).toEqual([256, ERROR_KEPT, true])
  // Cut by code points: 257 astral characters keep 255 and the mark.
  const astral = await refresh(logOf(runStarted(0), started(1, "a"), failed(2, "a", "😀".repeat(257))), null)
  expect(astral.nodes[0]!.error).toBe("😀".repeat(255) + "…")
})

test("a resume restarts the open starts and only the latest start is open", async () => {
  const index = await refresh(logOf(
    runStarted(0), started(1, "chat#0/reply"), resumed(2, ["chat#0/reply"]), started(3, "chat#0/reply"),
  ), null)
  expect(index.nodes.map((a) => [a.seq, a.status])).toEqual([[1, "restarted"], [3, "open"]])
  expect(index.dividers).toEqual([[2, ["chat#0/reply"]]])
  expect([...index.open.keys()]).toEqual(["chat#0/reply"])
})

test("a waiting node stays open through a resume and a woken one runs on", async () => {
  const file = path.join(tempDir(), "r.jsonl")
  const records = [runStarted(0), started(1, "a"), started(2, "b"), waiting(3, "a")]
  fs.writeFileSync(file, Buffer.concat(records))
  const index = await refresh(file, null)
  expect([index.nodes[0]!.status, index.open.get("a")]).toEqual(["waiting", index.nodes[0]!])
  fs.appendFileSync(file, resumed(4, ["b"]))
  await refresh(file, index)
  expect(index.nodes.map((a) => a.status)).toEqual(["waiting", "restarted"])
  fs.appendFileSync(file, Buffer.concat([
    started(5, "b"), woken(6, "a"), committed(7, "a", {}), succeeded(8, "a", 7),
  ]))
  await refresh(file, index)
  expect(index.nodes.map((a) => [a.nodeId, a.status])).toEqual([["a", "succeeded"], ["b", "restarted"], ["b", "open"]])
  expect([...index.open.keys()]).toEqual(["b"])
})

test("the node table keeps the newest attempts past its cap", async () => {
  const index = await refresh(chatLog(path.join(tempDir(), "r.jsonl")), null, { nodeCap: 5 })
  expect([index.nodes.length, index.dropped, index.nodes.at(-1)!.nodeId]).toEqual([5, true, "chat#2/ask"])
})

test("an append is read incrementally", async () => {
  const file = chatLog(path.join(tempDir(), "r.jsonl"))
  const index = await refresh(file, null)
  const old = index.offset
  const calls: [boolean, number][] = []
  const seam: ReadOn = (p, i, resumedRead, nodeCap) => {
    calls.push([resumedRead, i.offset])
    return readOn(p, i, resumedRead, nodeCap)
  }
  fs.appendFileSync(file, started(20, "chat#2/late")) // learning appends to a finished log days later
  expect(await refresh(file, index, { readOn: seam })).toBe(index)
  expect([index.lastSeq, calls]).toEqual([20, [[true, old]]])
})

test("a truncation then a same size rewrite rebuilds", async () => {
  const file = chatLog(path.join(tempDir(), "r.jsonl"))
  const index = await refresh(file, null)
  const data = fs.readFileSync(file)
  const last = started(19, "chat#2/ask")
  const other = started(19, "chat#2/asx")
  expect([data.subarray(-last.length).equals(last), last.length]).toEqual([true, other.length])
  fs.writeFileSync(file, Buffer.concat([data.subarray(0, -last.length), other])) // same inode and size
  const again = await refresh(file, index)
  expect(again).not.toBe(index)
  expect([...again.open.keys()]).toEqual(["chat#2/asx"])
})

test("an append that skips a seq rebuilds then says unreadable and a new file rebuilds", async () => {
  const dir = tempDir()
  const file = chatLog(path.join(dir, "r.jsonl"))
  const index = await refresh(file, null)
  fs.appendFileSync(file, started(22, "late")) // 20 and 21 never arrive
  await expect(refresh(file, index)).rejects.toBeInstanceOf(UnreadableLog)
  fs.renameSync(chatLog(path.join(dir, "other.jsonl"), 1), file)
  expect((await refresh(file, index)).lastSeq).toBe(11)
})

test("a large log builds with memory under its largest line plus 32 mib", async () => {
  const file = path.join(tempDir(), "big.jsonl")
  const filler = "w".repeat(1500)
  const fd = fs.openSync(file, "w")
  let size = fs.writeSync(fd, runStarted(0))
  let seq = 1
  while (size < 32 << 20) {
    for (const record of [
      started(seq, `m#${seq}/a`), committed(seq + 1, `m#${seq}/a`, { output: filler }),
      succeeded(seq + 2, `m#${seq}/a`, seq + 1),
    ]) size += fs.writeSync(fd, record)
    seq += 3
  }
  for (const record of [
    started(seq, "huge"), committed(seq + 1, "huge", { output: "h".repeat(2 << 20) }),
    succeeded(seq + 2, "huge", seq + 1),
  ]) fs.writeSync(fd, record)
  fs.closeSync(fd)
  const index = await refresh(file, null) // the node table included
  expect([index.lastSeq, index.open.size, index.nodes.at(-1)!.nodeId]).toEqual([seq + 2, 0, "huge"])
}, 120_000)

test("node pages go newest first with their dividers", async () => {
  const index = await refresh(chatLog(path.join(tempDir(), "r.jsonl"), 3), null)
  const page = nodePage(index, { before: null, limit: 4 })
  expect(page.nodes.map((a) => a.nodeId)).toEqual(["chat#3/ask", "chat#2/reply", "chat#2/route", "chat#2/ask"])
  const older = nodePage(index, { before: page.nextBefore, limit: 100 })
  expect([older.nodes[0]!.nodeId, older.nodes.at(-1)!.nodeId, older.nextBefore]).toEqual(["chat#1/reply", "chat", null])
  // Copies: a refresh can't change a page being sent.
  expect(page.nodes[0]).not.toBe(index.nodes.at(-1)!)
  expect(page.nodes[0]).toEqual(index.nodes.at(-1)!)
})

test("each node page has only the dividers among its attempts", async () => {
  const index = await refresh(logOf(
    runStarted(0), started(1, "a"), resumed(2, ["a"]), started(3, "a"), committed(4, "a", {}), succeeded(5, "a", 4),
    started(6, "b"), resumed(7, ["b"]), started(8, "b"),
  ), null)
  const newest = nodePage(index, { before: null, limit: 2 })
  expect([newest.nodes.map((a) => a.seq), newest.dividers, newest.nextBefore]).toEqual([[8, 6], [[7, ["b"]]], 6])
  const older = nodePage(index, { before: newest.nextBefore, limit: 2 })
  expect([older.nodes.map((a) => a.seq), older.dividers, older.nextBefore]).toEqual([[3, 1], [[2, ["a"]]], null])
})

test("two first requests build once", async () => {
  const file = chatLog(path.join(tempDir(), "r.jsonl"))
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const calls: number[] = []
  const slow: typeof refresh = async (p, index, options) => {
    calls.push(1)
    await gate
    return refresh(p, index, options)
  }
  const reader = new RunLogReader({ refresh: slow })
  const both = Promise.all([reader.index(file), reader.index(file)])
  release()
  const [a, b] = await both
  expect([a === b, calls]).toEqual([true, [1]])
})

test("a log is read whole once then only its appends", async () => {
  const file = chatLog(path.join(tempDir(), "r.jsonl"))
  const fresh: boolean[] = []
  const counted: typeof refresh = (p, index, options) => {
    fresh.push(index === null)
    return refresh(p, index, options)
  }
  const reader = new RunLogReader({ refresh: counted })
  const shown = async () => nodePage(await reader.index(file), { before: null, limit: 10 }).nodes.length
  expect(await shown()).toBeGreaterThan(0) // a run page
  expect(await shown()).toBeGreaterThan(0) // its Timeline
  expect(await shown()).toBeGreaterThan(0) // and its refetch, much later
  expect(fresh.filter(Boolean).length).toBe(1)
})

test("the lru evicts the least recently used logs by bytes", async () => {
  const dir = tempDir()
  const paths = [0, 1, 2].map((n) => chatLog(path.join(dir, `${n}.jsonl`)))
  const reader = new RunLogReader({ budget: 1 }) // every index is over budget: only the one just used stays
  for (const file of paths) await reader.index(file)
  expect(reader.cached()).toEqual([paths[2]!])
})

test("an unreadable log isnt read again until it changes", async () => {
  const file = logOf(runStarted(0), line(1, "node_started", { node_id: "a" }, { schema: 23n }))
  const calls: number[] = []
  const counted: typeof refresh = (p, index, options) => {
    calls.push(1)
    return refresh(p, index, options)
  }
  const reader = new RunLogReader({ refresh: counted })
  for (let i = 0; i < 2; i++) await expect(reader.index(file)).rejects.toBeInstanceOf(UnsupportedSchema)
  expect(calls).toEqual([1])
  chatLog(file) // replaced: read again
  expect((await reader.index(file)).lastSeq).toBe(19)
  expect(calls).toEqual([1, 1])
})

test("a log rewritten during a read is read again from the start", async () => {
  const dir = tempDir()
  const whole = fs.readFileSync(chatLog(path.join(dir, "whole.jsonl")))
  const file = path.join(dir, "r.jsonl")
  fs.writeFileSync(file, Buffer.concat([runStarted(0), started(2, "a")])) // caught mid-rollback: seq 1 isn't there yet
  let calls = 0
  const seam: ReadOn = async (p, index, resumedRead, nodeCap) => {
    calls += 1
    try {
      return await readOn(p, index, resumedRead, nodeCap)
    } finally {
      if (calls === 1) fs.writeFileSync(file, whole) // the writer finishes while the bad read is under way
    }
  }
  expect((await refresh(file, null, { readOn: seam })).lastSeq).toBe(19)
  expect(calls).toBe(2)
})

test("a log unreadable twice in a row says so", async () => {
  const file = logOf(runStarted(0), started(2, "a"))
  let calls = 0
  const seam: ReadOn = async (p, index, resumedRead, nodeCap) => {
    calls += 1
    try {
      return await readOn(p, index, resumedRead, nodeCap)
    } finally {
      // Still changing, still unreadable.
      fs.writeFileSync(file, Buffer.concat([runStarted(0), started(calls + 2, "a")]))
    }
  }
  await expect(refresh(file, null, { readOn: seam })).rejects.toBeInstanceOf(UnreadableLog)
  expect(calls).toBe(2)
})

test("the cost counts the ids errors and retried ids it holds", async () => {
  const short = logOf(
    runStarted(0), started(1, "a"), failed(2, "a", "x"), resumed(3, ["b"]), started(4, "c"), routed(5, "c", "r"),
  )
  const long = logOf(
    runStarted(0, { model: "m".repeat(5000) }), started(1, "a".repeat(5000)),
    failed(2, "a".repeat(5000), "x".repeat(5000)), resumed(3, ["b".repeat(3000)]), started(4, "c"),
    routed(5, "c", "r".repeat(5000)),
  )
  const index = await refresh(long, null)
  const grown = cost(index) - cost(await refresh(short, null))
  // The model "stub" grows by 4996; the error and the handle are kept cut to ERROR_KEPT.
  expect(grown).toBe(4999 + ERROR_KEPT - 1 + 2999 + 4996 + ERROR_KEPT - 1)
  expect(index.nodes[1]!.handle).toBe("r".repeat(ERROR_KEPT - 1) + "…")
  const many = logOf(runStarted(0), ...Array.from({ length: 100 }, (_, i) => {
    const n = i + 1
    return started(n, String(n).padStart(4, "0") + "n".repeat(996))
  }))
  expect(cost(await refresh(many, null, { nodeCap: 5 }))).toBeLessThan(100 * 1000) // trimmed attempts no longer count
})

test("the lru keeps at most 128 logs", async () => {
  const dir = tempDir()
  const paths = Array.from({ length: LRU_LOGS + 1 }, (_, n) => chatLog(path.join(dir, `${n}.jsonl`), 0))
  const reader = new RunLogReader()
  for (const file of paths) await reader.index(file)
  expect([LRU_LOGS, reader.cached()]).toEqual([128, paths.slice(1)])
})

test("record pages seek by seq and stop at the count", async () => {
  const file = chatLog(path.join(tempDir(), "r.jsonl"), 30) // seqs 0..243
  const index = await refresh(file, null)
  const page = readEvents(file, index, { after: 99, limit: 10 })
  const seqs = Array.from({ length: 10 }, (_, i) => 100 + i)
  expect([page.events.map((e) => e.seq), page.next_after, page.cut]).toEqual([seqs, 109, false])
  const last = readEvents(file, index, { after: 240, limit: 10 })
  expect([last.events.map((e) => e.seq), last.next_after]).toEqual([[241, 242, 243], null])
  // An after that isn't a seq reads from the first record; a fractional limit is floored.
  const odd = readEvents(file, index, { after: 0.5, limit: 2.7 })
  expect([odd.events.map((e) => e.seq), odd.next_after]).toEqual([[0, 1], 1])
})

test("a page stops after its scan budget", async () => {
  const stubs = Array.from({ length: 4 }, (_, i) => commitOfSize(i + 1, `s${i + 1}`, BIG_LINE + 10, "s"))
  const file = logOf(runStarted(0), ...stubs, started(5, "next"))
  const index = await refresh(file, null)
  const page = readEvents(file, index, { after: 0, limit: 500, pageScan: 2 * BIG_LINE })
  expect([PAGE_SCAN, page.events.map((e) => e.size), page.next_after, page.cut]).toEqual([
    64 << 20, [BIG_LINE + 10, BIG_LINE + 10], 2, true,
  ])
  const rest = readEvents(file, index, { after: 4, limit: 500, pageScan: 2 * BIG_LINE })
  expect([rest.events.map((e) => e.seq), rest.next_after, rest.cut]).toEqual([[5], null, false])
}, 60_000)

test("a sparse entry marks every few mib of records", async () => {
  const head = runStarted(0)
  const commits = Array.from({ length: 7 }, (_, i) => commitOfSize(i + 1, `c${i + 1}`, 3 << 20, "c"))
  const file = logOf(head, ...commits)
  const index = await refresh(file, null)
  // Commit k starts at head + (k - 1) * 3 MiB: commits 4 and 7 are the first 8 MiB or more past the last entry.
  expect([SPARSE_BYTES, index.sparse]).toEqual([
    8 << 20, [[0, 0], [4, head.length + (9 << 20)], [7, head.length + (18 << 20)]],
  ])
  expect(readEvent(file, index, 6)!.node_id).toBe("c6")
}, 60_000)

test("long strings are cut and the page stops at its bytes", async () => {
  const commits = Array.from({ length: 100 }, (_, i) => committed(i + 1, `n${i + 1}`, { output: "x".repeat(10_000) }))
  const file = logOf(runStarted(0), ...commits)
  const page = readEvents(file, await refresh(file, null), { after: 0, limit: 500 })
  const first = page.events[0]!
  expect([first.cut, first.node_id]).toEqual([["/value/output"], "n1"])
  expect((first.payload!.value as { output: string }).output).toBe("x".repeat(FIELD_CHARS) + "…")
  expect([page.cut, page.events.length < 100, page.next_after]).toEqual([true, true, page.events.at(-1)!.seq])
  expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(PAGE_BYTES)
})

test("a line over 2 mib is a stub with its kind seq and size", async () => {
  const huge = committed(1, "big", { output: "y".repeat(BIG_LINE + 10) })
  const file = logOf(runStarted(0), huge, started(2, "next"))
  const page = readEvents(file, await refresh(file, null), { after: 0, limit: 10 })
  expect(page.events[0]).toEqual({ seq: 1, kind: "pool_commit", size: huge.length })
  expect(page.events[1]!.seq).toBe(2)
})

test("one record by seq is whole and is capped", async () => {
  const file = logOf(
    runStarted(0), started(1, "a"), committed(2, "a", { output: "z".repeat(9000) }),
    committed(3, "a", { output: "w".repeat(EVENT_BYTES) }),
  )
  const index = await refresh(file, null)
  const event = readEvent(file, index, 2)!
  expect([event.payload!.value, event.cut]).toEqual([{ output: "z".repeat(9000) }, []])
  const big = readEvent(file, index, 3)!
  expect([big.cut, big.payload!.value]).toEqual([["/value/output"], { output: "w".repeat(FIELD_CHARS) + "…" }])
  expect(readEvent(file, index, 7)).toBeNull()
  expect([readEvent(file, index, 1.5), readEvent(file, index, -1)]).toEqual([null, null])
})

test("a file changed under a page stops it there", async () => {
  const file = chatLog(path.join(tempDir(), "r.jsonl"), 1)
  const index = await refresh(file, null)
  const data = linesOf(fs.readFileSync(file))
  // Line 4 is no longer seq 4.
  fs.writeFileSync(file, Buffer.concat([...data.slice(0, 4), started(9, "rewritten"), ...data.slice(5)]))
  const page = readEvents(file, index, { after: null, limit: 100 })
  expect([page.events.map((e) => e.seq), page.next_after]).toEqual([[0, 1, 2, 3], 3])
})

test("the download is every complete line as stored", async () => {
  const file = logOf(runStarted(0), started(1, "a"), committed(2, "a", { output: "d".repeat(3 << 20) }))
  const whole = fs.readFileSync(file)
  fs.appendFileSync(file, '{"torn')
  const stream = await logStream(file)
  fs.unlinkSync(file) // opened when called, so a log removed before it streams still streams whole
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  expect(Buffer.concat(chunks).equals(whole)).toBe(true)
  expect([chunks.length > 1, chunks.every((chunk) => chunk.length <= CHUNK)]).toEqual([true, true])
  let code: unknown
  try {
    await logStream(file)
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code
  }
  expect(code).toBe("ENOENT")
  fs.writeFileSync(file, '{"torn')
  const torn: unknown[] = []
  for await (const chunk of await logStream(file)) torn.push(chunk)
  expect(torn).toEqual([])
})

test("one record is capped in bytes and a payload still too large is a size stub", async () => {
  const wide = committed(1, "wide", { output: "ü".repeat(1 << 20) }) // 1 Mi characters, 2 MiB of UTF-8
  const keys = Array.from({ length: 1500 }, (_, i) => [`k${i}`, "s".repeat(3000)])
  const many = committed(2, "many", Object.fromEntries(keys)) // every string under FIELD_CHARS
  const file = logOf(runStarted(0), wide, many)
  const index = await refresh(file, null)
  expect(readEvent(file, index, 1)!.cut).toEqual(["/value/output"])
  const stub = readEvent(file, index, 2)!
  expect(stub).toEqual({ seq: 2, kind: "pool_commit", node_id: "many", size: many.length })
  expect(Buffer.byteLength(JSON.stringify(stub))).toBeLessThanOrEqual(EVENT_BYTES)
})

test("one record over huge line is a size stub never parsed", async () => {
  const exact = commitOfSize(1, "big", HUGE_LINE, "b")
  const over = commitOfSize(2, "big", HUGE_LINE + 1, "b")
  const head = runStarted(0)
  const file = logOf(head, exact, over, started(3, "next"))
  const index = await refresh(file, null)
  const whole = readEvent(file, index, 1)! // at the size: still read whole, its string cut to fit EVENT_BYTES
  expect([whole.size, whole.cut]).toEqual([undefined, ["/value/output"]])
  // A quote in the middle of a value ends its string early: a line that is parsed no longer reads as a record.
  const fd = fs.openSync(file, "r+")
  fs.writeSync(fd, '"', head.length + (exact.length >> 1))
  fs.writeSync(fd, '"', head.length + exact.length + (over.length >> 1))
  fs.closeSync(fd)
  expect(readEvent(file, index, 1)).toBeNull()
  expect(readEvent(file, index, 2)).toEqual({ seq: 2, kind: "pool_commit", size: HUGE_LINE + 1 })
  expect(readEvent(file, index, 4)).toBeNull()
}, 60_000)

test("one huge record is read without holding its line", async () => {
  const huge = committed(1, "huge", { output: "h".repeat(HUGE_LINE + (4 << 20)) })
  const file = logOf(runStarted(0), huge, started(2, "next"))
  const index = await refresh(file, null)
  expect(readEvent(file, index, 1)).toEqual({ seq: 1, kind: "pool_commit", size: huge.length })
  expect(readEvent(file, index, 2)!.node_id).toBe("next") // past the huge line, skipped without holding it
}, 60_000)

test("a record written as utf8 reads back on pages and by seq", async () => {
  const file = logOf(
    runStarted(0), started(1, "世界🚀"), committed(2, "世界🚀", { output: "é".repeat(10) }),
    succeeded(3, "世界🚀", 2),
  )
  expect(fs.readFileSync(file).includes(Buffer.from("世界🚀"))).toBe(true) // as yian writes it, not \u escapes
  const index = await refresh(file, null)
  const page = readEvents(file, index, { after: 0, limit: 10 })
  expect([page.events.map((e) => e.node_id), index.open.size]).toEqual([["世界🚀", "世界🚀", "世界🚀"], 0])
  expect(readEvent(file, index, 2)!.payload!.value).toEqual({ output: "é".repeat(10) })
})

test("a commit value shows in its display form", async () => {
  const ref = { uri: "file:///tmp/a.txt", mime: "text/plain", name: "a.txt" }
  const file = logOf(
    runStarted(0), started(1, "a"), committed(2, "a", 2n ** 60n, "int"), committed(3, "a", 5n, "int"),
    committed(4, "a", 1.5, "float"), committed(5, "a", Infinity, "float"), committed(6, "a", -Infinity, "float"),
    committed(7, "a", { inbox: "messages" }, "inbox"), committed(8, "a", ref, "file"), committed(9, "a", 123n, "int"),
  )
  const index = await refresh(file, null)
  // A wire fromWire refuses can't be indexed (yian's reader refuses it too); it reaches a page only as a line
  // rewritten since, here one of the same length.
  const refused = committed(9, "a", "x", "int")
  const data = fs.readFileSync(file)
  expect(refused.length).toBe(committed(9, "a", 123n, "int").length)
  fs.writeFileSync(file, Buffer.concat([data.subarray(0, data.length - refused.length), refused]))
  const values = readEvents(file, index, { after: 1, limit: 10 }).events.map((e) => e.payload!.value)
  expect(values).toEqual(["1152921504606846976", 5, 1.5, "Infinity", "-Infinity", "messages", ref, "x"])
  expect(readEvent(file, index, 2)!.payload!.value).toBe("1152921504606846976")
  expect(readEvent(file, index, 8)!.payload!.value).toEqual(ref)
  expect(readEvent(file, index, 1)!.payload).toEqual({ node_id: "a" })
})

test("a deeply nested payload is cut at its depth", async () => {
  let deep: unknown = "end"
  for (let i = 0; i < 10_000; i++) deep = [deep]
  let keyed: unknown = "end"
  for (let i = 0; i < 10_000; i++) keyed = { "a/~b": keyed }
  const file = logOf(
    runStarted(0), started(1, "a"), committed(2, "a", deep, "list[Any]"), committed(3, "a", keyed, "object"),
  )
  const index = await refresh(file, null)
  const page = readEvents(file, index, { after: 1, limit: 10 }).events
  const cases: [number, string, (at: unknown) => unknown][] = [
    [0, "/0", (at) => (at as unknown[])[0]],
    [1, "/a~1~0b", (at) => (at as Record<string, unknown>)["a/~b"]],
  ]
  for (const [n, segment, step] of cases) {
    const pointer = "/value" + segment.repeat(DEPTH_CAP - 1)
    for (const event of [page[n]!, readEvent(file, index, 2 + n)!]) {
      expect([DEPTH_CAP, event.cut]).toEqual([128, [pointer]])
      let at = event.payload!.value
      for (let depth = 1; depth < DEPTH_CAP; depth++) at = step(at)
      expect(at).toBe("…")
    }
  }
})

/** `inner` under `levels` nested objects, each keyed by a distinct `length`-character key. */
function underKeys(inner: unknown, levels: number, length: number): unknown {
  let value = inner
  for (let i = 0; i < levels; i++) value = { [String(i).padStart(4, "0") + "k".repeat(length - 4)]: value }
  return value
}

test("a payload whose cuts would name too much is a size stub", async () => {
  // Each pointer to an empty array at depth 128 is about 50 K characters: two pass CUT_CHARS.
  const fan = underKeys(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`a${i}`, []])), 126, 400)
  // Each pointer to a cut string is about 10 K characters; on a page every string is cut, by seq only once the
  // record is over EVENT_BYTES.
  const strings = (count: number) =>
    underKeys(Array.from({ length: count }, () => "s".repeat(FIELD_CHARS + 1)), 10, 1000)
  const records = [
    committed(1, "fan", fan), committed(2, "few", strings(20)), committed(3, "many", strings(600)),
  ]
  expect([records[1]!.length < BIG_LINE, records[2]!.length > EVENT_BYTES, CUT_CHARS]).toEqual([true, true, 64 << 10])
  const file = logOf(runStarted(0), ...records)
  const index = await refresh(file, null)
  const page = readEvents(file, index, { after: 0, limit: 10 })
  expect(page.events.slice(0, 2)).toEqual([
    { seq: 1, kind: "pool_commit", node_id: "fan", size: records[0]!.length },
    { seq: 2, kind: "pool_commit", node_id: "few", size: records[1]!.length },
  ])
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024)
  for (const seq of [1, 3]) {
    const size = records[seq - 1]!.length
    expect(readEvent(file, index, seq)).toEqual({ seq, kind: "pool_commit", node_id: seq === 1 ? "fan" : "many", size })
  }
})

/** The first commit on `log`'s page that names its value by `from`, for node `nodeId`. */
async function derivedOf(log: string, nodeId: string) {
  const index = await refresh(log, null)
  const event = readEvents(log, index, { after: null, limit: 500 }).events.find(
    (e) => e.kind === "pool_commit" && e.node_id === nodeId && e.payload?.from !== undefined,
  )!
  return { index, event }
}

const NO_ENV = () => undefined

test("a derived commit shows its value when opened", async () => {
  const { log, codeRoot } = await realRun(tempDir(), LOOP_FLOW)
  const { index, event } = await derivedOf(log, "l#0/__end__")
  expect([event.payload!.key, event.payload!.value]).toEqual(["l#0/__end__", undefined])
  const reader = new RunLogReader()
  const opened = await reader.readEvent(log, index, event.seq, { fold: { env: NO_ENV, codeRoot } })
  expect(opened).toEqual({ ...event, payload: { ...event.payload, kind: "object", value: { n: 1 } } })
  expect(await reader.readEvent(log, index, event.seq)).toEqual(event)
  expect(readEvent(log, index, event.seq)).toEqual(event)
  // The loop's end commits under the loop's own key.
  const end = await derivedOf(log, "l~2")
  const loopEnd = await reader.readEvent(log, end.index, end.event.seq, { fold: { env: NO_ENV, codeRoot } })
  expect([loopEnd!.payload!.key, loopEnd!.payload!.value]).toEqual(["l", { n: 2 }])
})

test("a log over the fold cap shows no derived value", async () => {
  const { log, codeRoot } = await realRun(tempDir(), LOOP_FLOW)
  const { index, event } = await derivedOf(log, "l#0/__end__")
  const reader = new RunLogReader({ foldBytes: 1 })
  expect(await reader.readEvent(log, index, event.seq, { fold: { env: NO_ENV, codeRoot } })).toEqual(event)
})

test("a code reference outside the code root shows no derived value and no kinds", async () => {
  const { log, codeRoot } = await realRun(tempDir(), CODED_LOOP_FLOW, { "helpers.ts": CODED_LOOP_HELPERS })
  const { index, event } = await derivedOf(log, "l#0/__end__")
  const reader = new RunLogReader()
  const outside = { env: NO_ENV, codeRoot: tempDir() }
  expect(await reader.readEvent(log, index, event.seq, { fold: outside })).toEqual(event)
  expect(await recordedKinds(log, outside)).toBeNull()
  const inside = { env: NO_ENV, codeRoot }
  expect((await reader.readEvent(log, index, event.seq, { fold: inside }))!.payload!.value).toEqual({ n: 1 })
  expect(kindOf(await reader.kinds(log, index, inside), "l#0/prep")).toBe("code")
})

test("a real log is in the schema this office reads", async () => {
  const { log } = await realRun(tempDir(), LOOP_FLOW)
  const first = fs.readFileSync(log, "utf8").split("\n")[0]!
  expect(first).toContain(`"schema":${SCHEMA},`)
})

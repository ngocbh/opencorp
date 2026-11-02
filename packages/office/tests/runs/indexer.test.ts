import { Database } from "bun:sqlite"
import { expect, onTestFinished, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { inspectRun, readRunIndex, type RunIndexRow } from "@ngocbh/yian/run"
import { type Port, REBUILD_RETRY_MS, serve } from "../../src/runs/index_thread.ts"
import { CLOSE_MS, type IndexThread, INDEX_TIMEOUT_MS, RETRY_MS, RunIndexer } from "../../src/runs/indexer.ts"
import { tempDir } from "../helpers.ts"
import { committed, fifoAt, RUN, runStarted, started, succeeded } from "./helpers.ts"

type Event = "message" | "error" | "exit"

/** A thread that records what it is sent and replies when the test says. */
class FakeThread implements IndexThread {
  posts = 0
  terminated = false
  readonly #listeners: Record<Event, ((value: never) => void)[]> = { message: [], error: [], exit: [] }

  postMessage(): void {
    this.posts += 1
  }
  on(event: Event, fn: (value: never) => void): this {
    this.#listeners[event].push(fn)
    return this
  }
  emit(event: Event, value: unknown): void {
    for (const fn of this.#listeners[event]) fn(value as never)
  }
  reply(reply: unknown = { ok: true, skipped: [] }): void {
    this.emit("message", reply)
  }
  terminate(): Promise<number> {
    this.terminated = true
    // A real thread's terminate emits exit 1.
    queueMicrotask(() => this.emit("exit", 1))
    return Promise.resolve(1)
  }
  unref(): void {}
}

/** An indexer over fake threads: `threads` holds each thread it started, `lines` its log. */
function fake(runsDir = "/nonexistent/runs", { now }: { now?: () => number } = {}) {
  const threads: FakeThread[] = []
  const lines: string[] = []
  const indexer = new RunIndexer(runsDir, {
    log: (line) => lines.push(line),
    ...(now ? { now } : {}),
    start: () => {
      const thread = new FakeThread()
      threads.push(thread)
      return thread
    },
  })
  return { indexer, threads, lines }
}

/** An indexer over a real thread, closed when the test finishes. */
function real(runsDir: string, { timeoutMs }: { timeoutMs?: number } = {}) {
  const lines: string[] = []
  const indexer = new RunIndexer(runsDir, { log: (line) => lines.push(line), ...(timeoutMs ? { timeoutMs } : {}) })
  onTestFinished(() => indexer.close())
  return { indexer, lines }
}

/** Whether `promise` has settled, after the pending callbacks ran. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => (done = true))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return done
}

test("an update brings the index up to date on its thread", async () => {
  const runs = tempDir()
  const log = path.join(runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log))
  fs.writeFileSync(log, Buffer.concat([runStarted(0), started(1, "a"), committed(2, "a", {}), succeeded(3, "a", 2)]))
  const { indexer, lines } = real(runs)
  expect(await indexer.update()).toBe(true)
  const rows = readRunIndex(runs)
  expect(rows.map((row) => row.runId)).toEqual([RUN])
  expect(rows[0]!.status).toBe(inspectRun(log).status)
  expect(indexer.rows().get(RUN)?.status).toBe(inspectRun(log).status)
  expect(lines).toEqual([])
})

test("a missing runs folder is an empty index", async () => {
  const { indexer, lines } = real(path.join(tempDir(), "runs"))
  expect(await indexer.update()).toBe(true)
  expect(lines).toEqual([])
})

test("updates asked for while one runs share the next update", async () => {
  const { indexer, threads } = fake()
  const first = indexer.update()
  const later = [indexer.update(), indexer.update(), indexer.update()]
  expect(threads).toHaveLength(1)
  const thread = threads[0]!
  expect(thread.posts).toBe(1)
  thread.reply()
  expect(await first).toBe(true)
  expect(thread.posts).toBe(2)
  thread.reply()
  expect(await Promise.all(later)).toEqual([true, true, true])
  expect(thread.posts).toBe(2)
  expect(threads).toHaveLength(1)
})

test("a call made during an update waits for an update that starts after it", async () => {
  const { indexer, threads } = fake()
  const first = indexer.update()
  const second = indexer.update()
  threads[0]!.reply()
  expect(await first).toBe(true)
  expect(await settled(second)).toBe(false)
  threads[0]!.reply()
  expect(await second).toBe(true)
})

test("a busy index resolves false and logs only the error name", async () => {
  const { indexer, threads, lines } = fake()
  const update = indexer.update()
  threads[0]!.reply({ ok: false, error: "RunIndexBusyError", skipped: [] })
  expect(await update).toBe(false)
  expect(lines).toEqual(["run index update failed (RunIndexBusyError)"])
})

test("a thread that dies fails its update and a new thread serves the next", async () => {
  const { indexer, threads, lines } = fake()
  const first = indexer.update()
  const next = indexer.update()
  threads[0]!.emit("error", new TypeError("the thread broke"))
  expect(await first).toBe(false)
  expect(threads).toHaveLength(2)
  expect(threads[1]!.posts).toBe(1)
  // Bun emits exit after error: the late exit must not touch the new thread or its update.
  threads[0]!.emit("exit", 1)
  expect(await settled(next)).toBe(false)
  threads[1]!.reply()
  expect(await next).toBe(true)
  expect(threads[1]!.terminated).toBe(false)
  expect(lines).toEqual(["run index thread stopped (TypeError)"])
})

test("skipped logs are logged by their path only", async () => {
  const runs = tempDir()
  const log = path.join(runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log))
  fs.writeFileSync(log, '{"secret-looking content\n')
  const { indexer, lines } = real(runs)
  expect(await indexer.update()).toBe(true)
  expect(lines).toEqual([`run index skipped ${log}`])
  expect(await indexer.update()).toBe(true)
  expect(lines).toEqual([`run index skipped ${log}`])
})

test("close stops the thread and later updates resolve false", async () => {
  const { indexer, threads, lines } = fake()
  const update = indexer.update()
  await indexer.close()
  expect(await update).toBe(false)
  expect(threads[0]!.terminated).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await indexer.update()).toBe(false)
  expect(threads).toHaveLength(1)
  await indexer.close()
  expect(lines).toEqual([])
})

/** A thread stuck in a system call: its terminate never settles. */
class StuckThread extends FakeThread {
  override terminate(): Promise<number> {
    this.terminated = true
    return new Promise(() => {})
  }
}

test("close gives up on a thread that doesn't stop and logs it once", async () => {
  const lines: string[] = []
  const indexer = new RunIndexer("/nonexistent/runs", {
    log: (line) => lines.push(line),
    start: () => new StuckThread(),
    closeMs: 50,
  })
  const update = indexer.update()
  const start = performance.now()
  await indexer.close()
  expect([performance.now() - start < 1000, await update]).toEqual([true, false])
  expect(lines).toEqual(["run index thread stopped (close timed out)"])
  expect(await indexer.update()).toBe(false)
  await indexer.close()
  expect(lines).toEqual(["run index thread stopped (close timed out)"])
})

test("close returns as soon as the thread stops", async () => {
  // A healthy thread can be in SQLite's busy wait for the lock, up to the update's timeout.
  expect(CLOSE_MS).toBeGreaterThan(INDEX_TIMEOUT_MS)
  const lines: string[] = []
  const indexer = new RunIndexer("/nonexistent/runs", {
    log: (line) => lines.push(line),
    start: () => new FakeThread(),
    closeMs: 60_000,
  })
  void indexer.update()
  const start = performance.now()
  await indexer.close()
  expect([performance.now() - start < 1000, lines]).toEqual([true, []])
})

const INDEXER = path.join(import.meta.dir, "../../src/runs/indexer.ts")

test("the process exits with its index thread stuck opening a fifo", async () => {
  const dir = tempDir()
  const fifo = path.join(dir, "log.jsonl")
  fifoAt(fifo, { unblock: false })
  // Replies to its update, then blocks in open() until a writer comes: no writer does while the process runs.
  const thread = path.join(dir, "stuck_thread.ts")
  fs.writeFileSync(
    thread,
    [
      'import fs from "node:fs"',
      'import { parentPort, workerData } from "node:worker_threads"',
      "parentPort.on(\"message\", () => {",
      "  parentPort.postMessage({ ok: true, skipped: [] })",
      '  fs.openSync(workerData.fifo, "r")',
      "})",
    ].join("\n"),
  )
  // Exits as the daemon's entry does: process.exit once main returns. In Bun a process whose thread is stuck in a
  // system call doesn't exit by itself, terminate or not, so a bounded close and that exit are what end it.
  const office = [
    'import { Worker } from "node:worker_threads"',
    `import { RunIndexer } from ${JSON.stringify(INDEXER)}`,
    "const lines = []",
    "const indexer = new RunIndexer('/nonexistent/runs', {",
    "  log: (line) => lines.push(line),",
    `  start: () => new Worker(${JSON.stringify(thread)}, { workerData: { fifo: ${JSON.stringify(fifo)} } }),`,
    "  closeMs: 200,",
    "})",
    "if (!(await indexer.update())) process.exit(3)",
    "await Bun.sleep(300)",
    "await indexer.close()",
    "console.log(lines.join('\\n'))",
    "process.exit(0)",
  ].join("\n")
  const start = performance.now()
  const child = Bun.spawn([process.execPath, "--no-install", "--no-env-file", "--config=/dev/null", "-e", office], {
    stdout: "pipe",
    stderr: "ignore",
  })
  onTestFinished(() => child.kill("SIGKILL"))
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), 5000)))
  const status = await Promise.race([child.exited, late])
  clearTimeout(timer)
  expect([status, performance.now() - start < 5000]).toEqual([0, true])
  expect((await new Response(child.stdout).text()).trim()).toBe("run index thread stopped (close timed out)")
}, 15_000)

test("a thread that cannot start fails the update without rejecting", async () => {
  const lines: string[] = []
  class NoThreads extends Error {
    override name = "NoThreads"
  }
  const indexer = new RunIndexer("/nonexistent/runs", {
    log: (line) => lines.push(line),
    start: () => {
      throw new NoThreads("no threads left")
    },
  })
  expect(await indexer.update()).toBe(false)
  expect(lines).toEqual(["run index update failed (NoThreads)"])
})

/** A runs folder with one ended run, and its log's path. */
function oneRun(): { runs: string; log: string } {
  const runs = tempDir()
  const log = path.join(runs, RUN, "log.jsonl")
  fs.mkdirSync(path.dirname(log))
  fs.writeFileSync(log, Buffer.concat([runStarted(0), started(1, "a"), committed(2, "a", {}), succeeded(3, "a", 2)]))
  return { runs, log }
}

test("an index file that isn't a database is rebuilt from the logs", async () => {
  const { runs } = oneRun()
  const index = path.join(runs, "index.sqlite")
  fs.writeFileSync(index, "not a database, and long enough to fill a SQLite header ".repeat(4))
  // Left from the damaged database: a fresh one must not pick them up.
  for (const suffix of ["-journal", "-wal", "-shm"]) fs.writeFileSync(index + suffix, "stale")
  const { indexer, lines } = real(runs)
  expect(await indexer.update()).toBe(true)
  expect(readRunIndex(runs).map((row) => row.runId)).toEqual([RUN])
  expect(lines).toEqual(["run index unusable (SQLITE_NOTADB), rebuilding it"])
  for (const suffix of ["-journal", "-wal", "-shm"]) expect(fs.existsSync(index + suffix)).toBe(false)
})

test("a damaged index is rebuilt from the logs", async () => {
  const { runs } = oneRun()
  const { indexer, lines } = real(runs)
  expect(await indexer.update()).toBe(true)
  const index = path.join(runs, "index.sqlite")
  // Every page past the first (the header and schema) overwritten: the runs table can't be read.
  const size = fs.statSync(index).size
  const fd = fs.openSync(index, "r+")
  fs.writeSync(fd, Buffer.alloc(size - 4096, 0xa5), 0, size - 4096, 4096)
  fs.closeSync(fd)
  expect(await indexer.update()).toBe(true)
  expect(readRunIndex(runs).map((row) => row.runId)).toEqual([RUN])
  expect(lines).toEqual(["run index unusable (SQLITE_CORRUPT), rebuilding it"])
})

test("an index that can't be opened is left as it is", async () => {
  const { runs } = oneRun()
  // A folder in the index's place: SQLite can't open it, which isn't damage to rebuild.
  fs.mkdirSync(path.join(runs, "index.sqlite"))
  const { indexer, lines } = real(runs)
  expect(await indexer.update()).toBe(false)
  expect(fs.statSync(path.join(runs, "index.sqlite")).isDirectory()).toBe(true)
  // The read after the update can't open it either.
  expect(lines).toEqual(["run index update failed (SQLITE_CANTOPEN)", "run index read failed (SQLITE_CANTOPEN)"])
  expect(indexer.rows().size).toBe(0)
})

test("damage the thread reports is logged by its code", async () => {
  const { indexer, threads, lines } = fake()
  const update = indexer.update()
  threads[0]!.reply({ ok: true, skipped: [], rebuilt: "SQLITE_CORRUPT" })
  expect(await update).toBe(true)
  const failed = indexer.update()
  threads[0]!.reply({ ok: false, error: "SQLITE_IOERR", skipped: [], rebuilt: "SQLITE_NOTADB" })
  expect(await failed).toBe(false)
  expect(lines).toEqual([
    "run index unusable (SQLITE_CORRUPT), rebuilding it",
    "run index unusable (SQLITE_NOTADB), rebuilding it",
    "run index update failed (SQLITE_IOERR)",
  ])
})

const isRoot = process.getuid?.() === 0
const RUN2 = "01JA1H000000000000000000R2"

/** Adds a second ended run to `runs`, for an update to write. */
function secondRun(runs: string): void {
  fs.mkdirSync(path.join(runs, RUN2))
  const log = fs.readFileSync(path.join(runs, RUN, "log.jsonl"), "utf8")
  fs.writeFileSync(path.join(runs, RUN2, "log.jsonl"), log.replaceAll(RUN, RUN2))
}

test("a busy index is never rebuilt", async () => {
  const { runs } = oneRun()
  const { indexer, lines } = real(runs, { timeoutMs: 100 })
  expect(await indexer.update()).toBe(true)
  const db = new Database(path.join(runs, "index.sqlite"))
  try {
    db.exec("BEGIN IMMEDIATE")
    expect(await indexer.update()).toBe(false)
    expect(lines.at(-1)).toBe("run index update failed (RunIndexBusyError)")
  } finally {
    db.exec("ROLLBACK")
    db.close()
  }
  expect(readRunIndex(runs).map((row) => row.runId)).toEqual([RUN])
  expect(lines.some((line) => line.includes("rebuilding"))).toBe(false)
})

test("an index whose runs table is gone is rebuilt", async () => {
  const { runs } = oneRun()
  const { indexer, lines } = real(runs)
  expect(await indexer.update()).toBe(true)
  // The layout version stays, so yian trusts the table that isn't there.
  const db = new Database(path.join(runs, "index.sqlite"))
  db.exec("DROP TABLE runs")
  db.close()
  expect(await indexer.update()).toBe(true)
  expect(lines).toEqual(["run index unusable (SQLITE_ERROR), rebuilding it"])
  expect(readRunIndex(runs).map((row) => row.runId)).toEqual([RUN])
  expect(indexer.rows().has(RUN)).toBe(true)
})

test.skipIf(isRoot)("a read-only index file is rebuilt as a private file", async () => {
  const { runs } = oneRun()
  const index = path.join(runs, "index.sqlite")
  const { indexer, lines } = real(runs)
  expect(await indexer.update()).toBe(true)
  fs.chmodSync(index, 0o400)
  secondRun(runs)
  expect(await indexer.update()).toBe(true)
  expect(fs.statSync(index).mode & 0o777).toBe(0o600)
  expect(lines).toEqual(["run index unusable (SQLITE_READONLY), rebuilding it"])
  expect([...indexer.rows().keys()].sort()).toEqual([RUN, RUN2])
})

/** A port `serve` answers on: `replies` holds what it posted. */
function port(): Port & { replies: Record<string, unknown>[]; send(): Record<string, unknown> } {
  let listener: (message: unknown) => void = () => {}
  const replies: Record<string, unknown>[] = []
  return {
    replies,
    on(_event, fn) {
      listener = fn
    },
    postMessage(reply) {
      replies.push(reply as Record<string, unknown>)
    },
    send() {
      listener("update")
      return replies.at(-1)!
    },
  }
}

test.skipIf(isRoot)("a rebuild that fails isn't tried again for a while", () => {
  const { runs } = oneRun()
  const index = path.join(runs, "index.sqlite")
  let now = 1_000_000
  const p = port()
  serve(p, runs, 100, { now: () => now })
  expect(p.send()).toMatchObject({ ok: true })
  secondRun(runs)
  // The index can't be written, and the folder won't let it be removed.
  fs.chmodSync(index, 0o400)
  fs.chmodSync(runs, 0o500)
  try {
    const first = p.send()
    expect(first).toMatchObject({ ok: false, rebuilt: "SQLITE_READONLY", error: "EACCES" })
    now += 60_000
    const second = p.send()
    expect(second).toMatchObject({ ok: false, error: "SQLITE_READONLY" })
    expect(second).not.toHaveProperty("rebuilt")
    now += REBUILD_RETRY_MS
    expect(p.send()).toMatchObject({ ok: false, rebuilt: "SQLITE_READONLY", error: "EACCES" })
    // Each reply still carries the rows the index has.
    expect((first.rows as RunIndexRow[]).map((row) => row.runId)).toEqual([RUN])
  } finally {
    fs.chmodSync(runs, 0o700)
    fs.chmodSync(index, 0o600)
  }
})

test("a row the read skips is logged by its log path, and an unsafe id never", async () => {
  const { runs } = oneRun()
  const { indexer, lines } = real(runs, { timeoutMs: 100 })
  expect(await indexer.update()).toBe(true)
  const db = new Database(path.join(runs, "index.sqlite"))
  try {
    for (const id of [RUN2, "../evil"]) {
      db.run(
        `INSERT INTO runs SELECT ?, flow, started_at, ended_at, parent_run_id, last_seq, result, input_tokens,
           output_tokens, cache_read_tokens, reasoning_tokens, "offset", 'not a scan' FROM runs WHERE run_id = ?`,
        [id, RUN],
      )
    }
    // Held, so the update fails before it drops the rows that have no log, and the read after it still reads.
    db.exec("BEGIN IMMEDIATE")
    expect(await indexer.update()).toBe(false)
  } finally {
    db.exec("ROLLBACK")
    db.close()
  }
  expect(lines).toContain(`run index skipped ${path.join(runs, RUN2, "log.jsonl")}`)
  expect(lines.some((line) => line.includes("evil"))).toBe(false)
  expect([...indexer.rows().keys()]).toEqual([RUN])
})

/** An index row for the fake threads' replies. */
function row(runId = RUN): RunIndexRow {
  return {
    runId,
    flow: null,
    status: "succeeded",
    startedAt: "2026-10-20T10:00:00.000Z",
    endedAt: "2026-10-20T10:00:01.000Z",
    parentRunId: null,
    lastSeq: 3,
    result: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    offset: 100,
    waits: [],
    ready: false,
    wakeAt: null,
  }
}

test("rows are kept before the update settles", async () => {
  const { indexer, threads } = fake()
  let seen = false
  const update = indexer.update().then(() => (seen = indexer.rows().has(RUN)))
  threads[0]!.reply({ ok: true, skipped: [], rows: [row()] })
  await update
  expect(seen).toBe(true)
})

test("a failed update's rows are used while none are held", async () => {
  const { indexer, threads } = fake()
  const update = indexer.update()
  threads[0]!.reply({ ok: false, error: "RunIndexBusyError", skipped: [], rows: [row()] })
  expect(await update).toBe(false)
  expect(indexer.rows().has(RUN)).toBe(true)
})

test("a failed update's rows never replace the rows held", async () => {
  const { indexer, threads } = fake()
  const first = indexer.update()
  threads[0]!.reply({ ok: true, skipped: [], rows: [row()] })
  await first
  // A rebuild whose second update failed reads an empty index.
  const rebuilt = indexer.update()
  threads[0]!.reply({ ok: false, rebuilt: "SQLITE_ERROR", error: "RunIndexBusyError", skipped: [], rows: [] })
  expect(await rebuilt).toBe(false)
  // This read asks for another update.
  expect(indexer.rows().has(RUN)).toBe(true)
  expect(threads[0]!.posts).toBe(3)
  // An index of another yian version's layout reads empty too.
  threads[0]!.reply({ ok: false, error: "SQLITE_ERROR", skipped: [], rows: [] })
  await Promise.resolve()
  expect(indexer.rows().has(RUN)).toBe(true)
})

test("a read that fails, a dead thread and close keep the rows", async () => {
  const { indexer, threads, lines } = fake()
  const first = indexer.update()
  threads[0]!.reply({ ok: true, skipped: [], rows: [row()] })
  await first
  const unread = indexer.update()
  threads[0]!.reply({ ok: true, skipped: [], rows: null, readError: "SQLITE_IOERR" })
  expect(await unread).toBe(true)
  expect(lines).toEqual(["run index read failed (SQLITE_IOERR)"])
  expect(indexer.rows().has(RUN)).toBe(true)
  const dying = indexer.update()
  threads[0]!.emit("exit", 1)
  expect(await dying).toBe(false)
  expect(indexer.rows().has(RUN)).toBe(true)
  await indexer.close()
  expect(indexer.rows().has(RUN)).toBe(true)
})

test("rows after a failed update ask for another update, at most once a minute", async () => {
  let now = 1_000_000
  const { indexer, threads } = fake("/nonexistent/runs", { now: () => now })
  indexer.rows()
  expect(threads).toHaveLength(0)
  const failed = indexer.update()
  threads[0]!.reply({ ok: false, error: "SQLITE_IOERR", skipped: [], rows: [] })
  await failed
  expect(threads[0]!.posts).toBe(1)
  indexer.rows()
  expect(threads[0]!.posts).toBe(2)
  // An update in flight isn't asked for again.
  indexer.rows()
  expect(threads[0]!.posts).toBe(2)
  threads[0]!.reply({ ok: false, error: "SQLITE_IOERR", skipped: [], rows: [] })
  await Promise.resolve()
  now += 1000
  indexer.rows()
  expect(threads[0]!.posts).toBe(2)
  now += RETRY_MS
  indexer.rows()
  expect(threads[0]!.posts).toBe(3)
  threads[0]!.reply({ ok: true, skipped: [], rows: [row()] })
  await Promise.resolve()
  now += RETRY_MS
  indexer.rows()
  expect(threads[0]!.posts).toBe(3)
  await indexer.close()
  now += RETRY_MS
  indexer.rows()
  expect(threads[0]!.posts).toBe(3)
})

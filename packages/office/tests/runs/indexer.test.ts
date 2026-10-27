import { expect, onTestFinished, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { inspectRun, readRunIndex } from "@ngocbh/yian/run"
import { type IndexThread, RunIndexer } from "../../src/runs/indexer.ts"
import { tempDir } from "../helpers.ts"
import { committed, RUN, runStarted, started, succeeded } from "./helpers.ts"

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
function fake(runsDir = "/nonexistent/runs") {
  const threads: FakeThread[] = []
  const lines: string[] = []
  const indexer = new RunIndexer(runsDir, {
    log: (line) => lines.push(line),
    start: () => {
      const thread = new FakeThread()
      threads.push(thread)
      return thread
    },
  })
  return { indexer, threads, lines }
}

/** An indexer over a real thread, closed when the test finishes. */
function real(runsDir: string) {
  const lines: string[] = []
  const indexer = new RunIndexer(runsDir, { log: (line) => lines.push(line) })
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
  expect(lines).toEqual(["run index damaged (SQLITE_NOTADB), rebuilding it"])
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
  expect(lines).toEqual(["run index damaged (SQLITE_CORRUPT), rebuilding it"])
})

test("an index that can't be opened is left as it is", async () => {
  const { runs } = oneRun()
  // A folder in the index's place: SQLite can't open it, which isn't damage to rebuild.
  fs.mkdirSync(path.join(runs, "index.sqlite"))
  const { indexer, lines } = real(runs)
  expect(await indexer.update()).toBe(false)
  expect(fs.statSync(path.join(runs, "index.sqlite")).isDirectory()).toBe(true)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatch(/^run index update failed \(\w+\)$/)
})

test("damage the thread reports is logged by its code", async () => {
  const { indexer, threads, lines } = fake()
  const update = indexer.update()
  threads[0]!.reply({ ok: true, skipped: [], rebuilt: "SQLITE_CORRUPT" })
  expect(await update).toBe(true)
  const failed = indexer.update()
  threads[0]!.reply({ ok: false, error: "SQLiteError", skipped: [], rebuilt: "SQLITE_NOTADB" })
  expect(await failed).toBe(false)
  expect(lines).toEqual([
    "run index damaged (SQLITE_CORRUPT), rebuilding it",
    "run index damaged (SQLITE_NOTADB), rebuilding it",
    "run index update failed (SQLiteError)",
  ])
})

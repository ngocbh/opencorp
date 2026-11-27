/** The replays' host: each replay read on the viewer thread, one at a time; an ask answers once its read is done or
 *  says it's still loading, and the read goes on for the next ask; a queued read no one asks for any more is dropped;
 *  a kept result answers at once, any other is delivered once; a thread that dies or runs too long is replaced. A fake
 *  thread stands in. */
import { expect, test } from "bun:test"
import { LOADING, ReplayFailed, type ReplayJob, Replays, type ReplayThread } from "../../../src/runtime/runs/replays.ts"
import { waitFor } from "../../helpers.ts"

/** A thread event's listener: each event's takes its own argument. */
type Listener = (value: never) => void

/** A thread that records what it is sent and answers when told. */
class FakeThread implements ReplayThread {
  readonly sent: { id: number; job: ReplayJob }[] = []
  readonly #listeners = new Map<string, Listener[]>()
  terminated = false

  postMessage(message: unknown): void {
    this.sent.push(message as { id: number; job: ReplayJob })
  }

  on(event: string, fn: Listener): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), fn])
    return this
  }

  emit(event: string, value: unknown): void {
    for (const fn of this.#listeners.get(event) ?? []) (fn as (value: unknown) => void)(value)
  }

  /** Answers the `i`th job sent with what it read (its record's seq), or with `error`. */
  answer(i: number, error?: string): void {
    const { id, job } = this.sent[i]!
    this.emit("message", error === undefined ? { id, value: { read: (job as { seq: number }).seq } } : { id, error })
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(1)
  }

  unref(): void {}
}

const job = (seq: number): ReplayJob => ({ kind: "record", log: "/runs/r1/log.jsonl", seq, codeRoot: "/w", maxBytes: 1 })

/** A host whose threads are fakes, each kept in `threads` as it starts, on the clock `clock.now`. */
function host(options: { limitMs?: number; abandonMs?: number } = {}) {
  const threads: FakeThread[] = []
  const clock = { now: 0 }
  const replays = new Replays({
    start: () => {
      const thread = new FakeThread()
      threads.push(thread)
      return thread
    },
    now: () => clock.now,
    ...options,
  })
  return { replays, threads, clock }
}

/** Asks for record `seq`'s replay under key `k<seq>`, waiting at most `waitMs`; the fake thread's answers are no
 *  record, so the result is unknown. */
const ask = (replays: Replays, seq: number, { keep = false, waitMs = 1000, signal }: {
  keep?: boolean; waitMs?: number; signal?: AbortSignal } = {}): Promise<unknown> =>
  replays.ask(`k${seq}`, job(seq), { keep, waitMs, signal })

test("replays are read one at a time, in the order asked, on one thread started when first needed", async () => {
  const { replays, threads } = host()
  expect(threads).toHaveLength(0)
  const a = ask(replays, 1)
  const b = ask(replays, 2)
  await waitFor(() => threads[0]?.sent.length === 1)
  expect(threads[0]!.sent.map((s) => s.job)).toEqual([job(1)])
  threads[0]!.answer(0)
  expect(await a).toEqual({ read: 1 })
  await waitFor(() => threads[0]!.sent.length === 2)
  threads[0]!.answer(1)
  expect(await b).toEqual({ read: 2 })
  expect(threads).toHaveLength(1)
})

test("an ask not answered in time says it's loading; the read goes on, and the next ask gets it, read once", async () => {
  const { replays, threads } = host()
  expect(await ask(replays, 1, { waitMs: 10 })).toBe(LOADING)
  expect(await ask(replays, 1, { waitMs: 10 })).toBe(LOADING)
  threads[0]!.answer(0)
  expect(await ask(replays, 1, { waitMs: 10 })).toEqual({ read: 1 })
  expect(threads[0]!.sent).toHaveLength(1)
  // Not kept: delivered once, it is read again when asked again.
  const again = ask(replays, 1)
  await waitFor(() => threads[0]!.sent.length === 2)
  threads[0]!.answer(1)
  expect(await again).toEqual({ read: 1 })
})

test("a kept result answers every later ask at once", async () => {
  const { replays, threads } = host()
  const a = ask(replays, 1, { keep: true })
  await waitFor(() => threads[0]?.sent.length === 1)
  threads[0]!.answer(0)
  expect(await a).toEqual({ read: 1 })
  for (let i = 0; i < 3; i++) expect(await ask(replays, 1, { keep: true, waitMs: 0 })).toEqual({ read: 1 })
  expect(threads[0]!.sent).toHaveLength(1)
})

test("a queued read no one asks for any more is dropped when its turn comes", async () => {
  const { replays, threads, clock } = host({ abandonMs: 5000 })
  const a = ask(replays, 1)
  expect(await ask(replays, 2, { waitMs: 0 })).toBe(LOADING)
  // A reader that leaves while waiting gives its read up at once.
  const left = new AbortController()
  const c = ask(replays, 3, { signal: left.signal })
  left.abort()
  expect(await c).toBe(LOADING)
  await waitFor(() => threads[0]?.sent.length === 1)
  clock.now = 6000
  threads[0]!.answer(0)
  expect(await a).toEqual({ read: 1 })
  // 2 was last asked for 6 s ago and 3's reader left: neither is read, and asked again, each starts afresh.
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(threads[0]!.sent).toHaveLength(1)
  const fresh = ask(replays, 2)
  await waitFor(() => threads[0]!.sent.length === 2)
  threads[0]!.answer(1)
  expect(await fresh).toEqual({ read: 2 })
})

test("a replay the thread can't read fails with its error's type, once, and the next ask reads again", async () => {
  const { replays, threads } = host()
  expect(await ask(replays, 1, { waitMs: 0 })).toBe(LOADING)
  await waitFor(() => threads[0]?.sent.length === 1)
  threads[0]!.answer(0, "RunLogSchemaError")
  const error = await ask(replays, 1).catch((e: unknown) => e)
  expect([error instanceof ReplayFailed, (error as Error).message]).toEqual([true, "RunLogSchemaError"])
  const retried = ask(replays, 1)
  await waitFor(() => threads[0]!.sent.length === 2)
  threads[0]!.answer(1)
  expect(await retried).toEqual({ read: 1 })
})

test("a thread that dies fails the replay it was reading, and the next replay starts another", async () => {
  const { replays, threads } = host()
  const a = ask(replays, 1)
  const b = ask(replays, 2)
  await waitFor(() => threads[0]?.sent.length === 1)
  threads[0]!.emit("exit", 1)
  expect(((await a.catch((e: unknown) => e)) as Error).message).toBe("the viewer thread stopped (1)")
  await waitFor(() => threads[1]?.sent.length === 1)
  expect(threads[1]!.sent[0]!.job).toEqual(job(2))
  threads[1]!.answer(0)
  expect(await b).toEqual({ read: 2 })
})

test("a replay that takes too long is given up: its thread is stopped and the next replay starts another", async () => {
  const { replays, threads } = host({ limitMs: 50 })
  const a = ask(replays, 1)
  const b = ask(replays, 2)
  const error = await a.catch((e: unknown) => e)
  expect([error instanceof ReplayFailed, (error as Error).message]).toEqual([true, "it took over 0.05 s"])
  expect(threads[0]!.terminated).toBe(true)
  await waitFor(() => threads[1]?.sent.length === 1)
  threads[1]!.answer(0)
  expect(await b).toEqual({ read: 2 })
})

test("close fails what is asked for and stops the thread", async () => {
  const { replays, threads } = host()
  const a = ask(replays, 1)
  const b = ask(replays, 2)
  await waitFor(() => threads[0]?.sent.length === 1)
  await replays.close()
  await expect(a).rejects.toThrow()
  await expect(b).rejects.toThrow()
  expect(threads[0]!.terminated).toBe(true)
  await expect(ask(replays, 3)).rejects.toThrow()
})

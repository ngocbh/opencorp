/** The node views' host: each view read on the views thread, one at a time, a queued one dropped once its reader left,
 *  a settled attempt's view kept, and a thread that dies or runs too long replaced. A fake thread stands in. */
import { expect, test } from "bun:test"
import type { RunNodeView } from "@opencorp/protocol"
import { NodeViews, ViewFailed, type ViewJob, type ViewThread } from "../../../src/runtime/runs/views.ts"
import { waitFor } from "../../helpers.ts"

/** A thread event's listener: each event's takes its own argument. */
type Listener = (value: never) => void

/** A thread that records what it is sent and answers when told. */
class FakeThread implements ViewThread {
  readonly sent: { id: number; job: ViewJob }[] = []
  readonly #listeners = new Map<string, Listener[]>()
  terminated = false

  postMessage(message: unknown): void {
    this.sent.push(message as { id: number; job: ViewJob })
  }

  on(event: string, fn: Listener): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), fn])
    return this
  }

  emit(event: string, value: unknown): void {
    for (const fn of this.#listeners.get(event) ?? []) (fn as (value: unknown) => void)(value)
  }

  /** Answers the `i`th job sent with a view of its node, or with `error`. */
  answer(i: number, error?: string): void {
    const { id, job } = this.sent[i]!
    this.emit("message", error === undefined ? { id, view: viewOf(job.nodeId) } : { id, error })
  }

  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(1)
  }

  unref(): void {}
}

const viewOf = (nodeId: string): RunNodeView => ({ kind: "code", inputs: [], outputs: [{ name: "output", value: nodeId }],
                                                    missing: null })
const job = (nodeId: string): ViewJob => ({ log: "/runs/r1/log.jsonl", nodeId, attempt: 1, ender: null, codeRoot: null })

/** A host whose threads are fakes, each kept in `threads` as it starts. */
function host(options: { limitMs?: number } = {}) {
  const threads: FakeThread[] = []
  const views = new NodeViews({
    start: () => {
      const thread = new FakeThread()
      threads.push(thread)
      return thread
    },
    ...options,
  })
  return { views, threads }
}

test("views are read one at a time, in the order asked, on one thread started when first needed", async () => {
  const { views, threads } = host()
  expect(threads).toHaveLength(0)
  const a = views.view(job("a"))
  const b = views.view(job("b"))
  await waitFor(() => threads[0]?.sent.length === 1)
  expect(threads[0]!.sent.map((s) => s.job.nodeId)).toEqual(["a"])
  threads[0]!.answer(0)
  expect(await a).toEqual(viewOf("a"))
  await waitFor(() => threads[0]!.sent.length === 2)
  threads[0]!.answer(1)
  expect(await b).toEqual(viewOf("b"))
  expect(threads).toHaveLength(1)
})

test("a queued view whose reader left is never read; one being read is kept for the next reader", async () => {
  const { views, threads } = host()
  const first = new AbortController()
  const a = views.view(job("a"), { key: "a", signal: first.signal })
  const gone = new AbortController()
  const b = views.view(job("b"), { key: "b", signal: gone.signal })
  const c = views.view(job("c"))
  await waitFor(() => threads[0]?.sent.length === 1)
  gone.abort()
  first.abort()
  await expect(b).rejects.toThrow()
  await expect(a).rejects.toThrow()
  // a's read goes on and is kept; b is skipped.
  threads[0]!.answer(0)
  await waitFor(() => threads[0]!.sent.length === 2)
  expect(threads[0]!.sent.map((s) => s.job.nodeId)).toEqual(["a", "c"])
  threads[0]!.answer(1)
  expect(await c).toEqual(viewOf("c"))
  expect(await views.view(job("a"), { key: "a" })).toEqual(viewOf("a"))
  expect(threads[0]!.sent).toHaveLength(2)
})

test("a view with a key is kept: the same key answers at once, and a queued one answers when its turn comes", async () => {
  const { views, threads } = host()
  const a = views.view(job("a"), { key: "k" })
  const again = views.view(job("a"), { key: "k" })
  await waitFor(() => threads[0]?.sent.length === 1)
  threads[0]!.answer(0)
  expect(await a).toEqual(viewOf("a"))
  expect(await again).toEqual(viewOf("a"))
  expect(await views.view(job("a"), { key: "k" })).toEqual(viewOf("a"))
  // Without a key, it is read again.
  const unkept = views.view(job("a"))
  await waitFor(() => threads[0]!.sent.length === 2)
  threads[0]!.answer(1)
  await unkept
})

test("a view the thread can't read fails with its error's type, and the next is read", async () => {
  const { views, threads } = host()
  const a = views.view(job("a"))
  const b = views.view(job("b"))
  await waitFor(() => threads[0]?.sent.length === 1)
  threads[0]!.answer(0, "RunLogSchemaError")
  const error = await a.catch((e: unknown) => e)
  expect([error instanceof ViewFailed, (error as Error).message]).toEqual([true, "RunLogSchemaError"])
  await waitFor(() => threads[0]!.sent.length === 2)
  threads[0]!.answer(1)
  expect(await b).toEqual(viewOf("b"))
})

test("a thread that dies fails the view it was reading, and the next view starts another", async () => {
  const { views, threads } = host()
  const a = views.view(job("a"))
  const b = views.view(job("b"))
  await waitFor(() => threads[0]?.sent.length === 1)
  threads[0]!.emit("exit", 1)
  expect(((await a.catch((e: unknown) => e)) as Error).message).toBe("the views thread stopped (1)")
  await waitFor(() => threads[1]?.sent.length === 1)
  expect(threads[1]!.sent[0]!.job.nodeId).toBe("b")
  threads[1]!.answer(0)
  expect(await b).toEqual(viewOf("b"))
})

test("a view that takes too long is given up: its thread is stopped and the next view starts another", async () => {
  const { views, threads } = host({ limitMs: 50 })
  const a = views.view(job("a"))
  const b = views.view(job("b"))
  const error = await a.catch((e: unknown) => e)
  expect([error instanceof ViewFailed, (error as Error).message]).toEqual([true, "it took over 0.05 s"])
  expect(threads[0]!.terminated).toBe(true)
  await waitFor(() => threads[1]?.sent.length === 1)
  threads[1]!.answer(0)
  expect(await b).toEqual(viewOf("b"))
})

test("close fails what is queued and stops the thread", async () => {
  const { views, threads } = host()
  const a = views.view(job("a"))
  const b = views.view(job("b"))
  await waitFor(() => threads[0]?.sent.length === 1)
  await views.close()
  await expect(a).rejects.toThrow()
  await expect(b).rejects.toThrow()
  expect(threads[0]!.terminated).toBe(true)
  await expect(views.view(job("c"))).rejects.toThrow()
})

// A running run's live stream on its page: the model calls in flight as their text streams in, and the rule for when
// the page follows the stream and from which seq.
import type { RunLiveFrame } from "@opencorp/client"

/** A model call of a running run, as its live stream shows it. */
export type LiveCall = {
  node: string
  /** Its number within the node's attempt. */
  n: number
  text: string
  /** The index its next chunk carries. */
  next: number
  ended: boolean
  /** Why it failed, once ended; null otherwise. */
  error: string | null
}

/** `calls` after frame `f`: unchanged by frames that aren't about a call, and by a repeated chunk. */
export function applyLive(calls: LiveCall[], f: RunLiveFrame): LiveCall[] {
  if (f.type !== "call" && f.type !== "start" && f.type !== "chunk" && f.type !== "end") return calls
  const i = calls.findIndex((c) => c.node === f.node && c.n === f.n)
  const was: LiveCall = calls[i] ?? { node: f.node, n: f.n, text: "", next: 0, ended: false, error: null }
  let now: LiveCall
  if (f.type === "call") now = { ...was, text: f.text, next: f.next_index }
  else if (f.type === "start") now = { ...was, text: "", next: 0, ended: false, error: null }
  else if (f.type === "end") now = { ...was, ended: true, error: f.error }
  else if (f.index < was.next) return calls
  // A merged chunk carries its last chunk's index.
  else now = { ...was, text: was.text + f.text, next: f.index + 1 }
  return i < 0 ? [...calls, now] : calls.map((c, j) => (j === i ? now : c))
}

/** The calls of `node` to show: those with text that isn't blank. */
export const shownCalls = (calls: LiveCall[], node: string) =>
  calls.filter((c) => c.node === node && c.text.trim() !== "")

/**
 * Follows a run's live stream while the run is running, one stream at a time, each from the highest seq the page has.
 * A stream that ends with `reset` opens again at once (a second in a row waits the delay); one that ends with
 * `run_end` or closes opens again when `status` says the run is running, or after a delay (from `minDelayMs`,
 * doubling to `maxDelayMs`) while it still is, since a `run_end` can come before a new worker's first snapshot.
 */
export function liveFollow(opts: {
  /** Opens a stream of the records after `after` (all of them when undefined), calling `handler` with its frames. */
  open: (after: number | undefined, handler: (f: RunLiveFrame) => void) => { close(): void }
  /** Called with each record frame's seq. */
  onRecord: (seq: number) => void
  /** Called with the live calls whenever they change. */
  onCalls: (calls: LiveCall[]) => void
  minDelayMs?: number
  maxDelayMs?: number
}) {
  const { minDelayMs = 1_000, maxDelayMs = 10_000 } = opts
  let running = false
  let disposed = false
  let highest = -1
  let calls: LiveCall[] = []
  let stream: { close(): void } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = minDelayMs
  let resets = 0 // streams in a row that ended in a reset with nothing before it

  function setCalls(next: LiveCall[]) {
    if (next === calls || (next.length === 0 && calls.length === 0)) return
    calls = next
    opts.onCalls(calls)
  }

  function open() {
    clearTimeout(timer)
    timer = undefined
    if (disposed || !running || stream) return
    // The join's call frames fill them again.
    setCalls([])
    // False once this stream ended or was closed: its late frames are dropped.
    let mine = true
    const s = opts.open(highest < 0 ? undefined : highest, (f) => {
      if (!mine) return
      if (f.type === "run_end" || f.type === "reset" || f.type === "closed") {
        mine = false
        stream = undefined
        return ended(f.type === "reset")
      }
      delay = minDelayMs
      resets = 0
      if (f.type === "record") {
        highest = Math.max(highest, f.seq)
        opts.onRecord(f.seq)
      } else setCalls(applyLive(calls, f))
    })
    if (!mine) return
    stream = {
      close() {
        mine = false
        s.close()
      },
    }
  }

  function ended(reset: boolean) {
    if (reset) {
      setCalls([])
      if (++resets < 2) return open()
    }
    if (disposed || !running) return
    timer = setTimeout(open, delay)
    delay = Math.min(delay * 2, maxDelayMs)
  }

  return {
    /** The run's status, as its header or a `run.updated` says it. */
    status(status: string) {
      running = status === "running"
      if (running) return open()
      clearTimeout(timer)
      timer = undefined
      delay = minDelayMs
      resets = 0
    },
    /** A seq the page has read (a node's start or end, a divider). */
    seen(seq: number) {
      highest = Math.max(highest, seq)
    },
    /** Closes the stream and stops for good. */
    dispose() {
      disposed = true
      clearTimeout(timer)
      stream?.close()
      stream = undefined
    },
  }
}

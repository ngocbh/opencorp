/** Steer and interrupt requests for a worker's running nodes. */
import type { Steering } from "@ngocbh/yian/run"

// Handed to a finished node or after close, so a late interrupt can't reach it.
const NEVER = new AbortController().signal

/**
 * Yian's `Steering` inbox, fed by the office's `steer` and `interrupt` frames.
 *
 * A steer for a node that hasn't started waits until the node drains it; so does an interrupt,
 * which aborts the node's signal before the node takes it, so the node stops once it starts.
 * Once a node is finished, new steers and interrupts for it are refused (a refused interrupt is
 * dropped; a refused steer goes back to the office). `close` at the end of the run refuses
 * everything and returns every steer never read, including those for nodes that never ran. A
 * resumed run's inbox doesn't know the nodes finished before the resume, so their steers wait
 * until `close`.
 */
export class Inbox implements Steering {
  #queued = new Map<string, string[]>()
  #stops = new Map<string, AbortController>()
  // Nodes that took their signal; one taken and aborted was cut short by yian.
  #taken = new Set<string>()
  #finished = new Set<string>()
  #closed = false

  /** Queue `text` for `nodeId`; false if the node finished or the inbox is closed. */
  steer(nodeId: string, text: string): boolean {
    if (this.#refuses(nodeId)) return false
    const queue = this.#queued.get(nodeId)
    if (queue) queue.push(text)
    else this.#queued.set(nodeId, [text])
    return true
  }

  /** Ask `nodeId` to stop by aborting its signal; false if it finished or the inbox is closed. */
  interrupt(nodeId: string): boolean {
    if (this.#refuses(nodeId)) return false
    this.#controller(nodeId).abort()
    return true
  }

  /** Remove and return `nodeId`'s queued steers, oldest first. */
  drain(nodeId: string): string[] {
    const queue = this.#queued.get(nodeId) ?? []
    this.#queued.delete(nodeId)
    return queue
  }

  /** The signal aborted when `nodeId` is asked to stop; one that never aborts once it finished or the inbox closed. */
  interruptSignal(nodeId: string): AbortSignal {
    if (this.#refuses(nodeId)) return NEVER
    this.#taken.add(nodeId)
    return this.#controller(nodeId).signal
  }

  /** Whether `nodeId` took its interrupt signal and it is aborted, and so stopped short of its full reply. */
  cut(nodeId: string): boolean {
    return this.#taken.has(nodeId) && this.#stops.get(nodeId)?.signal.aborted === true
  }

  /** Mark `nodeId` finished; return the steers it never read. */
  finish(nodeId: string): string[] {
    this.#finished.add(nodeId)
    this.#stops.delete(nodeId)
    this.#taken.delete(nodeId)
    return this.drain(nodeId)
  }

  /** Refuse every later steer and interrupt; remove and return every queued steer, by node id. */
  close(): Map<string, string[]> {
    this.#closed = true
    this.#stops.clear()
    this.#taken.clear()
    const queued = this.#queued
    this.#queued = new Map()
    return queued
  }

  #refuses(nodeId: string): boolean {
    return this.#closed || this.#finished.has(nodeId)
  }

  #controller(nodeId: string): AbortController {
    let controller = this.#stops.get(nodeId)
    if (!controller) {
      controller = new AbortController()
      this.#stops.set(nodeId, controller)
    }
    return controller
  }
}

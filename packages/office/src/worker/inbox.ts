/** Interrupt requests for a worker's running nodes. */
import type { Steering } from "@ngocbh/yian/run"

/**
 * Interrupt requests for a run's agents, fed by the office's `interrupt` frames; until yian's host
 * `interrupt(run, inbox)` lands.
 *
 * An interrupt for a node that hasn't started aborts the node's signal before the node takes it, so the node stops
 * once it starts. Once a node is finished, new interrupts for it are refused and dropped; `close` at the end of the
 * run refuses every later one.
 */
export class Interrupts implements Steering {
  #controllers = new Map<string, AbortController>()
  // Nodes that took their signal; one taken and aborted was asked to stop before or while it ran.
  #taken = new Set<string>()
  #finished = new Set<string>()
  #closed = false

  /** Ask `nodeId` to stop by aborting its signal; false if it finished or the run closed. */
  interrupt(nodeId: string): boolean {
    if (this.#refuses(nodeId)) return false
    this.#controller(nodeId).abort()
    return true
  }

  /** The signal aborted when `nodeId` is asked to stop; one that never aborts once it finished or the run closed. */
  interruptSignal(nodeId: string): AbortSignal {
    // A fresh one each call, so listeners never pile up on one shared signal.
    if (this.#refuses(nodeId)) return new AbortController().signal
    this.#taken.add(nodeId)
    return this.#controller(nodeId).signal
  }

  /**
   * Whether `nodeId` was asked to stop after it took its signal (an interrupt sent before or while it
   * ran); yian may still have finished the reply first, since it checks the signal only between model
   * calls, and a resumed run's replay ignores it.
   */
  cut(nodeId: string): boolean {
    return this.#taken.has(nodeId) && this.#controllers.get(nodeId)?.signal.aborted === true
  }

  /** Mark `nodeId` finished. */
  finish(nodeId: string): void {
    this.#finished.add(nodeId)
    this.#controllers.delete(nodeId)
    this.#taken.delete(nodeId)
  }

  /** Refuse every later interrupt. */
  close(): void {
    this.#closed = true
    this.#controllers.clear()
    this.#taken.clear()
  }

  #refuses(nodeId: string): boolean {
    return this.#closed || this.#finished.has(nodeId)
  }

  #controller(nodeId: string): AbortController {
    let controller = this.#controllers.get(nodeId)
    if (!controller) {
      controller = new AbortController()
      this.#controllers.set(nodeId, controller)
    }
    return controller
  }
}

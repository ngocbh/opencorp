import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createOfficeClient } from "../office/client"
import { runEach } from "../office/queue"
import { emptyState, type OfficeState } from "../office/store"
import { createOfficeSync, type OfficeEvents, type OfficeStatus } from "../office/sync"
import { createSimpleContext } from "./helper"

// Streamed deltas arrive many times a second; applying them in one batch per frame keeps
// rendering from running once per event.
const FLUSH_MS = 16

export const { use: useOffice, provider: OfficeProvider } = createSimpleContext({
  name: "Office",
  init: (props: { socket: string; cwd: string }) => {
    const client = createOfficeClient({ socket: props.socket })
    const [state, setState] = createStore<OfficeState>(emptyState())
    const [status, setStatus] = createSignal<OfficeStatus>("connecting")
    const [error, setError] = createSignal<string>()
    let queue: ((s: OfficeState) => void)[] = []
    let after: (() => void)[] = []
    let timer: ReturnType<typeof setTimeout> | undefined

    function flush() {
      timer = undefined
      const fns = queue
      const calls = after
      queue = []
      after = []
      // One bad update mustn't drop the rest, or the callbacks waiting on them.
      batch(() => setState(produce((s) => runEach(fns, s))))
      runEach(calls)
    }

    const sync = createOfficeSync({
      client,
      cwd: props.cwd,
      state: () => state,
      mutate(fn) {
        queue.push(fn)
        timer ??= setTimeout(flush, FLUSH_MS)
      },
      // "online" follows the snapshot it was set after, so readers never see it with stale state.
      onStatus(next, message) {
        const apply = () =>
          batch(() => {
            setStatus(next)
            setError(message)
          })
        if (!timer) return apply()
        after.push(apply)
      },
    })

    onMount(sync.start)
    onCleanup(() => {
      sync.stop()
      if (timer) clearTimeout(timer)
    })

    return {
      client,
      cwd: props.cwd,
      state: state as Readonly<OfficeState>,
      status,
      /** Why the office's state couldn't be read, while `status()` is `"error"`. */
      error,
      /** Loads a session's messages and open questions and keeps them live; resolves once they are in `state`. */
      async syncSession(id: string) {
        await sync.syncSession(id)
        await settled()
      },
      /** Re-reads a question into `state`, e.g. after an answer finds it already closed. */
      async refreshQuestion(id: string) {
        await sync.refreshQuestion(id)
        await settled()
      },
      /** Re-reads both people lists, e.g. after a hire (there are no person events). */
      async refreshPeople() {
        await sync.refreshPeople()
        await settled()
      },
      /** Calls `fn` for each event of `type` once it is visible in `state`; returns an unsubscribe. */
      on<K extends keyof OfficeEvents>(type: K, fn: (e: OfficeEvents[K]) => void) {
        return sync.on(type, (e) => {
          if (!timer) return fn(e)
          after.push(() => fn(e))
        })
      },
    }

    /** Resolves after queued changes are flushed into `state`. */
    function settled() {
      if (!timer) return Promise.resolve()
      return new Promise<void>((resolve) => after.push(resolve))
    }
  },
})

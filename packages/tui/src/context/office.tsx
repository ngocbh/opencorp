import { batch, createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ConnectionList, Question } from "@opencorp/protocol"
import {
  createOfficeClient,
  runEach,
  emptyState,
  type OfficeState,
  createOfficeSync,
  type OfficeEvents,
  type OfficeStatus,
} from "@opencorp/client"
import { createSimpleContext } from "./helper"

// Streamed deltas arrive many times a second; applying them in one batch per frame keeps
// rendering from running once per event.
const FLUSH_MS = 16

export const { use: useOffice, provider: OfficeProvider } = createSimpleContext({
  name: "Office",
  init: (props: { socket: string; token?: string; cwd: string }) => {
    const client = createOfficeClient({ socket: props.socket, token: props.token })
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

    const [connections, setConnections] = createSignal<ConnectionList>()
    let connectionsRead = 0
    /**
     * Re-reads the office's connections and returns them; on failure it throws and the last list
     * stays. Only the latest read's answer is kept, so a slow earlier one can't overwrite it.
     */
    async function refreshConnections() {
      const read = ++connectionsRead
      const list = await client.connections.list()
      if (read === connectionsRead) setConnections(list)
      return list
    }
    // Labels fall back to the bare connection without the list (an office older than connections,
    // say), so a failed read here is not worth an error.
    createEffect(
      on(status, (s) => {
        if (s === "online") refreshConnections().catch(() => {})
      }),
    )

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
      /** The office's model connections, read when it comes online and on `refreshConnections()`. */
      connections,
      refreshConnections,
      /** Whether this person may add, remove or set the default connection. */
      canManage: () => connections()?.can_manage ?? false,
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
      /** Stores a question a call returned, e.g. the answered question from an answer. */
      async putQuestion(q: Question) {
        sync.putQuestion(q)
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

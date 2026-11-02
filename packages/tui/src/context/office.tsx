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
import { display } from "../util/printable"
import { createFlush } from "./flush"
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
    // One bad update mustn't drop the rest.
    const flush = createFlush<OfficeState>((fns) => batch(() => setState(produce((s) => runEach(fns, s)))), FLUSH_MS)

    const sync = createOfficeSync({
      client,
      cwd: props.cwd,
      state: () => state,
      mutate: flush.mutate,
      // Model output and names are drawn into the terminal, which would act on their control characters.
      clean: display,
      // "online" follows the snapshot it was set after, so readers never see it with stale state.
      onStatus(next, message) {
        flush.later(() =>
          batch(() => {
            setStatus(next)
            setError(message)
          }),
        )
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
      flush.dispose()
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
        await flush.settled()
      },
      /** Re-reads a question into `state`, e.g. after an answer finds it already closed. */
      async refreshQuestion(id: string) {
        await sync.refreshQuestion(id)
        await flush.settled()
      },
      /** Stores a question a call returned, e.g. the answered question from an answer. */
      async putQuestion(q: Question) {
        sync.putQuestion(q)
        await flush.settled()
      },
      /** Re-reads both people lists, e.g. after a hire (there are no person events). */
      async refreshPeople() {
        await sync.refreshPeople()
        await flush.settled()
      },
      /** Calls `fn` for each event of `type` once it is visible in `state`; returns an unsubscribe. */
      on<K extends keyof OfficeEvents>(type: K, fn: (e: OfficeEvents[K]) => void) {
        return sync.on(type, (e) => flush.later(() => fn(e)))
      },
    }
  },
})

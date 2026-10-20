// The office as the app sees it: one client for HQ's /api, who is signed in, and the live state createOfficeSync
// keeps with HQ's snapshot. Follows the TUI's office context (packages/tui/src/context/office.tsx).
import {
  applyCompany,
  createOfficeClient,
  createOfficeSync,
  emptyState,
  pauseWhenHidden,
  runEach,
  UnknownDevice,
  type OfficeState,
  type OfficeStatus,
} from "@opencorp/client"
import { useNavigate } from "@solidjs/router"
import { batch, createContext, createSignal, onCleanup, onMount, useContext, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { hqSnapshot } from "./snapshot"
import { since, type CostWindow } from "./window"

/** Live updates are applied in one batch per frame, as in the TUI. */
const FLUSH_MS = 16

/** The cost window the person last picked, kept in localStorage. */
function savedWindow(): CostWindow {
  const w = localStorage.getItem("hq.window")
  return w === "7d" || w === "30d" ? w : "today"
}

function createOffice(toSignIn: () => void) {
  const client = createOfficeClient({ baseUrl: "/api" })
  const [state, setState] = createStore<OfficeState>(emptyState())
  const [status, setStatus] = createSignal<OfficeStatus>("connecting")
  /** Whether the first snapshot is in `state`. */
  const [ready, setReady] = createSignal(false)
  const [me, setMe] = createSignal<string>()
  const [costWindow, setCostWindowSignal] = createSignal<CostWindow>(savedWindow())
  let queue: ((s: OfficeState) => void)[] = []
  let after: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let signedOut = false
  let stopPausing: (() => void) | undefined

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
  const mutate = (fn: (s: OfficeState) => void) => {
    queue.push(fn)
    timer ??= setTimeout(flush, FLUSH_MS)
  }
  /** Runs `fn` once the queued changes are in `state`: "online" never shows next to the old snapshot. */
  const whenFlushed = (fn: () => void) => void (timer ? after.push(fn) : fn())

  const sync = createOfficeSync({
    client,
    state: () => state,
    mutate,
    snapshot: hqSnapshot(() => since(costWindow())),
    onStatus: (next) => whenFlushed(() => onStatus(next)),
  })

  function onStatus(next: OfficeStatus) {
    setStatus(next)
    if (next === "online") setReady(true)
    // The stream's 401 shows as "error": ask who this browser is, and go to sign-in if the session is gone.
    else if (next === "error") void checkSignedIn()
  }

  function signOut() {
    if (signedOut) return
    signedOut = true
    sync.stop()
    toSignIn()
  }

  /** Reads who this browser is; a 401 (no session, expired, revoked, a password change, offboarded) is sign-in. */
  async function checkSignedIn() {
    try {
      setMe((await client.whoami()).person)
      return true
    } catch (e) {
      if (e instanceof UnknownDevice) signOut() // the client maps every 401 to UnknownDevice
      return false
    }
  }

  sync.on("company.updated", () => {
    client.company.get().then(
      (view) => mutate((s) => applyCompany(s, view)),
      (error) => console.error("Failed to read the company", { error }),
    )
  })

  onMount(async () => {
    if (!(await checkSignedIn())) return
    sync.start()
    // A hidden tab lets go of its stream after a minute and takes a fresh snapshot when shown again.
    stopPausing = pauseWhenHidden({ start: () => void (signedOut || sync.start()), stop: sync.stop }, document)
  })
  onCleanup(() => {
    sync.stop()
    stopPausing?.()
    clearTimeout(timer)
  })

  /** Who paired this browser, when it wasn't the signed-in person; the pair page keeps it. */
  const pairedBy = () => {
    try {
      const by = JSON.parse(localStorage.getItem("hq.session") ?? "null")?.issued_by
      return typeof by === "string" && by !== me() ? by : undefined
    } catch {
      return undefined
    }
  }

  return { client, state: state as Readonly<OfficeState>, status, ready, me, pairedBy, costWindow }
}

export type Office = ReturnType<typeof createOffice>
const OfficeContext = createContext<Office>()

/** Gives the shell and the pages the office; rendered inside the router, so it can send a browser to sign-in. */
export function OfficeProvider(props: ParentProps) {
  const navigate = useNavigate()
  const office = createOffice(() => navigate("/sign-in", { replace: true }))
  return <OfficeContext.Provider value={office}>{props.children}</OfficeContext.Provider>
}

/** The office, inside an OfficeProvider. */
export function useOffice() {
  const office = useContext(OfficeContext)
  if (!office) throw new Error("useOffice needs an OfficeProvider")
  return office
}

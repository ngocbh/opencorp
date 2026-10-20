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
import { throttle } from "./costs"
import { hqSnapshot } from "./snapshot"
import { RELOADED_FOR, verdict } from "./version"
import { since, type CostWindow } from "./window"

/** Live updates are applied in one batch per frame, as in the TUI. */
const FLUSH_MS = 16

/** Costs are read again on session.updated at most this often (the design's 10 s). */
const COST_EVERY_MS = 10_000

/** The cost window the person last picked, kept in localStorage. */
function savedWindow(): CostWindow {
  const w = localStorage.getItem("hq.window")
  return w === "7d" || w === "30d" ? w : "today"
}

/**
 * The office for this tab: the client, the live state and its connection status, who is signed in, the version check
 * and the cost window. `toSignIn` sends the browser to sign-in once its session is gone.
 */
function createOffice(toSignIn: () => void) {
  const client = createOfficeClient({ baseUrl: "/api" })
  const [state, setState] = createStore<OfficeState>(emptyState())
  const [status, setStatus] = createSignal<OfficeStatus>("connecting")
  /** Whether the first snapshot is in `state`. */
  const [ready, setReady] = createSignal(false)
  const [me, setMe] = createSignal<string>()
  const [costWindow, setCostWindowSignal] = createSignal<CostWindow>(savedWindow())
  /** Set when the built app can't run against this office: the shell shows a full page instead. */
  const [blocked, setBlocked] = createSignal<"out_of_date" | "not_built">()
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

  const costs = throttle(() => void readCosts(), COST_EVERY_MS)
  const snapshot = hqSnapshot(() => since(costWindow()))
  const sync = createOfficeSync({
    client,
    state: () => state,
    mutate,
    // Every snapshot reads the costs too, so the refetch window starts then.
    snapshot: async (c) => (costs.ran(), snapshot(c)),
    onStatus: (next) => whenFlushed(() => onStatus(next)),
  })

  function onStatus(next: OfficeStatus) {
    setStatus(next)
    if (next === "online") {
      setReady(true)
      void checkVersion()
    }
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

  /** Reads /api/health and acts on the verdict: reload once for a new build, or block on a mismatch. */
  async function checkVersion() {
    let health
    try {
      health = await client.health()
    } catch {
      return // the reconnect after this tries again
    }
    if (!("office" in health)) return // only the socket's /health lacks the keys
    const reloadedFor = sessionStorage.getItem(RELOADED_FOR)
    const v = verdict(health, __HQ_BUILD__, { dev: import.meta.env.DEV, reloadedFor })
    if (v === "reload") {
      sessionStorage.setItem(RELOADED_FOR, health.app!.build)
      return location.reload()
    }
    setBlocked(v === "ok" ? undefined : v)
  }

  let costReads = 0
  /** Reads the costs for the window; only the latest read's answer is kept. */
  async function readCosts() {
    const ask = ++costReads
    try {
      const report = await client.costs.since(since(costWindow()))
      if (ask === costReads) mutate((s) => void (s.costs = report))
    } catch (error) {
      console.error("Failed to read costs", { error })
    }
  }
  /** A new window reads at once, and starts a new 10 s window. */
  function setCostWindow(w: CostWindow) {
    localStorage.setItem("hq.window", w)
    setCostWindowSignal(w)
    costs.ran()
    void readCosts()
  }
  sync.on("session.updated", () => costs.call())

  sync.on("company.updated", () => {
    client.company.get().then(
      (view) => mutate((s) => applyCompany(s, view)),
      (error) => console.error("Failed to read the company", { error }),
    )
  })

  // Vite reports a dynamic import that failed (a rebuild deleted the chunk). No preventDefault: the error must still
  // reach the shell's ErrorBoundary, or lazy() would render nothing.
  const onPreloadError = () => void checkVersion()
  window.addEventListener("vite:preloadError", onPreloadError)

  onMount(async () => {
    if (!(await checkSignedIn())) return
    sync.start()
    // A hidden tab lets go of its stream after a minute and takes a fresh snapshot when shown again.
    stopPausing = pauseWhenHidden({ start: () => void (signedOut || sync.start()), stop: sync.stop }, document)
  })
  onCleanup(() => {
    window.removeEventListener("vite:preloadError", onPreloadError)
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

  return {
    client,
    state: state as Readonly<OfficeState>,
    status,
    ready,
    me,
    pairedBy,
    costWindow,
    setCostWindow,
    blocked,
    checkVersion,
  }
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

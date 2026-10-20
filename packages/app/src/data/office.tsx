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

/** How often the not-built page asks again whether the app has been built. */
const NOT_BUILT_RECHECK_MS = 3_000

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
  // Set on unmount: a whoami or a read still in flight then must not start or change anything.
  let disposed = false
  let stopPausing: (() => void) | undefined
  let recheck: ReturnType<typeof setTimeout> | undefined

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
    if (disposed) return
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
    // Every snapshot reads the costs too, so the refetch window starts then. The version check runs beside it, on
    // every connect: an office this bundle can't read must still get "out of date", not a snapshot that never comes.
    snapshot: async (c) => (costs.ran(), void checkVersion(), snapshot(c)),
    onStatus: (next) => whenFlushed(() => onStatus(next)),
  })

  function onStatus(next: OfficeStatus) {
    setStatus(next)
    if (next === "online") {
      setReady(true)
      // The first whoami may have failed while the office was down: fill in who is signed in now.
      if (!me()) void checkSignedIn()
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
    } catch (e) {
      if (e instanceof UnknownDevice) signOut() // the client maps every 401 to UnknownDevice
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
    // Nothing else would notice the build landing: the stream may be up and quiet.
    clearTimeout(recheck)
    if (v === "not_built" && !disposed) recheck = setTimeout(() => void checkVersion(), NOT_BUILT_RECHECK_MS)
  }

  let costReads = 0
  /** Reads the costs for the window; only the latest read's answer is kept. */
  async function readCosts() {
    if (disposed) return
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

  let companyReads = 0
  /** Reads the company at a new commit; only the latest read's answer is kept. */
  sync.on("company.updated", (e) => {
    if (e.data.sha && e.data.sha === state.sha) return // the commit the state already holds
    const ask = ++companyReads
    client.company.get().then(
      (view) => void (ask === companyReads && mutate((s) => applyCompany(s, view))),
      (error) => console.error("Failed to read the company", { error }),
    )
  })

  // Vite reports a dynamic import that failed (a rebuild deleted the chunk). No preventDefault: the error must still
  // reach the shell's ErrorBoundary, or lazy() would render nothing.
  const onPreloadError = () => void checkVersion()
  window.addEventListener("vite:preloadError", onPreloadError)

  onMount(async () => {
    // Only a 401 signs out; any other failure (the office restarting, say) leaves the stream's backoff to retry, and a
    // later 401 on the stream reaches checkSignedIn through "error".
    await checkSignedIn()
    if (signedOut || disposed) return
    sync.start()
    // A hidden tab lets go of its stream after a minute and takes a fresh snapshot when shown again.
    stopPausing = pauseWhenHidden({ start: () => void (signedOut || sync.start()), stop: sync.stop }, document)
  })
  onCleanup(() => {
    disposed = true
    clearTimeout(recheck)
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

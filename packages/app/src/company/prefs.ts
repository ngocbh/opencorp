import { createSignal } from "solid-js"
import { readStored, store } from "../data/storage"

export type View = "chart" | "list"
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

/** localStorage, through the helpers that survive a browser refusing it. */
const local: Storage = {
  getItem: (key) => readStored("localStorage", key),
  setItem: (key, value) => void store("localStorage", key, value),
}

/** JSON from `storage` when `ok` accepts it, else `fallback` (missing, unreadable, or not what this app wrote). */
function read<T>(storage: Storage, key: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const raw = storage.getItem(key)
    const value: unknown = raw === null ? fallback : JSON.parse(raw)
    return ok(value) ? value : fallback
  } catch {
    return fallback
  }
}

const isOpenMap = (v: unknown): v is Record<string, boolean> => typeof v === "object" && v !== null && !Array.isArray(v)
const isView = (v: unknown): v is View | null => v === null || v === "chart" || v === "list"

/** Saves `value` as JSON; a browser that refuses storage just forgets it after this tab. */
function save(storage: Storage, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {}
}

/** What this browser remembers about the company view: open branches and the Chart/List choice. */
export function createPrefs(storage: Storage = local) {
  const [open, setOpenMap] = createSignal<Record<string, boolean>>(read(storage, "hq.open", isOpenMap, {}))
  const [view, setViewSignal] = createSignal<View | null>(read(storage, "hq.view", isView, null))
  return {
    /**
     * Whether branch `id` is open: this browser's choice, else open for the CEO and level one, and for a branch
     * that holds someone with a card for the viewer.
     */
    isOpen(id: string, o: { depth: number; holdsNeedsYou: boolean }) {
      return open()[id] ?? (o.depth <= 1 || o.holdsNeedsYou)
    },
    setOpen(id: string, value: boolean) {
      const next = { ...open(), [id]: value }
      setOpenMap(next)
      save(storage, "hq.open", next)
    },
    /** The saved Chart/List choice; null before the first. */
    view,
    setView(v: View) {
      setViewSignal(v)
      save(storage, "hq.view", v)
    },
  }
}

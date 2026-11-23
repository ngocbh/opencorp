import { createStore, type SetStoreFunction } from "solid-js/store"

type Expanded = Record<string, Record<string, boolean> | undefined>

const stores = new WeakMap<object, [Expanded, SetStoreFunction<Expanded>]>()

/**
 * Which groups of each session the owner opened or closed, by session and group id, kept in memory as long as the TUI
 * runs, as upstream's session tabs keep it: the session route remounts on navigation, and a group stays as it was
 * left. One store per renderer, so two TUIs in one process keep their own.
 */
export function groupMemory(renderer: object) {
  let store = stores.get(renderer)
  if (!store) stores.set(renderer, (store = createStore<Expanded>({})))
  const [expanded, setExpanded] = store
  return {
    groupExpanded(sessionID: string, groupID: string) {
      return expanded[sessionID]?.[groupID]
    },
    setGroupExpanded(sessionID: string, groupID: string, value: boolean) {
      setExpanded(sessionID, (current) => ({ ...current, [groupID]: value }))
    },
  }
}

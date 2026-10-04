/** How long a first Ctrl+C waits for the second that leaves a chat or stops the setup. */
export const PRESS_TWICE_MS = 5000

/** Returns a press counter that is true when a press comes within `ms` of an uncounted earlier one. */
export function pressTwice(ms: number, now: () => number = Date.now) {
  let first: number | undefined
  return () => {
    const t = now()
    if (first !== undefined && t - first < ms) {
      first = undefined
      return true
    }
    first = t
    return false
  }
}

/**
 * The `app_exit` bindings with each key sent to `app.leave`, which takes a second press
 * everywhere but home. A `<leader>` chord is already deliberate, so it keeps `app.exit` and leaves at once.
 */
export function leaveBindings<B extends { key: unknown; cmd?: unknown }>(bindings: readonly B[]): B[] {
  return bindings.flatMap((b) => {
    if (typeof b.key !== "string") return [{ ...b, cmd: "app.leave" }]
    return b.key.split(",").map((key) => {
      const k = key.trim()
      return { ...b, key: k, cmd: k.startsWith("<leader>") ? "app.exit" : "app.leave" }
    })
  })
}

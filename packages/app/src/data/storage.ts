// Web storage that a browser may refuse (blocked site data, a full quota): HQ works without it, just forgetting more.

type Area = "localStorage" | "sessionStorage"

/** The value at `key`, or null when it's missing or the browser refuses storage. */
export function readStored(area: Area, key: string): string | null {
  try {
    return window[area].getItem(key)
  } catch {
    return null
  }
}

/** Stores `value` at `key`; false when the browser refuses. */
export function store(area: Area, key: string, value: string): boolean {
  try {
    window[area].setItem(key, value)
    return true
  } catch {
    return false
  }
}

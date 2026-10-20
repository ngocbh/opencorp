// Hidden tabs let go of their event stream and reconnect when shown again: it keeps a browser under HTTP/1.1's six
// connections per origin, and HQ under its connection cap.

type Page = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">

/**
 * Stops `sync` once the page has been hidden for `ms`, and starts it (a fresh snapshot) when it's shown again.
 * Returns a function that stops watching.
 */
export function pauseWhenHidden(sync: { start(): void; stop(): void }, page: Page, ms = 60_000) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let paused = false
  const changed = () => {
    clearTimeout(timer)
    if (page.hidden) {
      timer = setTimeout(() => {
        paused = true
        sync.stop()
      }, ms)
    } else if (paused) {
      paused = false
      sync.start()
    }
  }
  page.addEventListener("visibilitychange", changed)
  changed() // a tab opened in the background is hidden from the start
  return () => {
    clearTimeout(timer)
    page.removeEventListener("visibilitychange", changed)
  }
}

/**
 * Loads a transcript's older page when the reader reaches its first mounted message, as upstream's history prepend
 * does: one load at a time per transcript, and once its page is laid out, the scroll that asked for it and what waited
 * on it, while that transcript still shows. Returns whether it started or joined a load; false when the transcript
 * holds its first message already.
 */
export function createHistoryPrepend(input: {
  sessionID: () => string
  more: (sessionID: string) => boolean
  loadMore: (sessionID: string) => Promise<void>
  afterLayout: (continuation: () => void) => void
  active: (sessionID: string) => boolean
  scrollBy: (amount: number) => void
}) {
  // Each transcript's load in flight: the scroll that asked for it and what waits on it, the newest request's.
  const pending = new Map<string, { scrollBy: number; continuation?: () => void }>()

  return (scrollBy = 0, continuation?: () => void) => {
    const sessionID = input.sessionID()
    const joined = pending.get(sessionID)
    if (joined) {
      if (continuation || (!joined.scrollBy && scrollBy)) {
        joined.scrollBy = scrollBy
        joined.continuation = continuation
        return true
      }
      return false
    }
    if (!input.more(sessionID)) return false
    const current: { scrollBy: number; continuation?: () => void } = { scrollBy, continuation }
    pending.set(sessionID, current)
    const done = () => pending.get(sessionID) === current && pending.delete(sessionID)
    void input.loadMore(sessionID).then(
      () =>
        input.afterLayout(() => {
          if (!done() || !input.active(sessionID)) return
          input.scrollBy(current.scrollBy)
          current.continuation?.()
        }),
      done,
    )
    return true
  }
}

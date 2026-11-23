/**
 * Loads a transcript's older page when the reader reaches its first mounted message, as upstream's history prepend
 * does: one load at a time, and once its page is laid out, the scroll that asked for it and what waited on it.
 * Returns whether it started or joined a load; false when the session holds its first message already.
 */
export function createHistoryPrepend(input: {
  sessionID: () => string
  more: (sessionID: string) => boolean
  loadMore: (sessionID: string) => Promise<void>
  afterLayout: (continuation: () => void) => void
  active: (sessionID: string) => boolean
  scrollBy: (amount: number) => void
}) {
  let pending: { scrollBy: number; continuation?: () => void; after?: () => void } | undefined

  return Object.assign(
    (scrollBy = 0, continuation?: () => void) => {
      const sessionID = input.sessionID()
      if (pending) {
        if (continuation || (!pending.scrollBy && scrollBy)) {
          pending.scrollBy = scrollBy
          pending.continuation = continuation
          return true
        }
        return false
      }
      if (!input.more(sessionID)) return false
      const current = { scrollBy, continuation }
      pending = current
      void input.loadMore(sessionID).then(
        () =>
          input.afterLayout(() => {
            if (pending !== current) return
            const after = pending.after
            pending = undefined
            if (!input.active(sessionID)) return
            input.scrollBy(current.scrollBy)
            current.continuation?.()
            after?.()
          }),
        () => {
          if (pending !== current) return
          const after = pending.after
          pending = undefined
          if (input.active(sessionID)) after?.()
        },
      )
      return true
    },
    {
      /** Drops what waits on the load in flight; its page still goes in. */
      cancel() {
        if (!pending) return
        pending.continuation = undefined
        pending.after = undefined
      },
      /** Runs `continuation` once the load in flight is laid out, or now when none is. */
      after(continuation: () => void) {
        if (!pending) return continuation()
        // A jump supersedes deferred scrolling, but must wait until the prepended page is laid out.
        pending.scrollBy = 0
        pending.after = continuation
      },
    },
  )
}

import type { PromptInfo } from "../../prompt/history"

/** An unsent prompt, and where its cursor was. */
export type DraftEntry = { prompt: PromptInfo; cursor: number }

/**
 * Holds one in-progress draft per session across Prompt remounts, home's under `undefined`. A draft is consumed on
 * take: restoring it moves it out of the stash, so a stale copy never shadows newer input. The upstream TUI keeps one
 * stash for its process; ours is one per TUI, in its prompt context.
 */
export function createDraftStash() {
  const bySession = new Map<string | undefined, DraftEntry>()
  return {
    takeDraft(sessionID: string | undefined) {
      const entry = bySession.get(sessionID)
      bySession.delete(sessionID)
      return entry
    },
    saveDraft(sessionID: string | undefined, entry: DraftEntry) {
      bySession.set(sessionID, entry)
    },
  }
}

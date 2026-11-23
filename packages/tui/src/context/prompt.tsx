import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"
import { createDraftStash } from "../component/prompt/draft-stash"

/** One side's prompt: the app's chat, or the session in the right pane beside it, which shares the chat's `drafts`. */
export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: (props: { drafts?: ReturnType<typeof createDraftStash> }) => {
    let current: PromptRef | undefined
    /** Each session's unsent prompt, home's too, kept while its prompt is unmounted (another view, a card, the
     *  picker). */
    const drafts = props.drafts ?? createDraftStash()

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
      drafts,
      takeDraft: drafts.takeDraft,
      saveDraft: drafts.saveDraft,
    }
  },
})

import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"
import { createDraftStash } from "../component/prompt/draft-stash"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined
    /** Each session's unsent prompt, home's too, kept while its prompt is unmounted (another view, a card, the
     *  picker). */
    const drafts = createDraftStash()

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
      takeDraft: drafts.takeDraft,
      saveDraft: drafts.saveDraft,
    }
  },
})

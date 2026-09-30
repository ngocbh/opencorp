import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"
import type { PromptInfo } from "../prompt/history"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined
    /** The unsent prompt of the last unmounted prompt, restored by the next one (e.g. home to session). */
    let draft: { prompt: PromptInfo; cursor: number } | undefined

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
      /** Returns and clears the saved draft. */
      takeDraft() {
        const saved = draft
        draft = undefined
        return saved
      },
      saveDraft(next: { prompt: PromptInfo; cursor: number }) {
        draft = next
      },
    }
  },
})

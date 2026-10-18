import type { EditorTraits } from "@opentui/core"

export interface PromptTraitsInput {
  autocompleteVisible: boolean
}

export type PromptTraits = EditorTraits & {
  owner: "opencorp"
  role: "prompt"
}

/** The managed textarea keymap owns `suspend`; these traits only describe capture. */
export function computePromptTraits(input: PromptTraitsInput): PromptTraits {
  return {
    capture: input.autocompleteVisible ? ["escape", "navigate", "submit", "tab"] : ["tab"],
    owner: "opencorp",
    role: "prompt",
  }
}

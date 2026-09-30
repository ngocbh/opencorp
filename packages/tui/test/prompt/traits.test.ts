import { describe, expect, test } from "bun:test"
import { computePromptTraits } from "../../src/prompt/traits"

describe("computePromptTraits", () => {
  test("without autocomplete only captures tab", () => {
    const traits = computePromptTraits({ autocompleteVisible: false })
    expect(traits.capture).toEqual(["tab"])
    expect(traits.suspend).toBeUndefined()
    expect(traits.status).toBeUndefined()
  })

  test("with autocomplete captures navigation keys", () => {
    const traits = computePromptTraits({ autocompleteVisible: true })
    expect(traits.capture).toEqual(["escape", "navigate", "submit", "tab"])
    expect(traits.suspend).toBeUndefined()
    expect(traits.status).toBeUndefined()
  })
})

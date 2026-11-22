import path from "path"
import { onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"

/** Where a part's placeholder sits in the prompt input. */
export type PromptSpan = { start: number; end: number; value: string }

/** A file mentioned with `@`; it is sent as the `@path` text itself. */
export type PromptFilePart = {
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: { type: "file"; path: string; text: PromptSpan }
}

/** Pasted text shown in the input as a summary (`source.text.value`) and sent expanded. */
export type PromptTextPart = { type: "text"; text: string; source?: { text: PromptSpan } }

/** What the prompt holds: its input and the parts behind its placeholders. */
export type PromptInfo = {
  input: string
  parts: (PromptFilePart | PromptTextPart)[]
}

export const MAX_HISTORY_ENTRIES = 50

/** Reads history JSONL: one sent text per line (older lines hold an object with `input`). */
export function parsePromptHistory(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line)
        if (typeof value === "string") return value
        if (value && typeof value === "object" && "input" in value && typeof value.input === "string")
          return value.input
      } catch {}
      return undefined
    })
    .filter((line): line is string => line !== undefined)
    .slice(-MAX_HISTORY_ENTRIES)
}

export function isDuplicateEntry(previous: string | undefined, next: string): boolean {
  return previous === next
}

export const emptyPrompt = (): PromptInfo => ({ input: "", parts: [] })

const { use: useHistoryEntries, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    const write = () =>
      writeText(historyPath, store.history.map((line) => JSON.stringify(line)).join("\n") + "\n").catch(() => {})
    onMount(async () => {
      const lines = parsePromptHistory(await readText(historyPath).catch(() => ""))
      setStore("history", lines)

      // Rewrite valid retained entries to self-heal corruption and enforce the limit.
      if (lines.length > 0) write()
    })

    const [store, setStore] = createStore({ history: [] as string[] })

    return {
      get entries() {
        return store.history
      },
      append(text: string) {
        if (isDuplicateEntry(store.history.at(-1), text)) return
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(text)
            if (draft.history.length > MAX_HISTORY_ENTRIES) {
              draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
              trimmed = true
            }
          }),
        )

        if (trimmed) return void write()
        appendText(historyPath, JSON.stringify(text) + "\n").catch(() => {})
      },
    }
  },
})

export { PromptHistoryProvider }

/**
 * One prompt's walk through the sent texts, the upstream TUI's: ↑ from what is being typed keeps it as the draft and
 * shows the newest text, and ↓ back past the newest restores the draft. `move` returns what to show, or undefined past
 * either end, or when the text shown was edited.
 */
export function usePromptHistory(currentDraft = emptyPrompt) {
  const history = useHistoryEntries()
  let index = 0
  let draft: PromptInfo | undefined
  function reset() {
    index = 0
    draft = undefined
  }
  return {
    move(direction: 1 | -1, input: string): PromptInfo | undefined {
      const next = index + direction
      if (next < -history.entries.length || next > 0) return
      if (index < 0 && input && history.entries.at(index) !== input) return
      if (index === 0) draft = structuredClone({ ...currentDraft(), input })
      index = next
      if (next !== 0) {
        const entry = history.entries.at(next)
        return entry === undefined ? undefined : { ...emptyPrompt(), input: entry }
      }
      const restored = draft
      draft = undefined
      return restored
    },
    reset,
    append(text: string) {
      reset()
      history.append(text)
    },
  }
}

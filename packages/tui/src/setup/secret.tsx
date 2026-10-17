import type { ColorInput } from "@opentui/core"
import { useKeyboard, usePaste } from "@opentui/solid"
import { createSignal } from "solid-js"
import { useTuiConfig } from "../config"
import { clearFirst, useBindings } from "../keymap"

// Control characters: Tab, Ctrl-J and escape sequences are keys, not part of a secret.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * A masked input: a dot for each character typed, or `placeholder` before any; Enter hands the text to `onSubmit`;
 * Ctrl+C or Esc empties it. It reads keys and pastes only while `enabled` (default true), since it listens to the
 * whole app's keyboard rather than to a focused box; `onChange` gets the text after each change.
 */
export function SecretInput(props: {
  placeholder?: string
  fg?: ColorInput
  placeholderFg?: ColorInput
  enabled?: boolean
  onChange?: (value: string) => void
  onSubmit: (value: string) => void
}) {
  // Only this closure and the callbacks hold the text, so it can't leak into a store, the history or a frame; the
  // screen only needs its length.
  let value = ""
  const [length, setLength] = createSignal(0)
  const enabled = () => props.enabled !== false
  const set = (next: string) => {
    value = next
    setLength(next.length)
    props.onChange?.(next)
  }
  const tuiConfig = useTuiConfig()
  useBindings(() => ({
    enabled: enabled(),
    bindings: clearFirst(tuiConfig.keybinds.get("prompt.clear"), () => {
      if (!value) return false
      set("")
      return true
    }),
  }))

  useKeyboard((key) => {
    if (!enabled()) return
    if (key.name === "return" || key.name === "enter") {
      props.onSubmit(value)
      return set("")
    }
    if (key.name === "backspace") return set(value.slice(0, -1))
    if (key.ctrl || key.meta || !key.sequence || key.sequence.search(CONTROL) !== -1) return
    set(value + key.sequence)
  })
  usePaste((event) => {
    if (enabled()) set(value + new TextDecoder().decode(event.bytes).replace(CONTROL, ""))
  })

  return (
    <text fg={length() ? props.fg : props.placeholderFg}>
      {length() ? "•".repeat(length()) : (props.placeholder ?? "")}
    </text>
  )
}

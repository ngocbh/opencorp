import { useKeyboard, usePaste } from "@opentui/solid"
import { createSignal } from "solid-js"
import { plain } from "./child"

/** A masked input: `question: ` then a dot for each character typed; Enter hands the text to `onSubmit`. */
export function SecretInput(props: { question: string; onSubmit: (value: string) => void }) {
  // Only this closure holds the text, so it can't leak into a store, the history or a frame; the screen
  // only needs its length.
  let value = ""
  const [length, setLength] = createSignal(0)
  const set = (next: string) => {
    value = next
    setLength(next.length)
  }

  useKeyboard((key) => {
    if (key.name === "return" || key.name === "enter") {
      props.onSubmit(value)
      return set("")
    }
    if (key.name === "backspace") return set(value.slice(0, -1))
    if (key.ctrl || key.meta || !key.sequence || plain(key.sequence) !== key.sequence) return
    set(value + key.sequence)
  })
  usePaste((event) => set(value + plain(new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, ""))))

  return (
    <text>
      {props.question}: {"•".repeat(length())}
    </text>
  )
}

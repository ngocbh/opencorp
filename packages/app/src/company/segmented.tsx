import { For } from "solid-js"

/** A few exclusive choices as buttons: the WAI-ARIA radio group (one tab stop; arrow keys move the choice). */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  onChange: (v: T) => void
  options: [T, string][]
}) {
  function onKey(e: KeyboardEvent, i: number) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
    if (!step) return
    e.preventDefault()
    const n = props.options.length
    const [next] = props.options[(i + step + n) % n]
    props.onChange(next)
    ;(e.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      class="inline-flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700"
    >
      <For each={props.options}>
        {([value, text], i) => (
          <button
            type="button"
            role="radio"
            data-value={value}
            aria-checked={props.value === value}
            tabindex={props.value === value ? 0 : -1}
            class="px-2 py-1 text-sm aria-checked:bg-neutral-900 aria-checked:text-white dark:aria-checked:bg-neutral-100 dark:aria-checked:text-neutral-900"
            onClick={() => props.onChange(value)}
            onKeyDown={(e) => onKey(e, i())}
          >
            {text}
          </button>
        )}
      </For>
    </div>
  )
}

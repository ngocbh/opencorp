// The Run Logs search box: one text box for qualifiers and run id text, with autocomplete (an ARIA combobox) and a
// subtle highlight on the qualifiers it recognises.
import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js"
import { accept, parse, suggest, type Option, type Sources, type Token } from "./query"

// The box and its highlight layer share these, so the highlights sit exactly under the text. 16px on a phone, so iOS
// doesn't zoom in on focus.
const TEXT = "px-2 py-1 text-base md:text-sm whitespace-pre"
const RING = "focus-within:ring-2 focus-within:ring-neutral-900 dark:focus-within:ring-neutral-100"
const MARK: Record<Token["kind"], string> = {
  qualifier: "rounded-sm bg-sky-100 dark:bg-sky-900/60",
  text: "",
  pending: "",
  ignored: "underline decoration-wavy decoration-amber-600 dark:decoration-amber-400",
}

/**
 * The search box. `query` is the address's query; Enter (with no option chosen) calls `onSearch` with the box's
 * text. `onOpen` is called when the box is first used, so the page can read what it suggests from.
 */
export function SearchBox(props: { query: string; sources: Sources; onSearch: (text: string) => void; onOpen?: () => void }) {
  const id = createUniqueId()
  const [text, setText] = createSignal(props.query)
  const [caret, setCaret] = createSignal(props.query.length)
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(-1)
  const [scroll, setScroll] = createSignal(0)
  let input!: HTMLInputElement
  createEffect(on(() => props.query, (q) => setText(q), { defer: true }))

  const parsed = createMemo(() => parse(text()))
  const suggestions = createMemo(() => (open() ? suggest(text(), caret(), props.sources) : undefined))
  const options = () => suggestions()?.options ?? []
  const expanded = () => options().length > 0
  const optionId = (i: number) => `${id}-option-${i}`

  let used = false
  /** Opens the list (and tells the page the box is in use, the first time). */
  function show() {
    if (!used) {
      used = true
      props.onOpen?.()
    }
    setOpen(true)
  }
  /** Where the caret is now: the token under it decides what's offered. */
  const track = () => setCaret(input.selectionStart ?? text().length)
  const close = () => (setOpen(false), setActive(-1))

  function choose(option: Option) {
    const s = suggestions()
    if (!s) return
    const next = accept(text(), s, option)
    setText(next.text)
    input.value = next.text
    input.setSelectionRange(next.caret, next.caret)
    setCaret(next.caret)
    setActive(-1)
    // A finished filter closes the list; a qualifier's name stays open for its values.
    if (option.complete) setOpen(false)
    input.focus()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return // an input method's own keys (choosing a character with Enter)
    const n = options().length
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!open() || !n) return show()
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1))
    } else if (e.key === "Enter" && expanded() && active() >= 0) {
      e.preventDefault()
      choose(options()[active()]!)
    } else if (e.key === "Tab" && !e.shiftKey && expanded()) {
      e.preventDefault()
      choose(options()[Math.max(active(), 0)]!)
    } else if (e.key === "Escape" && expanded()) {
      e.preventDefault()
      close()
    }
  }

  function submit(e: SubmitEvent) {
    e.preventDefault()
    close()
    props.onSearch(text())
  }

  return (
    <form role="search" onSubmit={submit} class="relative w-full md:w-[28rem]">
      <label for={id} class="sr-only">
        Search runs
      </label>
      <div class={`relative overflow-hidden rounded border border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900 ${RING}`}>
        {/* The highlight layer: the same text, invisible, with the marks behind where the box draws it. */}
        <div aria-hidden="true" data-testid="search-marks" class="pointer-events-none absolute inset-0 overflow-hidden">
          <div class={`${TEXT} text-transparent`} style={{ transform: `translateX(${-scroll()}px)` }}>
            <For each={parsed().tokens}>
              {(t, i) => (
                <>
                  {text().slice(i() === 0 ? 0 : parsed().tokens[i() - 1]!.end, t.start)}
                  <span data-kind={t.kind} class={MARK[t.kind]}>
                    {t.text}
                  </span>
                </>
              )}
            </For>
          </div>
        </div>
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded()}
          aria-controls={`${id}-list`}
          aria-activedescendant={expanded() && active() >= 0 ? optionId(active()) : undefined}
          aria-describedby={`${id}-help`}
          enterkeyhint="search"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          placeholder="flow:chat @kai is:open started:7d, or a run id"
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value)
            track()
            setActive(-1)
            show()
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" ? track() : undefined}
          onClick={() => (track(), show())}
          onBlur={close}
          onScroll={(e) => setScroll(e.currentTarget.scrollLeft)}
          class={`relative w-full bg-transparent outline-none ${TEXT}`}
        />
      </div>
      <ul
        id={`${id}-list`}
        role="listbox"
        aria-label="Suggestions"
        hidden={!expanded()}
        class="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded border border-neutral-300 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      >
        <For each={options()}>
          {(o, i) => (
            <li
              id={optionId(i())}
              role="option"
              aria-selected={active() === i()}
              // Keeps focus in the box, so a click (or a tap) chooses without closing the list first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
              onMouseMove={() => setActive(i())}
              class="flex cursor-pointer items-baseline gap-2 px-3 py-2 md:py-1.5 aria-selected:bg-neutral-100 dark:aria-selected:bg-neutral-800"
            >
              <span class="font-mono">{o.label}</span>
              <Show when={o.detail}>
                <span class="truncate text-xs text-neutral-500 dark:text-neutral-400">{o.detail}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <p id={`${id}-help`} role="status" class="mt-1 text-xs text-amber-700 dark:text-amber-400">
        {parsed().hints.join(" · ")}
      </p>
    </form>
  )
}

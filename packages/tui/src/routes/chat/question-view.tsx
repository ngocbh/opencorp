import { createStore, produce } from "solid-js/store"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
  type ParentProps,
} from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { KeyEvent, Renderable, TextareaRenderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import { tint, useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { useTuiConfig } from "../../config"
import { useBindings, useAgentCorpModeStack } from "../../keymap"
import type { CardPage, PageAnswer } from "./answer"

export const QUESTION_MODE = "question"

/** A row after the answers that runs something, such as "Chat about this". */
export interface QuestionAction {
  label: string
  key: string
  run: () => void
}

/** A footer hint: a key and what it does. */
export interface QuestionHint {
  key: string
  label: string
}

/** A key binding the view adds to its own, in the keymap's binding shape. */
export type QuestionBinding = Binding<Renderable, KeyEvent>

/** What the view hands its caller: a way to move the cursor. */
export interface QuestionViewHandle {
  select: (row: number) => void
}

/**
 * A question card: a page per question with options to pick (several when `multi`) and, when `typed`, a last row
 * that is a box to type the answer in. Enter on the last page hands every page's answer to `onSubmit` once each
 * single-pick page has one. It takes no office: callers supply the header, actions, extra key bindings, hints and
 * a notice.
 */
export function QuestionView(
  props: ParentProps<{
    pages: CardPage[]
    onSubmit: (answers: PageAnswer[]) => void
    header?: string
    actions?: QuestionAction[]
    /** Keys that work whenever the card's own keys do, even with no pages, such as Esc to stop the asker. */
    bindings?: QuestionBinding[]
    hints?: QuestionHint[]
    /** Replaces the footer, such as a confirmation. */
    notice?: string
    /** Whether its keys work (default true); off while a caller's confirmation has them. */
    enabled?: boolean
    hidden?: boolean
    /** Gets the view's handle once, as it mounts. */
    ref?: (view: QuestionViewHandle) => void
    /** The row the cursor starts on (default 0). */
    selected?: number
    /** At most this many options show at once, around the cursor; every option when unset. */
    maxOptions?: number
    /** Whether the box is one line, which never holds a line break. */
    singleLine?: boolean
    /** The text the first page's box starts with. */
    draft?: string
  }>,
) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const modeStack = useAgentCorpModeStack()

  const [store, setStore] = createStore({
    page: 0,
    selected: props.selected ?? 0,
    answers: (props.draft ? [{ picked: [], text: props.draft }] : []) as PageAnswer[],
  })

  const active = () => props.enabled !== false && !props.hidden
  const page = createMemo(() => props.pages[store.page])
  const answer = createMemo<PageAnswer>(() => store.answers[store.page] ?? { picked: [], text: "" })
  const options = createMemo(() => page()?.options ?? [])
  const actions = () => props.actions ?? []
  // The caller's actions come after the answer rows and never count as options.
  const answerRows = createMemo(() => options().length + (page()?.typed ? 1 : 0))
  const rows = createMemo(() => answerRows() + actions().length)
  const onTyped = createMemo(() => page()?.typed === true && store.selected === options().length)
  // The first option shown: moved only as far as keeps the cursor in view, so the list doesn't jump. The cursor
  // counts as the last option when it is below them, so the typed row shows the last window.
  let top = 0
  const first = createMemo(() => {
    const max = props.maxOptions
    const count = options().length
    if (!max || count <= max) return (top = 0)
    const cursor = Math.min(store.selected, count - 1)
    return (top = Math.min(Math.max(top, cursor - max + 1), cursor))
  })
  // Numbers and the cursor stay absolute, so a digit picks the same option however far the list has scrolled.
  const shown = createMemo(() => options().slice(first(), props.maxOptions ? first() + props.maxOptions : undefined))
  // A signal, so the effects below see a box that mounts later.
  const [box, setBox] = createSignal<TextareaRenderable>()

  props.ref?.({ select: (row) => setStore("selected", row) })

  function setAnswer(change: (a: PageAnswer) => PageAnswer) {
    setStore(
      produce((s) => {
        s.answers[s.page] = change(s.answers[s.page] ?? { picked: [], text: "" })
      }),
    )
  }

  /** Copies the box's text into this page's answer; its change event comes late, so read it now. */
  function sync() {
    const el = box()
    if (el && !el.isDestroyed && page()?.typed) setAnswer((a) => ({ ...a, text: el.plainText }))
  }

  function goTo(index: number) {
    sync()
    setStore({ page: index, selected: 0 })
  }

  /** Moves to the next page, or hands over every page's answer from the last one. */
  function next() {
    sync()
    const pages = props.pages
    if (store.page < pages.length - 1) return goTo(store.page + 1)
    const missing = pages.findIndex(
      (p, i) => !p.multi && !store.answers[i]?.picked.length && !(p.typed && store.answers[i]?.text.trim()),
    )
    if (missing < 0) return props.onSubmit(pages.map((_, i) => store.answers[i] ?? { picked: [], text: "" }))
    // A page left without an answer: go back to it.
    goTo(missing)
  }

  /** Moves the cursor `by` rows, wrapping around. */
  function move(by: number) {
    const total = rows()
    if (!total) return
    sync()
    setStore("selected", (store.selected + by + total) % total)
  }

  function toggle(index: number) {
    sync()
    setAnswer((a) => {
      const picked = a.picked.includes(index) ? a.picked.filter((n) => n !== index) : [...a.picked, index]
      return { ...a, picked: picked.sort((x, y) => x - y) }
    })
  }

  /** Enter on the selected row: run an action, take the typed answer, confirm a multi-select page, or pick. */
  function selectRow() {
    sync()
    const action = actions()[store.selected - answerRows()]
    if (action) return action.run()
    if (onTyped()) {
      if (page()?.multi) return next()
      // An empty box keeps any pick and stays on the page.
      const text = answer().text
      if (!text.trim()) return
      setAnswer(() => ({ picked: [], text }))
      return next()
    }
    if (page()?.multi) return next()
    if (!options()[store.selected]) return
    // Typed text wins over a pick, so picking clears the box.
    const el = box()
    if (el && !el.isDestroyed) el.setText("")
    setAnswer(() => ({ picked: [store.selected], text: "" }))
    next()
  }

  onMount(() => {
    const popMode = modeStack.push(QUESTION_MODE)
    onCleanup(popMode)
  })

  // Follows the cursor: the box has the keys while the cursor is on it and the view's keys work.
  createEffect(() => {
    const el = box()
    if (!el || el.isDestroyed) return
    if (onTyped() && active()) {
      el.focus()
      el.gotoLineEnd()
      // Only a focused box: an edit buffer's blur always resets the cursor, which would hide the cursor of
      // whatever has focus instead, such as the side chat's prompt.
    } else if (el.focused) el.blur()
  })

  // Comes before the box, so Up, Down and Enter work on the typed row too.
  useBindings(() => {
    const keys = props.bindings ?? []
    const paging =
      props.pages.length > 1 && !onTyped()
        ? [
            { key: "left", desc: "Previous question", group: "Question", cmd: () => goTo(Math.max(store.page - 1, 0)) },
            {
              key: "right",
              desc: "Next question",
              group: "Question",
              cmd: () => goTo(Math.min(store.page + 1, props.pages.length - 1)),
            },
          ]
        : []
    return {
      mode: QUESTION_MODE,
      enabled: active(),
      bindings: !props.pages.length
        ? keys
        : [
            { key: "up", desc: "Previous answer", group: "Question", cmd: () => move(-1) },
            { key: "down", desc: "Next answer", group: "Question", cmd: () => move(1) },
            { key: "return", desc: "Select answer", group: "Question", cmd: () => selectRow() },
            ...paging,
            ...keys,
          ],
    }
  })

  // Off on the typed row, where these keys are text for the box.
  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: active() && props.pages.length > 0 && !onTyped(),
    bindings: [
      ...Array.from({ length: Math.min(answerRows(), 9) }, (_, index) => ({
        key: String(index + 1),
        desc: `Select answer ${index + 1}`,
        group: "Question",
        cmd: () => {
          setStore("selected", index)
          if (index === options().length) return
          if (page()?.multi) return toggle(index)
          selectRow()
        },
      })),
      { key: "k", desc: "Previous answer", group: "Question", cmd: () => move(-1) },
      { key: "j", desc: "Next answer", group: "Question", cmd: () => move(1) },
      {
        key: "space",
        desc: "Toggle answer",
        group: "Question",
        cmd: () => {
          if (page()?.multi && store.selected < options().length) toggle(store.selected)
        },
      },
    ],
  }))

  const marker = (i: number) => {
    if (!page()?.multi) return `${i + 1}.`
    return answer().picked.includes(i) ? `${i + 1}. [x]` : `${i + 1}. [ ]`
  }

  return (
    <box
      visible={!props.hidden}
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <Show when={props.header}>
          <box paddingLeft={1}>
            <text fg={theme.textMuted}>{props.header}</text>
          </box>
        </Show>
        {props.children}
        <Show when={props.pages.length > 0}>
          <box paddingLeft={1} gap={1}>
            <box>
              <Show when={props.pages.length > 1}>
                <text fg={theme.textMuted}>
                  {`Question ${store.page + 1} of ${props.pages.length} · ${page()?.header}`}
                </text>
              </Show>
              <text fg={theme.text}>{page()?.question}</text>
            </box>
            <box>
              <For each={shown()}>
                {(opt, at) => {
                  const i = () => first() + at()
                  const active = () => i() === store.selected
                  return (
                    <box
                      onMouseOver={() => setStore("selected", i())}
                      onMouseDown={() => setStore("selected", i())}
                      onMouseUp={() => {
                        if (renderer.getSelection()?.getSelectedText()) return
                        if (page()?.multi) return toggle(i())
                        selectRow()
                      }}
                    >
                      <box flexDirection="row">
                        <box backgroundColor={active() ? theme.backgroundElement : undefined} paddingRight={1}>
                          <text fg={active() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                            {marker(i())}
                          </text>
                        </box>
                        <box backgroundColor={active() ? theme.backgroundElement : undefined} flexShrink={1}>
                          <text fg={active() ? theme.secondary : theme.text} wrapMode="word">
                            {opt.label}
                          </text>
                        </box>
                      </box>

                      <Show when={opt.description}>
                        <box paddingLeft={3}>
                          <text fg={theme.textMuted}>{opt.description}</text>
                        </box>
                      </Show>
                    </box>
                  )
                }}
              </For>
              <Show when={page()?.typed ? store.page + 1 : undefined} keyed>
                {(_) => {
                  // Taking an argument makes Show key and untrack this child; untrack keeps the read out of any
                  // tracking anyway. Read once, as this page's box mounts; the box holds the text from then on.
                  const start = untrack(() => answer().text)
                  let mounted: TextareaRenderable | undefined
                  onCleanup(() => box() === mounted && setBox(undefined))
                  const ref = (el: TextareaRenderable) => {
                    el.traits = { status: "ANSWER" }
                    mounted = el
                    setBox(el)
                  }
                  return (
                    <box flexDirection="row" onMouseDown={() => setStore("selected", options().length)}>
                      <box backgroundColor={onTyped() ? theme.backgroundElement : undefined} paddingRight={1}>
                        <text fg={onTyped() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                          {`${options().length + 1}.`}
                        </text>
                      </box>
                      {props.singleLine ? (
                        // An input drops line breaks typed or pasted; Enter reaches the view's keys first.
                        <input
                          flexGrow={1}
                          ref={ref}
                          value={start}
                          placeholder="Type your answer here"
                          placeholderColor={theme.textMuted}
                          textColor={theme.text}
                          focusedTextColor={theme.text}
                          cursorColor={theme.primary}
                          cursorStyle={tuiConfig.cursor}
                        />
                      ) : (
                        <textarea
                          flexGrow={1}
                          ref={ref}
                          initialValue={start}
                          placeholder="Type your answer here"
                          placeholderColor={theme.textMuted}
                          minHeight={1}
                          maxHeight={6}
                          textColor={theme.text}
                          focusedTextColor={theme.text}
                          cursorColor={theme.primary}
                          cursorStyle={tuiConfig.cursor}
                        />
                      )}
                    </box>
                  )
                }}
              </Show>
              <Show when={actions().length > 0}>
                <box paddingTop={1}>
                  <For each={actions()}>
                    {(action, i) => {
                      const active = () => store.selected === answerRows() + i()
                      return (
                        <box
                          flexDirection="row"
                          gap={1}
                          onMouseOver={() => setStore("selected", answerRows() + i())}
                          onMouseUp={() => action.run()}
                        >
                          <box backgroundColor={active() ? theme.backgroundElement : undefined}>
                            <text fg={active() ? theme.secondary : theme.text}>{`[${action.label}]`}</text>
                          </box>
                          <text fg={theme.textMuted}>{action.key}</text>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </Show>
            </box>
          </box>
        </Show>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        justifyContent="space-between"
      >
        <Show when={props.notice}>
          <text fg={theme.warning}>{props.notice}</text>
        </Show>
        <box flexDirection="row" gap={2} visible={!props.notice}>
          <Show when={props.pages.length > 0}>
            <text fg={theme.text}>
              {"↑↓"} <span style={{ fg: theme.textMuted }}>select</span>
            </text>
            <Show when={page()?.multi}>
              <text fg={theme.text}>
                space <span style={{ fg: theme.textMuted }}>toggle</span>
              </text>
            </Show>
            <Show when={props.pages.length > 1}>
              <text fg={theme.text}>
                {"←→"} <span style={{ fg: theme.textMuted }}>question</span>
              </text>
            </Show>
            <text fg={theme.text}>
              enter{" "}
              <span style={{ fg: theme.textMuted }}>{store.page < props.pages.length - 1 ? "next" : "submit"}</span>
            </text>
          </Show>
          <For each={props.hints ?? []}>
            {(hint) => (
              <text fg={theme.text}>
                {hint.key} <span style={{ fg: theme.textMuted }}>{hint.label}</span>
              </text>
            )}
          </For>
        </box>
      </box>
    </box>
  )
}

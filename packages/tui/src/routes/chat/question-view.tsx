import { createStore, produce } from "solid-js/store"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  type ParentProps,
} from "solid-js"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { BoxRenderable, KeyEvent, Renderable, TextareaRenderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import { tint, useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { useTuiConfig } from "../../config"
import { clearFirst, useBindings, useOpenCorpModeStack } from "../../keymap"
import { SecretInput } from "../../ui/secret-input"
import { useInteractivity } from "../../context/interactivity"
import { useDialog } from "../../ui/dialog"
import { createReadThrough, wrap } from "../../ui/read-through"
import type { CardPage, PageAnswer } from "./answer"
import { display } from "../../util/printable"

export const QUESTION_MODE = "question"

/** Shown in place of the answers until the question has been on screen whole. */
const READ_ON = "Read to the end (PageDown, Space, arrows) to see the answers"

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
 * that is a box to type the answer in (showing only dots on a `secret` page). A question taller than the screen
 * leaves scrolls, and its answers show only once all of it has been on screen (a file to save, say, is read whole
 * before it is answered). Enter on the last page hands every
 * page's answer to `onSubmit` once each single-pick page has one. Ctrl+C or Esc in the box with text clears it. It
 * takes no office: callers supply the header, actions, extra key bindings, hints and a notice.
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
    /** Called as it goes while it has the keys and a page holds typed text: its caller says whether that leaves the
     *  owner mid-line, as when its card closed unanswered. */
    onGoneTyping?: () => void
  }>,
) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpenCorpModeStack()

  const [store, setStore] = createStore({
    page: 0,
    selected: 0,
    answers: [] as PageAnswer[],
  })

  // Off while its side lacks the keys too: a card in a pane the chat has the keys beside reads none of them.
  const interactive = useInteractivity()
  const active = () => props.enabled !== false && !props.hidden && interactive()
  const page = createMemo(() => props.pages[store.page])
  const answer = createMemo<PageAnswer>(() => store.answers[store.page] ?? { picked: [], text: "" })
  const options = createMemo(() => page()?.options ?? [])
  const actions = () => props.actions ?? []
  // The caller's actions come after the answer rows and never count as options.
  const answerRows = createMemo(() => options().length + (page()?.typed ? 1 : 0))
  const rows = createMemo(() => answerRows() + actions().length)
  const onTyped = createMemo(() => page()?.typed === true && store.selected === options().length)
  // A signal, so the effects below see a box that mounts later.
  const [box, setBox] = createSignal<TextareaRenderable>()

  // The question's text as rows of the width it is drawn at, and as many as the screen leaves it; wrapped anew when
  // the width changes, which starts the count again.
  const [size, setSize] = createSignal<{ rows: readonly string[]; width: number; height: number }>()
  const textWidth = createMemo(() => Math.max(1, size()?.width ?? dimensions().width))
  const lines = createMemo(() =>
    display(page()?.question ?? "")
      .split("\n")
      .flatMap((line) => wrap(line.replace(/\t/g, "  "), textWidth())),
  )
  const measured = () => {
    const s = size()
    return s?.rows === lines() ? s : undefined
  }
  const view = createMemo(() => Math.min(measured()?.height ?? 0, lines().length))
  const maxTop = createMemo(() => Math.max(0, lines().length - view()))
  // The scroll position, for the rows it was set on; at the end it stays there when the answers take rows from it.
  const [scroll, setScroll] = createSignal<{ rows?: readonly string[]; top: number; end?: boolean }>({ top: 0 })
  const textTop = () => {
    const s = scroll()
    if (s.rows !== lines()) return 0
    return s.end ? maxTop() : Math.min(s.top, maxTop())
  }
  const scrollTo = (t: number) => {
    const top = Math.max(0, Math.min(maxTop(), t))
    setScroll({ rows: lines(), top, end: top === maxTop() })
  }
  const read = createReadThrough({ rows: lines, top: textTop, view, ready: () => measured() !== undefined })
  const scrolls = createMemo(() => measured() !== undefined && view() < lines().length)
  const visibleLines = createMemo(() => lines().slice(textTop(), textTop() + (measured() ? view() : lines().length)))
  const scrollPage = () => Math.max(1, view() - 1)
  const scrollKeys = (always: boolean) =>
    (
      [
        ["pageup", () => scrollTo(textTop() - scrollPage())],
        ["pagedown", () => scrollTo(textTop() + scrollPage())],
        ["home", () => scrollTo(0)],
        ["end", () => scrollTo(maxTop())],
        ...(always
          ? []
          : ([
              ["space", () => scrollTo(textTop() + scrollPage())],
              ["up", () => scrollTo(textTop() - 1)],
              ["down", () => scrollTo(textTop() + 1)],
            ] as const)),
      ] as const
    ).map(([key, run]) => ({ key, desc: "Scroll the question", group: "Question", cmd: () => void run() }))

  props.ref?.({ select: (row) => setStore("selected", row) })

  function setAnswer(change: (a: PageAnswer) => PageAnswer) {
    setStore(
      produce((s) => {
        s.answers[s.page] = change(s.answers[s.page] ?? { picked: [], text: "" })
      }),
    )
  }

  /** Whether a page holds text the owner typed: the box's, whose change event comes late, or a page's answer. */
  function typedText() {
    const el = box()
    return (!!el && !el.isDestroyed && el.plainText !== "") || store.answers.some((a) => !!a?.text)
  }
  onCleanup(() => {
    if (active() && typedText()) props.onGoneTyping?.()
  })

  /** Copies the box's text into this page's answer; its change event comes late, so read it now. */
  function sync() {
    const el = box()
    if (el && !el.isDestroyed && page()?.typed) setAnswer((a) => ({ ...a, text: el.plainText }))
  }

  /** Empties the box while the cursor is on it; false when the cursor is elsewhere or the box is empty. */
  function clearBox() {
    const el = box()
    if (!onTyped() || !el || el.isDestroyed || !el.plainText) return false
    el.setText("")
    sync()
    return true
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

  // Its mode is the keymap's while its side has the keys, as the picker's is, and while it shows with no dialog over
  // it: the stack is the whole app's, and a mode pushed later lands on top. So a card shown in both the chat and the
  // pane leaves the other side's base keys (a prompt's Esc) alone, a side chat's mode stays on top when the keys come
  // back, and a dialog's mode stays on top while the dialog shows. Not `enabled`: a card's own confirm keys, shown
  // while it isn't, are in this mode.
  const dialog = useDialog()
  createEffect(() => {
    if (!interactive() || props.hidden || dialog.stack.length > 0) return
    const popMode = modeStack.push(QUESTION_MODE)
    onCleanup(popMode)
  })

  // Follows the cursor: the box has the keys while the cursor is on it and the view's keys work.
  createEffect(() => {
    const el = box()
    if (!el || el.isDestroyed) return
    if (onTyped() && active() && read()) {
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
        : !read()
          ? [...scrollKeys(false), ...paging, ...keys]
          : [
              ...(scrolls() ? scrollKeys(true) : []),
              { key: "up", desc: "Previous answer", group: "Question", cmd: () => move(-1) },
              { key: "down", desc: "Next answer", group: "Question", cmd: () => move(1) },
              { key: "return", desc: "Select answer", group: "Question", cmd: () => selectRow() },
              ...paging,
              // Before the caller's keys: in a box with text, Ctrl+C and Esc only clear it. On an empty box they go
              // on to the caller's keys, such as the card's stop and leave.
              ...clearFirst(tuiConfig.keybinds.get("prompt.clear"), clearBox),
              ...keys,
            ],
    }
  })

  // Off on the typed row, where these keys are text for the box, and until the question has been read.
  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: active() && props.pages.length > 0 && !onTyped() && read(),
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
      flexShrink={1}
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexShrink={1}>
        <Show when={props.header}>
          <box paddingLeft={1} flexShrink={0}>
            <text fg={theme.textMuted}>{display(props.header ?? "")}</text>
          </box>
        </Show>
        {props.children}
        <Show when={props.pages.length > 0}>
          <box paddingLeft={1} gap={1} flexShrink={1}>
            <box flexShrink={1}>
              <Show when={props.pages.length > 1}>
                <text fg={theme.textMuted}>
                  {`Question ${store.page + 1} of ${props.pages.length} · ${display(page()?.header ?? "")}`}
                </text>
              </Show>
              {/* As tall as its rows, shrunk to what the screen leaves: a basis, since a set height stops it shrinking. */}
              <box flexBasis={lines().length} minHeight={1} flexShrink={1}>
                <Show when={lines()} keyed>
                  {(wrapped) => {
                    let el: BoxRenderable | undefined
                    // Only the live viewport of the current rows counts, and only its rows inside the screen.
                    const measure = () => {
                      if (!el || el.isDestroyed || props.hidden || wrapped !== lines()) return
                      if (!Number.isFinite(el.width) || !Number.isFinite(el.height)) return
                      const height = Math.max(0, Math.min(el.height, dimensions().height - el.y))
                      setSize({ rows: wrapped, width: el.width, height })
                    }
                    return (
                      <box ref={(r: BoxRenderable) => (el = r)} flexGrow={1} overflow="hidden" onSizeChange={measure}>
                        <For each={visibleLines()}>
                          {(row) => (
                            <text fg={theme.text} wrapMode="none">
                              {row === "" ? " " : row}
                            </text>
                          )}
                        </For>
                      </box>
                    )
                  }}
                </Show>
              </box>
              <Show when={scrolls()}>
                <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                  {`lines ${Math.min(textTop() + 1, lines().length)}–${Math.min(textTop() + view(), lines().length)} of ${lines().length}`}
                </text>
              </Show>
            </box>
            <Show when={!read()}>
              <text fg={theme.accent} flexShrink={0}>
                {READ_ON}
              </text>
            </Show>
            <box visible={read()} flexShrink={0}>
              <For each={options()}>
                {(opt, i) => {
                  const current = () => i() === store.selected
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
                        <box backgroundColor={current() ? theme.backgroundElement : undefined} paddingRight={1}>
                          <text fg={current() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                            {marker(i())}
                          </text>
                        </box>
                        <box backgroundColor={current() ? theme.backgroundElement : undefined} flexShrink={1}>
                          <text fg={current() ? theme.secondary : theme.text} wrapMode="word">
                            {display(opt.label)}
                          </text>
                        </box>
                      </box>

                      <Show when={opt.description}>
                        <box paddingLeft={3}>
                          <text fg={theme.textMuted}>{display(opt.description ?? "")}</text>
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
                    // No onMouseOver, unlike the options: the cursor on this row focuses the box, so a pointer
                    // passing over it would take the keys from wherever they were.
                    <box flexDirection="row" onMouseDown={() => setStore("selected", options().length)}>
                      <box backgroundColor={onTyped() ? theme.backgroundElement : undefined} paddingRight={1}>
                        <text fg={onTyped() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                          {`${options().length + 1}.`}
                        </text>
                      </box>
                      {page()?.secret ? (
                        // Masked, and only while the cursor is on this row and the view's keys work: SecretInput
                        // reads the whole app's keyboard, not a focused box. The view's Enter submits the answer.
                        <SecretInput
                          placeholder="Type your answer here; it isn't shown"
                          fg={theme.text}
                          placeholderFg={theme.textMuted}
                          enabled={onTyped() && active()}
                          onChange={(text) => setAnswer((a) => ({ ...a, text }))}
                          onSubmit={() => {}}
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
                      const current = () => store.selected === answerRows() + i()
                      return (
                        <box
                          flexDirection="row"
                          gap={1}
                          onMouseOver={() => setStore("selected", answerRows() + i())}
                          onMouseUp={() => action.run()}
                        >
                          <box backgroundColor={current() ? theme.backgroundElement : undefined}>
                            <text fg={current() ? theme.secondary : theme.text}>{`[${action.label}]`}</text>
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
          <text fg={theme.warning}>{display(props.notice ?? "")}</text>
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

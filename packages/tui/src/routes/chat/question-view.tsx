import { createStore, produce } from "solid-js/store"
import { createMemo, For, onCleanup, onMount, Show, type ParentProps } from "solid-js"
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
 * A question card: a page per question with options to pick (several when `multi`) and, when `typed`, a way to
 * type the answer. Enter on the last page hands every page's answer to `onSubmit` once each single-pick page has
 * one. It takes no office: callers supply the header, actions, extra key bindings, hints and a notice.
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
  }>,
) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const modeStack = useAgentCorpModeStack()

  const [store, setStore] = createStore({
    page: 0,
    selected: 0,
    editing: false,
    answers: [] as PageAnswer[],
  })

  const active = () => props.enabled !== false && !props.hidden
  const page = createMemo(() => props.pages[store.page])
  const answer = createMemo<PageAnswer>(() => store.answers[store.page] ?? { picked: [], text: "" })
  const options = createMemo(() => page()?.options ?? [])
  const actions = () => props.actions ?? []
  // The caller's actions come after the answer rows and never count as options.
  const answerRows = createMemo(() => options().length + (page()?.typed ? 1 : 0))
  const rows = createMemo(() => answerRows() + actions().length)
  const other = createMemo(() => page()?.typed === true && store.selected === options().length)

  let textarea: TextareaRenderable | undefined

  props.ref?.({ select: (row) => setStore("selected", row) })

  function setAnswer(change: (a: PageAnswer) => PageAnswer) {
    setStore(
      produce((s) => {
        s.answers[s.page] = change(s.answers[s.page] ?? { picked: [], text: "" })
      }),
    )
  }

  function goTo(index: number) {
    setStore({ page: index, selected: 0, editing: false })
  }

  /** Moves to the next page, or hands over every page's answer from the last one. */
  function next() {
    const pages = props.pages
    if (store.page < pages.length - 1) return goTo(store.page + 1)
    const missing = pages.findIndex(
      (p, i) => !p.multi && !store.answers[i]?.picked.length && !(p.typed && store.answers[i]?.text.trim()),
    )
    if (missing < 0) return props.onSubmit(pages.map((_, i) => store.answers[i] ?? { picked: [], text: "" }))
    // A page left without an answer: go back to it.
    goTo(missing)
  }

  function toggle(index: number) {
    setAnswer((a) => {
      const picked = a.picked.includes(index) ? a.picked.filter((n) => n !== index) : [...a.picked, index]
      return { ...a, picked: picked.sort((x, y) => x - y) }
    })
  }

  /** Enter on the selected row: run an action, open the typed answer, confirm a multi-select page, or pick. */
  function selectRow() {
    const action = actions()[store.selected - answerRows()]
    if (action) return action.run()
    if (other()) return setStore("editing", true)
    if (page()?.multi) return next()
    if (!options()[store.selected]) return
    setAnswer(() => ({ picked: [store.selected], text: "" }))
    next()
  }

  onMount(() => {
    const popMode = modeStack.push(QUESTION_MODE)
    onCleanup(popMode)
  })

  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: store.editing && !props.hidden,
    commands: [
      {
        name: "prompt.clear",
        title: "Clear answer edit",
        category: "Question",
        run() {
          const text = textarea?.plainText ?? ""
          if (!text) {
            setStore("editing", false)
            return
          }
          textarea?.setText("")
        },
      },
    ],
    bindings: [
      {
        key: "escape",
        desc: "Cancel answer edit",
        group: "Question",
        cmd: () => {
          setStore("editing", false)
        },
      },
      ...tuiConfig.keybinds.get("prompt.clear"),
      {
        key: "return",
        desc: "Submit answer edit",
        group: "Question",
        cmd: () => {
          const text = textarea?.plainText?.trim() ?? ""
          const multi = page()?.multi
          // A typed answer replaces the pick on a single-choice page; an empty one leaves it.
          setAnswer((a) => ({ picked: multi || !text ? a.picked : [], text }))
          setStore("editing", false)
          if (text) next()
        },
      },
    ],
  }))

  useBindings(() => {
    const total = rows()
    const move = (by: number) => total && setStore("selected", (store.selected + by + total) % total)
    const keys = props.bindings ?? []
    const paging =
      props.pages.length > 1
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
      enabled: !store.editing && active(),
      bindings: !props.pages.length
        ? keys
        : [
            ...Array.from({ length: Math.min(answerRows(), 9) }, (_, index) => ({
              key: String(index + 1),
              desc: `Select answer ${index + 1}`,
              group: "Question",
              cmd: () => {
                setStore("selected", index)
                if (page()?.multi && index < options().length) return toggle(index)
                selectRow()
              },
            })),
            { key: "up", desc: "Previous answer", group: "Question", cmd: () => move(-1) },
            { key: "k", desc: "Previous answer", group: "Question", cmd: () => move(-1) },
            { key: "down", desc: "Next answer", group: "Question", cmd: () => move(1) },
            { key: "j", desc: "Next answer", group: "Question", cmd: () => move(1) },
            {
              key: "space",
              desc: "Toggle answer",
              group: "Question",
              cmd: () => {
                if (page()?.multi && store.selected < options().length) toggle(store.selected)
              },
            },
            { key: "return", desc: "Select answer", group: "Question", cmd: () => selectRow() },
            ...paging,
            ...keys,
          ],
    }
  })

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
              <For each={options()}>
                {(opt, i) => {
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
                        <box backgroundColor={active() ? theme.backgroundElement : undefined}>
                          <text fg={active() ? theme.secondary : theme.text}>{opt.label}</text>
                        </box>
                      </box>

                      <box paddingLeft={3}>
                        <text fg={theme.textMuted}>{opt.description}</text>
                      </box>
                    </box>
                  )
                }}
              </For>
              <Show when={page()?.typed}>
                <box
                  onMouseOver={() => setStore("selected", options().length)}
                  onMouseDown={() => setStore("selected", options().length)}
                  onMouseUp={() => {
                    if (renderer.getSelection()?.getSelectedText()) return
                    selectRow()
                  }}
                >
                  <box flexDirection="row">
                    <box backgroundColor={other() ? theme.backgroundElement : undefined} paddingRight={1}>
                      <text fg={other() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                        {`${options().length + 1}.`}
                      </text>
                    </box>
                    <box backgroundColor={other() ? theme.backgroundElement : undefined}>
                      <text fg={other() ? theme.secondary : theme.text}>Type your own answer</text>
                    </box>
                  </box>
                  <Show when={store.editing}>
                    <box paddingLeft={3}>
                      <textarea
                        ref={(val: TextareaRenderable) => {
                          textarea = val
                          val.traits = { status: "ANSWER" }
                          queueMicrotask(() => {
                            val.focus()
                            val.gotoLineEnd()
                          })
                        }}
                        initialValue={answer().text}
                        placeholder="Type your own answer"
                        placeholderColor={theme.textMuted}
                        minHeight={1}
                        maxHeight={6}
                        textColor={theme.text}
                        focusedTextColor={theme.text}
                        cursorColor={theme.primary}
                        cursorStyle={tuiConfig.cursor}
                      />
                    </box>
                  </Show>
                  <Show when={!store.editing && answer().text}>
                    <box paddingLeft={3}>
                      <text fg={theme.textMuted}>{answer().text}</text>
                    </box>
                  </Show>
                </box>
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

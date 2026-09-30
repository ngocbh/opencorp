import { createStore } from "solid-js/store"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { tint, useTheme } from "../../context/theme"
import type { AnswerRequest, Question, QuestionPage } from "@agent-corp/protocol"
import { useOffice } from "../../context/office"
import { OfficeError, isNotImplemented } from "../../office/errors"
import { errorMessage } from "../../util/error"
import { useToast } from "../../ui/toast"
import { SplitBorder } from "../../ui/border"
import { useTuiConfig } from "../../config"
import { useBindings, useOpencodeModeStack } from "../../keymap"

const QUESTION_MODE = "question"

/** A question's pages: its `questions`, else one page made from `question`, `title`, and `options`. */
export function questionPages(q: Question): QuestionPage[] {
  if (q.questions?.length) return q.questions
  return [
    { question: q.question, header: q.title ?? "Question", options: (q.options ?? []).map((label) => ({ label })) },
  ]
}

/** Whether the TUI can answer `q`: one page, one pick. The protocol has no answer shape for more yet. */
export function answerable(q: Question) {
  const pages = questionPages(q)
  return pages.length === 1 && pages[0].multi_select !== true
}

/** The open question card: pick an option or type an answer; Esc stops the question. */
export function QuestionPrompt(props: { question: Question | undefined }) {
  const office = useOffice()
  const toast = useToast()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpencodeModeStack()

  // The card stays mounted while its question is replaced by a newer copy (a reconnect re-reads
  // it); keep the last copy for the moment the question goes before the card does.
  const question = createMemo<Question>((prev) => props.question ?? prev, props.question!)
  const page = createMemo(() => questionPages(question())[0])
  const canAnswer = createMemo(() => answerable(question()))
  const [store, setStore] = createStore({ selected: 0, editing: false, custom: "" })

  let textarea: TextareaRenderable | undefined

  const options = createMemo(() => page()?.options ?? [])
  // Every question takes a typed answer after its options.
  const other = createMemo(() => store.selected === options().length)

  // One answer at a time: a second pick while the first is in flight would race it.
  let sending = false

  function send(req: AnswerRequest) {
    if (sending) return
    sending = true
    const id = question().id
    office.client.questions
      .answer(id, req)
      .then((q) => office.putQuestion(q))
      .catch((error) => {
        if (error instanceof OfficeError && error.status === 409) {
          toast.show({ message: "This question was already answered", variant: "warning" })
          return office.refreshQuestion(id).catch(() => {})
        }
        toast.show({ title: "Answering failed", message: errorMessage(error), variant: "error" })
      })
      .finally(() => (sending = false))
  }

  function reject() {
    office.client.questions.stop(question().id).catch((error) => {
      if (isNotImplemented(error))
        return toast.show({ message: "Stopping a question is not available yet", variant: "warning" })
      toast.show({ title: "Stopping failed", message: errorMessage(error), variant: "error" })
    })
  }

  function moveTo(index: number) {
    setStore("selected", index)
  }

  function selectOption() {
    if (other()) return setStore("editing", true)
    const opt = options()[store.selected]
    if (opt) send({ answer: opt.label, answer_kind: "option" })
  }

  onMount(() => {
    const popMode = modeStack.push(QUESTION_MODE)
    onCleanup(popMode)
  })

  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: store.editing,
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
          setStore({ custom: text, editing: false })
          if (text) send({ answer: text, answer_kind: "text" })
        },
      },
    ],
  }))

  useBindings(() => {
    const total = options().length + 1
    const stop = [
      { key: "escape", desc: "Reject question", group: "Question", cmd: () => reject() },
      ...tuiConfig.keybinds.get("app.exit"),
    ]
    return {
      mode: QUESTION_MODE,
      enabled: !store.editing,
      commands: [
        {
          name: "app.exit",
          title: "Reject question",
          category: "Question",
          run() {
            reject()
          },
        },
      ],
      bindings: !canAnswer()
        ? stop
        : [
            ...Array.from({ length: Math.min(total, 9) }, (_, index) => ({
              key: String(index + 1),
              desc: `Select answer ${index + 1}`,
              group: "Question",
              cmd: () => {
                moveTo(index)
                selectOption()
              },
            })),
            {
              key: "up",
              desc: "Previous answer",
              group: "Question",
              cmd: () => moveTo((store.selected - 1 + total) % total),
            },
            {
              key: "k",
              desc: "Previous answer",
              group: "Question",
              cmd: () => moveTo((store.selected - 1 + total) % total),
            },
            { key: "down", desc: "Next answer", group: "Question", cmd: () => moveTo((store.selected + 1) % total) },
            { key: "j", desc: "Next answer", group: "Question", cmd: () => moveTo((store.selected + 1) % total) },
            { key: "return", desc: "Select answer", group: "Question", cmd: () => selectOption() },
            ...stop,
          ],
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <Show
          when={canAnswer()}
          fallback={
            <box paddingLeft={1} gap={1}>
              <text fg={theme.text}>{question().title ?? question().question}</text>
              <For each={questionPages(question())}>
                {(q) => (
                  <text>
                    <span style={{ fg: theme.textMuted }}>{q.header}:</span>{" "}
                    <span style={{ fg: theme.text }}>{q.question}</span>
                  </text>
                )}
              </For>
              <text fg={theme.warning}>This question can't be answered here yet.</text>
            </box>
          }
        >
          <box paddingLeft={1} gap={1}>
            <box>
              <text fg={theme.text}>{page()?.question}</text>
            </box>
            <box>
              <For each={options()}>
                {(opt, i) => {
                  const active = () => i() === store.selected
                  return (
                    <box
                      onMouseOver={() => moveTo(i())}
                      onMouseDown={() => moveTo(i())}
                      onMouseUp={() => {
                        if (renderer.getSelection()?.getSelectedText()) return
                        selectOption()
                      }}
                    >
                      <box flexDirection="row">
                        <box backgroundColor={active() ? theme.backgroundElement : undefined} paddingRight={1}>
                          <text fg={active() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                            {`${i() + 1}.`}
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
              <box
                onMouseOver={() => moveTo(options().length)}
                onMouseDown={() => moveTo(options().length)}
                onMouseUp={() => {
                  if (renderer.getSelection()?.getSelectedText()) return
                  selectOption()
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
                      initialValue={store.custom}
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
                <Show when={!store.editing && store.custom}>
                  <box paddingLeft={3}>
                    <text fg={theme.textMuted}>{store.custom}</text>
                  </box>
                </Show>
              </box>
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
        <box flexDirection="row" gap={2}>
          <Show when={canAnswer()}>
            <text fg={theme.text}>
              {"↑↓"} <span style={{ fg: theme.textMuted }}>select</span>
            </text>
            <text fg={theme.text}>
              enter <span style={{ fg: theme.textMuted }}>submit</span>
            </text>
          </Show>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>dismiss</span>
          </text>
        </box>
      </box>
    </box>
  )
}

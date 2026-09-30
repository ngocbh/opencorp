import { createStore, produce } from "solid-js/store"
import { createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { tint, useTheme } from "../../context/theme"
import type { AnswerRequest, Question } from "@agent-corp/protocol"
import { useOffice } from "../../context/office"
import { OfficeError, isMissingRoute, isNotImplemented } from "../../office/errors"
import { errorMessage } from "../../util/error"
import { personLabel } from "../../util/transcript"
import { useToast } from "../../ui/toast"
import { SplitBorder } from "../../ui/border"
import { useTuiConfig } from "../../config"
import { useBindings, useOpencodeModeStack } from "../../keymap"
import { buildAnswer, cardModel, type PageAnswer } from "./answer"
import { leaveBindings } from "./leave"

const QUESTION_MODE = "question"

/**
 * The open question card: a page per question to pick or type on, "Chat about this", and "Send
 * discussion back"; Esc then `y` stops the asker. A question carried from an expired one shows
 * that discussion, which can be dismissed. It stays mounted, `hidden`, while its side chat shows,
 * so page answers survive the chat.
 */
export function QuestionCard(props: { question: Question | undefined; hidden?: boolean; onChat: () => void }) {
  const office = useOffice()
  const toast = useToast()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpencodeModeStack()

  // The card stays mounted while its question is replaced by a newer copy (a reconnect re-reads
  // it); keep the last copy for the moment the question goes before the card does.
  const question = createMemo<Question>((prev) => props.question ?? prev, props.question!)
  const model = createMemo(() => cardModel(question()))
  const [store, setStore] = createStore({
    page: 0,
    selected: 0,
    editing: false,
    confirming: false,
    answers: [] as PageAnswer[],
  })

  // The context header: who asks, and for which work item. The store has a work item only once
  // an event carried it, so fetch it when it isn't there.
  const [fetched] = createResource(
    () => question().work_item_id ?? undefined,
    (id) => office.client.workItems.get(id).catch(() => undefined),
  )
  const workItem = createMemo(() => {
    const id = question().work_item_id
    return id ? (office.state.workItems[id] ?? fetched()) : undefined
  })
  const asker = createMemo(() => personLabel(office.state.people, question().asker))
  // The expired question this one carries the discussion of. The store holds only open
  // questions from the first load, so read it from the office when it isn't there.
  const [earlierFetched] = createResource(
    () => question().carried_from ?? undefined,
    (id) => office.client.questions.get(id).catch(() => undefined),
  )
  const earlier = createMemo(() => {
    const id = question().carried_from
    return id ? (office.state.questions[id] ?? earlierFetched()) : undefined
  })
  // A human_input is never interrupted, so its card has no stop.
  const stoppable = createMemo(() => question().source !== "human_input")
  const context = createMemo(() => {
    const item = workItem()
    return item ? `${asker()} asks · work item "${item.title}"` : `${asker()} asks`
  })

  const pages = createMemo(() => model()?.pages ?? [])
  const page = createMemo(() => pages()[store.page])
  const answer = createMemo<PageAnswer>(() => store.answers[store.page] ?? { picked: [], text: "" })
  const options = createMemo(() => page()?.options ?? [])
  // The office's own actions come after the answer rows and never count as options.
  const actions = createMemo(() => [
    { label: "Chat about this", key: "ctrl+o", run: () => props.onChat() },
    ...(stoppable() && (question().discussion?.length || question().carried_from)
      ? [{ label: "Send discussion back", key: "", run: () => sendBack() }]
      : []),
    ...(question().carried_from ? [{ label: "Dismiss earlier discussion", key: "", run: () => dismiss() }] : []),
  ])
  const answerRows = createMemo(() => options().length + (page()?.typed ? 1 : 0))
  const rows = createMemo(() => answerRows() + actions().length)
  const other = createMemo(() => page()?.typed === true && store.selected === options().length)

  let textarea: TextareaRenderable | undefined

  // One office call at a time: a second pick, stop, send back, or dismiss while one is in flight
  // would race it.
  let sending = false

  function call(run: () => Promise<unknown>) {
    if (sending) return
    sending = true
    run().finally(() => (sending = false))
  }

  function send(req: AnswerRequest) {
    const id = question().id
    call(() =>
      office.client.questions
        .answer(id, req)
        .then((q) => office.putQuestion(q))
        .catch((error) => {
          if (error instanceof OfficeError && error.status === 409) {
            toast.show({ message: "This question was already answered", variant: "warning" })
            return office.refreshQuestion(id).catch(() => {})
          }
          toast.show({ title: "Answering failed", message: errorMessage(error), variant: "error" })
        }),
    )
  }

  function sendBack() {
    const id = question().id
    call(() =>
      office.client.questions
        .sendBack(id, { note: "" })
        .then((q) => office.putQuestion(q))
        .catch((error) => {
          if (isNotImplemented(error))
            return toast.show({ message: "Sending a discussion back is not available yet", variant: "warning" })
          toast.show({ title: "Sending back failed", message: errorMessage(error), variant: "error" })
        }),
    )
  }

  function dismiss() {
    call(() =>
      office.client.questions
        .dismissCarried(question().id)
        .then((q) => {
          setStore("selected", 0)
          office.putQuestion(q)
        })
        .catch((error) => {
          // An office without the carried/dismiss route answers 404 no_route rather than 501.
          if (isNotImplemented(error) || isMissingRoute(error))
            return toast.show({ message: "Dismissing a discussion is not available yet", variant: "warning" })
          toast.show({ title: "Dismissing failed", message: errorMessage(error), variant: "error" })
        }),
    )
  }

  function stop() {
    setStore("confirming", false)
    call(() =>
      office.client.questions
        .stop(question().id)
        .then((q) => office.putQuestion(q))
        .catch((error) => {
          if (isNotImplemented(error))
            return toast.show({ message: "Stopping a question is not available yet", variant: "warning" })
          toast.show({ title: "Stopping failed", message: errorMessage(error), variant: "error" })
        }),
    )
  }

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

  /** Moves to the next page, or sends the answer from the last one. */
  function next() {
    const m = model()
    if (!m) return
    if (store.page < m.pages.length - 1) return goTo(store.page + 1)
    const req = buildAnswer(m, store.answers)
    if (req) return send(req)
    // A page left without an answer: go back to it.
    goTo(m.pages.findIndex((p, i) => !p.multi && !store.answers[i]?.picked.length && !store.answers[i]?.text.trim()))
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

  onCleanup(() => {
    // The card closes when its question does; say so when that was the run restarting.
    const q = office.state.questions[question().id]
    if (q?.status === "stale")
      toast.show({ message: `${asker()}'s question expired: the run restarted`, variant: "warning", duration: 5000 })
  })

  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: store.confirming && !props.hidden,
    bindings: [
      { key: "y", desc: "Stop the asker", group: "Question", cmd: () => stop() },
      ...["n", "escape", "return"].map((key) => ({
        key,
        desc: "Keep the question",
        group: "Question",
        cmd: () => setStore("confirming", false),
      })),
      ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
    ],
  }))

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
    const keys = [
      ...(stoppable()
        ? [{ key: "escape", desc: "Stop the asker", group: "Question", cmd: () => setStore("confirming", true) }]
        : []),
      { key: "ctrl+o", desc: "Chat about this", group: "Question", cmd: () => props.onChat() },
      // Ctrl+C leaves the view as it does in the chat; it never stops the question.
      ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
    ]
    const paging =
      pages().length > 1
        ? [
            { key: "left", desc: "Previous question", group: "Question", cmd: () => goTo(Math.max(store.page - 1, 0)) },
            {
              key: "right",
              desc: "Next question",
              group: "Question",
              cmd: () => goTo(Math.min(store.page + 1, pages().length - 1)),
            },
          ]
        : []
    return {
      mode: QUESTION_MODE,
      enabled: !store.editing && !store.confirming && !props.hidden,
      bindings: !model()
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
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>{context()}</text>
        </box>
        <Show when={earlier()}>
          {(q) => (
            <box paddingLeft={1}>
              <text fg={theme.warning}>{`From an earlier, expired question: ${q().question}`}</text>
              <For each={q().discussion ?? []}>
                {(entry) => (
                  <text fg={theme.textMuted}>{`${entry.role === "user" ? "you" : asker()}: ${entry.text}`}</text>
                )}
              </For>
            </box>
          )}
        </Show>
        <Show
          when={model()}
          fallback={
            <box paddingLeft={1} gap={1}>
              <text fg={theme.text}>{question().title ?? question().question}</text>
              <Show when={question().title}>
                <text fg={theme.text}>{question().question}</text>
              </Show>
              <text fg={theme.warning}>This question can't be answered here yet.</text>
            </box>
          }
        >
          <box paddingLeft={1} gap={1}>
            <box>
              <Show when={pages().length > 1}>
                <text fg={theme.textMuted}>
                  {`Question ${store.page + 1} of ${pages().length} · ${page()?.header}`}
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
        <Show when={store.confirming}>
          <text fg={theme.warning}>{`Stop ${asker()}? y/N`}</text>
        </Show>
        <box flexDirection="row" gap={2} visible={!store.confirming}>
          <Show when={model()}>
            <text fg={theme.text}>
              {"↑↓"} <span style={{ fg: theme.textMuted }}>select</span>
            </text>
            <Show when={page()?.multi}>
              <text fg={theme.text}>
                space <span style={{ fg: theme.textMuted }}>toggle</span>
              </text>
            </Show>
            <Show when={pages().length > 1}>
              <text fg={theme.text}>
                {"←→"} <span style={{ fg: theme.textMuted }}>question</span>
              </text>
            </Show>
            <text fg={theme.text}>
              enter <span style={{ fg: theme.textMuted }}>{store.page < pages().length - 1 ? "next" : "submit"}</span>
            </text>
          </Show>
          <Show when={stoppable()}>
            <text fg={theme.text}>
              esc <span style={{ fg: theme.textMuted }}>stop {asker()}</span>
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}

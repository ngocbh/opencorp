import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import type { AnswerRequest, Question } from "@opencorp/protocol"
import { useOffice } from "../../context/office"
import { OfficeError, isMissingRoute, isNotImplemented } from "@opencorp/client"
import { errorMessage } from "../../util/error"
import { personLabel } from "../../util/transcript"
import { useToast } from "../../ui/toast"
import { useTuiConfig } from "../../config"
import { useBindings } from "../../keymap"
import { buildAnswer, cardModel } from "./answer"
import { leaveBindings } from "./leave"
import { QUESTION_MODE, QuestionView, type QuestionViewHandle } from "./question-view"
import { display } from "../../util/printable"

/**
 * The open question card for an office question, with options and a box to type an answer: `QuestionView` with who
 * asks, "Chat about this", "Send discussion back", and Esc then `y` to stop the asker. A question carried from an
 * expired one shows that discussion, which can be dismissed. It stays mounted, `hidden`, while its side chat shows,
 * so page answers survive the chat.
 */
export function QuestionCard(props: { question: Question | undefined; hidden?: boolean; onChat: () => void }) {
  const office = useOffice()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()

  // The card stays mounted while its question is replaced by a newer copy (a reconnect re-reads
  // it); keep the last copy for the moment the question goes before the card does.
  const question = createMemo<Question>((prev) => props.question ?? prev, props.question!)
  const model = createMemo(() => cardModel(question()))
  const [confirming, setConfirming] = createSignal(false)

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
  // An ask node is never interrupted, so its card has no stop.
  const stoppable = createMemo(() => question().source !== "ask")
  const context = createMemo(() => {
    const item = workItem()
    return item ? `${asker()} asks · work item "${item.title}"` : `${asker()} asks`
  })

  // The office's own actions come after the answer rows and never count as options.
  const actions = createMemo(() => [
    { label: "Chat about this", key: "ctrl+o", run: () => props.onChat() },
    ...(stoppable() && (question().discussion?.length || question().carried_from)
      ? [{ label: "Send discussion back", key: "", run: () => sendBack() }]
      : []),
    ...(question().carried_from ? [{ label: "Dismiss earlier discussion", key: "", run: () => dismiss() }] : []),
  ])

  let view: QuestionViewHandle | undefined

  // One office call at a time: a second pick, stop, send back, or dismiss while one is in flight
  // would race it.
  let sending = false

  function call(run: () => Promise<unknown>) {
    if (sending) return toast.show({ message: "Busy: the last action is still sending", variant: "info" })
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
          view?.select(0)
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
    setConfirming(false)
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

  onCleanup(() => {
    // The card closes when its question does; say so when that was the run restarting.
    const q = office.state.questions[question().id]
    if (q?.status === "stale")
      toast.show({ message: `${asker()}'s question expired: the run restarted`, variant: "warning", duration: 5000 })
  })

  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: confirming() && !props.hidden,
    bindings: [
      { key: "y", desc: "Stop the asker", group: "Question", cmd: () => stop() },
      ...["n", "escape", "return"].map((key) => ({
        key,
        desc: "Keep the question",
        group: "Question",
        // Returns nothing: the keymap takes a false return as unhandled and passes the key on, into the box that
        // the closing confirm just gave focus back to.
        cmd: () => {
          setConfirming(false)
        },
      })),
      ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
    ],
  }))

  return (
    <QuestionView
      pages={model()?.pages ?? []}
      header={context()}
      actions={actions()}
      bindings={[
        ...(stoppable()
          ? [{ key: "escape", desc: "Stop the asker", group: "Question", cmd: () => setConfirming(true) }]
          : []),
        { key: "ctrl+o", desc: "Chat about this", group: "Question", cmd: () => props.onChat() },
        // Ctrl+C on an empty box, or off the box, leaves the view as it does in the chat; it never stops the question.
        ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
      ]}
      hints={stoppable() ? [{ key: "esc", label: `stop ${asker()}` }] : []}
      notice={confirming() ? `Stop ${asker()}? y/N` : undefined}
      enabled={!confirming()}
      hidden={props.hidden}
      ref={(v) => (view = v)}
      onSubmit={(answers) => {
        const m = model()
        const req = m && buildAnswer(m, answers)
        if (req) send(req)
      }}
    >
      <Show when={earlier()}>
        {(q) => (
          <box paddingLeft={1}>
            <text fg={theme.warning}>{`From an earlier, expired question: ${display(q().question)}`}</text>
            <For each={q().discussion ?? []}>
              {(entry) => (
                <text fg={theme.textMuted}>{`${entry.role === "user" ? "you" : asker()}: ${display(entry.text)}`}</text>
              )}
            </For>
          </box>
        )}
      </Show>
      <Show when={!model()}>
        <box paddingLeft={1} gap={1}>
          <text fg={theme.text}>{display(question().title ?? question().question)}</text>
          <Show when={question().title}>
            <text fg={theme.text}>{display(question().question)}</text>
          </Show>
          <text fg={theme.warning}>This question can't be answered here yet.</text>
        </box>
      </Show>
    </QuestionView>
  )
}

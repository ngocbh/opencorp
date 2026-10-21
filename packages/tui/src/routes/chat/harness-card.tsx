import { createMemo, Show } from "solid-js"
import type { AnswerRequest, Question } from "@opencorp/protocol"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { useCommandShortcut } from "../../keymap"
import { OfficeError } from "@opencorp/client"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { interruptible } from "../../util/status"
import { buildAnswer, cardModel } from "./answer"
import { leaveBindings } from "./leave"
import { QuestionView } from "./question-view"

/**
 * An open card for a Codex request: Codex asks, and the only action is an answer. No side chat, send back or stop:
 * the office refuses them. Esc interrupts Codex's turn, as it does in the prompt. Only the `active` card is a full
 * card; any other is one line (`waiting` behind the first), which mounts no keys and holds no typed or secret text
 * while the prompt or another card has the keys.
 */
export function HarnessCard(props: {
  question: Question
  active: boolean
  waiting: boolean
  /** Called when Esc interrupts the session, before the office is asked to. */
  onInterrupt?: () => void
}) {
  const office = useOffice()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const model = createMemo(() => cardModel(props.question))
  const title = () => props.question.title ?? props.question.question
  const focusKey = useCommandShortcut("session.card.focus")
  // Esc interrupts while a turn is starting, running or waiting, as in the prompt.
  const canInterrupt = createMemo(() =>
    interruptible(office.state.sessions.find((s) => s.id === props.question.session_id)?.status),
  )
  // One answer call at a time: a second pick while one is in flight would race it.
  let sending = false

  /** Says the answer never reached Codex, which stopped waiting for the card. */
  function unused() {
    toast.show({ message: "Codex stopped waiting; your answer wasn't used", variant: "warning", duration: 5000 })
  }

  function send(req: AnswerRequest) {
    if (sending) return
    sending = true
    const id = props.question.id
    office.client.questions
      .answer(id, req)
      .then((q) => {
        // The card closes on any status but open; a stale one means Codex never got the answer.
        if (q.status === "stale") unused()
        office.putQuestion(q)
      })
      .catch((error) => {
        if (error instanceof OfficeError && error.status === 409)
          return office
            .refreshQuestion(id)
            .catch(() => {})
            .then(() => {
              if (office.state.questions[id]?.status === "stale") return unused()
              toast.show({ message: "This card was already answered", variant: "warning" })
            })
        toast.show({ title: "Answering failed", message: errorMessage(error), variant: "error" })
      })
      .finally(() => (sending = false))
  }

  function interrupt() {
    props.onInterrupt?.()
    office.client.sessions
      .interrupt(props.question.session_id)
      .catch((error) => toast.show({ title: "Interrupting failed", message: errorMessage(error), variant: "error" }))
  }

  return (
    <Show
      when={props.active}
      fallback={
        <box paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="none">
            {props.waiting ? `Codex asks: ${title()} (waiting)` : `Codex asks: ${title()} · ${focusKey()} to answer`}
          </text>
        </box>
      }
    >
      <QuestionView
        header="Codex asks"
        pages={model()?.pages ?? []}
        // A dialog over the card has the keys: its secret box reads the whole app's keyboard, not a focused box.
        enabled={dialog.stack.length === 0}
        bindings={[
          ...(canInterrupt() ? [{ key: "escape", desc: "Interrupt Codex", group: "Question", cmd: () => interrupt() }] : []),
          // Ctrl+C on an empty box, or off the box, leaves the view as it does in the chat.
          ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
        ]}
        hints={[...(canInterrupt() ? [{ key: "esc", label: "interrupt Codex" }] : []), { key: focusKey(), label: "prompt" }]}
        onSubmit={(answers) => {
          const m = model()
          const req = m && buildAnswer(m, answers)
          if (req) send(req)
        }}
      >
        <Show when={props.question.title}>
          <box paddingLeft={1}>
            <text fg={theme.text}>{props.question.title}</text>
          </box>
        </Show>
      </QuestionView>
    </Show>
  )
}

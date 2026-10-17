import { createMemo, Show } from "solid-js"
import type { AnswerRequest, Question } from "@agent-corp/protocol"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { useCommandShortcut } from "../../keymap"
import { OfficeError } from "../../office/errors"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { buildAnswer, cardModel } from "./answer"
import { leaveBindings } from "./leave"
import { QuestionView } from "./question-view"

/**
 * An open card for a Codex request: Codex asks, and the only action is an answer. No side chat, send back or stop:
 * the office refuses them. Esc interrupts Codex's turn, as it does in the prompt. Only the `active` card is a full
 * card; any other is one line (`waiting` behind the first), which mounts no keys and holds no typed or secret text
 * while the prompt or another card has the keys.
 */
export function HarnessCard(props: { question: Question; active: boolean; waiting: boolean }) {
  const office = useOffice()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const model = createMemo(() => cardModel(props.question))
  const title = () => props.question.title ?? props.question.question
  const focusKey = useCommandShortcut("session.card.focus")
  // One answer call at a time: a second pick while one is in flight would race it.
  let sending = false

  function send(req: AnswerRequest) {
    if (sending) return
    sending = true
    const id = props.question.id
    office.client.questions
      .answer(id, req)
      .then((q) => {
        // The card closes on any status but open; a stale one means Codex never got the answer.
        if (q.status === "stale")
          toast.show({ message: "Codex stopped waiting; your answer wasn't used", variant: "warning", duration: 5000 })
        office.putQuestion(q)
      })
      .catch((error) => {
        if (error instanceof OfficeError && error.status === 409) {
          toast.show({ message: "This card was already answered", variant: "warning" })
          return office.refreshQuestion(id).catch(() => {})
        }
        toast.show({ title: "Answering failed", message: errorMessage(error), variant: "error" })
      })
      .finally(() => (sending = false))
  }

  function interrupt() {
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
        bindings={[
          { key: "escape", desc: "Interrupt Codex", group: "Question", cmd: () => interrupt() },
          // Ctrl+C on an empty box, or off the box, leaves the view as it does in the chat.
          ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
        ]}
        hints={[
          { key: "esc", label: "interrupt Codex" },
          { key: focusKey(), label: "prompt" },
        ]}
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

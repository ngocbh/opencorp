import { createMemo, Show } from "solid-js"
import type { AnswerRequest, Question } from "@agent-corp/protocol"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { OfficeError } from "../../office/errors"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { buildAnswer, cardModel } from "./answer"
import { leaveBindings } from "./leave"
import { QuestionView } from "./question-view"

/**
 * An open card for a Codex request: Codex asks, and the only action is an answer. No side chat, send back or stop:
 * the office refuses them. Only the `active` card is a full card; any other is one line (`waiting` behind the
 * first), which mounts no keys and holds no typed or secret text while the prompt or another card has the keys.
 */
export function HarnessCard(props: { question: Question; active: boolean; waiting: boolean }) {
  const office = useOffice()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const model = createMemo(() => cardModel(props.question))
  const title = () => props.question.title ?? props.question.question
  // One answer call at a time: a second pick while one is in flight would race it.
  let sending = false

  function send(req: AnswerRequest) {
    if (sending) return
    sending = true
    const id = props.question.id
    office.client.questions
      .answer(id, req)
      .then((q) => office.putQuestion(q))
      .catch((error) => {
        if (error instanceof OfficeError && error.status === 409) {
          toast.show({ message: "This card was already answered", variant: "warning" })
          return office.refreshQuestion(id).catch(() => {})
        }
        toast.show({ title: "Answering failed", message: errorMessage(error), variant: "error" })
      })
      .finally(() => (sending = false))
  }

  return (
    <Show
      when={props.active}
      fallback={
        <box paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="none">
            {props.waiting ? `Codex asks: ${title()} (waiting)` : `Codex asks: ${title()}`}
          </text>
        </box>
      }
    >
      <QuestionView
        header="Codex asks"
        pages={model()?.pages ?? []}
        // Ctrl+C on an empty box, or off the box, leaves the view as it does in the chat.
        bindings={leaveBindings(tuiConfig.keybinds.get("app.exit"))}
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

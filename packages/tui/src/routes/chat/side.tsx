import type { Question, Session } from "@opencorp/protocol"
import type { TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, on, onCleanup, onMount, Show } from "solid-js"
import { useTuiConfig } from "../../config"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { clearFirst, useBindings, useOpenCorpModeStack } from "../../keymap"
import { EmptyBorder } from "../../ui/border"
import { useToast } from "../../ui/toast"
import { OfficeUnavailable, isNotImplemented } from "@opencorp/client"
import { errorMessage } from "../../util/error"
import { interruptible } from "../../util/status"
import { personLabel } from "../../util/transcript"
import { leaveBindings } from "./leave"

const SIDE_MODE = "side"

/** What the side chat refuses, in any case: only the office ends a side session, when its question closes. */
const SIDE_EXIT = new Set(["/end", "/exit", "/quit"])

/** The statuses a session takes prompts in; any other goes back through the side route, which restarts it. */
const LIVE: Session["status"][] = ["starting", "idle", "busy", "waiting", "ending"]

/** The side chat's header: who explains which question, and, for a gate, whose side they are on. */
export function SideHeader(props: { question: Question; session: Session | undefined }) {
  const office = useOffice()
  const { theme } = useTheme()
  const asker = createMemo(() => personLabel(office.state.people, props.question.asker))
  return (
    <box flexShrink={0} paddingTop={1}>
      <text fg={theme.text} wrapMode="none">
        <b>Side chat with {asker()}</b>
        <Show when={props.session}>
          {(s) => (
            <span style={{ fg: s().status === "busy" ? theme.warning : theme.textMuted }}>
              {" "}
              · {s().status}
            </span>
          )}
        </Show>
      </text>
      <text fg={theme.textMuted}>About: {props.question.question}</text>
      <Show when={props.question.gate}>
        <text fg={theme.warning}>{asker()}'s explanation (the requester), not neutral advice</text>
      </Show>
    </box>
  )
}

/**
 * The side chat's input: Enter sends to the side session, through the question's side route while
 * the session isn't live (none yet, or ended), Esc interrupts its reply, and `/back` or Ctrl+B
 * returns to the card.
 */
export function SideChat(props: {
  question: Question
  session: Session | undefined
  onBack: () => void
  /** Called as a message is sent, before the office answers; returns an undo for a send that fails. */
  onSend: () => (() => void) | void
  onInterrupt: () => void
}) {
  const office = useOffice()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpenCorpModeStack()
  let textarea: TextareaRenderable | undefined
  // A second Enter while a message is out sends nothing; the text stays until the office takes it.
  let sending = false

  onMount(() => {
    const popMode = modeStack.push(SIDE_MODE)
    onCleanup(popMode)
  })

  function fail(error: unknown) {
    if (isNotImplemented(error)) return toast.show({ message: "Side chats are not available yet", variant: "warning" })
    toast.show({ title: "Side chat failed", message: errorMessage(error), variant: "error" })
  }

  // A side session that predates this view (another client started it, or it was seen before a
  // restart) is not synced yet: load it, so its history shows and its replies stream in.
  createEffect(
    on(
      () => props.question.side_session_id,
      (id) => {
        if (!id || office.state.messages[id]) return
        // An office that is down loads it when it comes back.
        office.syncSession(id).catch((error) => error instanceof OfficeUnavailable || fail(error))
      },
    ),
  )

  function submit() {
    const text = textarea?.plainText.trim() ?? ""
    if (!text) return
    if (text.toLowerCase() === "/back") return props.onBack()
    if (SIDE_EXIT.has(text.toLowerCase())) {
      textarea?.setText("")
      return toast.show({ message: "use /back to return to the question", variant: "warning" })
    }
    if (sending) return
    sending = true
    const s = props.session
    const undo = props.onSend()
    // The side route opens or restarts a side session that isn't live.
    const sent =
      s && LIVE.includes(s.status)
        ? office.client.sessions.prompt(s.id, { text }).then(() => undefined)
        : office.client.questions.side(props.question.id, { text })
    sent
      .then(
        (side) => {
          // Cleared once the office has the message, so a failed load can't leave it to be sent twice.
          // The view may have closed meanwhile; an edit made since stays.
          if (textarea && !textarea.isDestroyed && textarea.plainText.trim() === text) textarea.setText("")
          if (side) return office.syncSession(side.id).catch(fail)
        },
        (error) => {
          undo?.()
          fail(error)
        },
      )
      .finally(() => (sending = false))
  }

  function interrupt() {
    const s = props.session
    if (!s || !interruptible(s.status)) return
    props.onInterrupt()
    office.client.sessions.interrupt(s.id).catch(fail)
  }

  /** Empties the box; false when it is empty or its text is on its way to the office. */
  function clearBox() {
    if (sending || !textarea || textarea.isDestroyed || !textarea.plainText) return false
    textarea.setText("")
    return true
  }

  useBindings(() => ({
    mode: SIDE_MODE,
    bindings: [
      // First: with text in the box, Ctrl+C and Esc only clear it. On an empty box they go on to the interrupt and
      // leave below.
      ...clearFirst(tuiConfig.keybinds.get("prompt.clear"), clearBox),
      { key: "return", desc: "Send to the side chat", group: "Side chat", cmd: () => submit() },
      { key: "escape", desc: "Interrupt the side reply", group: "Side chat", cmd: () => interrupt() },
      { key: "ctrl+b", desc: "Back to the question", group: "Side chat", cmd: () => props.onBack() },
      ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
    ],
  }))

  return (
    <box flexShrink={0}>
      <box
        border={["left"]}
        borderColor={theme.accent}
        customBorderChars={{ ...EmptyBorder, vertical: "┃" }}
        backgroundColor={theme.backgroundElement}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <textarea
          ref={(val: TextareaRenderable) => {
            textarea = val
            queueMicrotask(() => val.focus())
          }}
          placeholder={`Ask ${personLabel(office.state.people, props.question.asker)} about the question`}
          placeholderColor={theme.textMuted}
          minHeight={1}
          maxHeight={6}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          cursorStyle={tuiConfig.cursor}
        />
      </box>
      <box flexDirection="row" gap={2} paddingLeft={2}>
        <text fg={theme.text}>
          enter <span style={{ fg: theme.textMuted }}>send</span>
        </text>
        <text fg={theme.text}>
          esc <span style={{ fg: theme.textMuted }}>interrupt</span>
        </text>
        <text fg={theme.text}>
          ctrl+b <span style={{ fg: theme.textMuted }}>back to the question</span>
        </text>
      </box>
    </box>
  )
}

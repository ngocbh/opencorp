import type { Session } from "@opencorp/protocol"
import { createMemo, createSignal, Show } from "solid-js"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { useCommandShortcut, useOpenCorpKeymap } from "../../keymap"
import { SplitBorder } from "../../ui/border"
import { Locale } from "../../util/locale"
import { display } from "../../util/printable"

/** The Codex and Claude Code sessions an employee's chat drives (its child sessions), oldest first. */
export function childSessions(sessions: readonly Session[], chat: string | undefined): Session[] {
  if (!chat) return []
  return sessions
    .filter((s) => s.instrument_of === chat)
    .toSorted((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
}

/**
 * Above the prompt of a child session, a Codex or Claude Code session an employee's chat drives: its name in the chat's
 * list, which of the chat's sessions it is, who drives it and the tokens its harness reported; then Parent, Prev and
 * Next with their keys, each a button too. The upstream TUI's subagent footer, for a child session that the owner can also write in.
 */
export function InstrumentFooter(props: { session: Session }) {
  const office = useOffice()
  const { theme } = useTheme()
  const keymap = useOpenCorpKeymap()
  const parentShortcut = useCommandShortcut("session.parent")
  const previousShortcut = useCommandShortcut("session.child.previous")
  const nextShortcut = useCommandShortcut("session.child.next")
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)

  const info = createMemo(() => {
    const chat = props.session.instrument_of ?? undefined
    const siblings = childSessions(office.state.sessions, chat)
    const listed = chat ? office.state.instruments[chat]?.find((i) => i.id === props.session.id) : undefined
    return {
      label: listed ? display(listed.name) : props.session.harness === "claude" ? "Claude Code session" : "Codex session",
      index: siblings.findIndex((s) => s.id === props.session.id) + 1,
      total: siblings.length,
    }
  })
  const usage = createMemo(() => {
    const used = props.session.harness_usage
    const tokens = used ? used.input_tokens + used.output_tokens : 0
    return tokens > 0 ? `${Locale.number(tokens)} tokens` : undefined
  })
  const button = (name: "parent" | "prev" | "next", label: string, command: string, shortcut: () => string) => (
    <box
      onMouseOver={() => setHover(name)}
      onMouseOut={() => setHover(null)}
      onMouseUp={() => keymap.dispatchCommand(command)}
      backgroundColor={hover() === name ? theme.backgroundElement : theme.backgroundPanel}
    >
      <text fg={theme.text}>
        {label} <span style={{ fg: theme.textMuted }}>{shortcut()}</span>
      </text>
    </box>
  )

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
            <text fg={theme.text} wrapMode="none">
              <b>{info().label}</b>
            </text>
            <Show when={info().total > 0}>
              <text style={{ fg: theme.textMuted }} wrapMode="none">
                ({info().index} of {info().total})
              </text>
            </Show>
            <text fg={theme.textMuted} wrapMode="none">
              · driven by @{display(props.session.person)}
            </text>
            <Show when={usage()}>
              {(used) => (
                <text fg={theme.textMuted} wrapMode="none">
                  · {used()}
                </text>
              )}
            </Show>
          </box>
          <box flexDirection="row" gap={2} flexShrink={0}>
            {button("parent", "Parent", "session.parent", parentShortcut)}
            {button("prev", "Prev", "session.child.previous", previousShortcut)}
            {button("next", "Next", "session.child.next", nextShortcut)}
          </box>
        </box>
      </box>
    </box>
  )
}

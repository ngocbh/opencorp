import { RGBA } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"

/** What the row under the prompt's text names: who answers there, and the model they answer on. */
export type PromptWho = {
  /** Who answers: the employee's `@handle`, or the name of the Codex or Claude Code session. */
  name: string
  /** The chat's mode, while Shift+Tab can switch it. */
  mode?: string
  /** The harness that answers, beside its session's name. */
  harness?: string
  /** The employee's title. */
  title?: string
  model?: string
  /** `as @<handle>`: whom the owner writes as, in a session they write to as themselves. */
  as?: string
}

/**
 * The row under the prompt's text, the upstream TUI's prompt metadata row: who answers in `highlight`, the mode, the
 * harness or title, and the model, then whom the owner writes as. It stays one row: short of room, the parts give way
 * as `promptWhoLayout` says.
 */
export function PromptWhoRow(props: {
  who: PromptWho | undefined
  highlight: RGBA
  /** While the leader key waits, the title and harness are muted too. */
  muted: boolean
  nameAlpha: number
  metaAlpha: number
}) {
  const { theme } = useTheme()
  const [width, setWidth] = createSignal<number>()
  const layout = createMemo(() => (props.who ? promptWhoLayout(props.who, width()) : undefined))
  const muted = () => fade(theme.textMuted, props.metaAlpha)
  const text = () => fade(props.muted ? theme.textMuted : theme.text, props.metaAlpha)

  return (
    <box
      flexDirection="row"
      gap={1}
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      overflow="hidden"
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <Show when={layout()} fallback={<box height={1} />}>
        {(who) => (
          <>
            <text wrapMode="none" flexShrink={0} fg={fade(props.highlight, props.nameAlpha)}>
              {who().name}
            </text>
            <Show when={who().mode}>
              {(mode) => (
                // dontAsk refuses what would ask, so it stands out.
                <text
                  wrapMode="none"
                  flexShrink={0}
                  fg={fade(mode() === "dontAsk" ? theme.warning : theme.textMuted, props.nameAlpha)}
                >
                  {mode()}
                </text>
              )}
            </Show>
            <Show when={who().harness}>
              {(harness) => (
                <text wrapMode="none" flexShrink={0} fg={text()}>
                  {harness()}
                </text>
              )}
            </Show>
            <Show when={who().title}>
              {(title) => (
                <>
                  <text fg={muted()}>·</text>
                  <text wrapMode="none" flexShrink={0} fg={text()}>
                    {title()}
                  </text>
                </>
              )}
            </Show>
            <Show when={who().model}>
              {(model) => (
                <>
                  <text fg={muted()}>·</text>
                  <text wrapMode="none" flexShrink={1} minWidth={0} fg={muted()}>
                    {model()}
                  </text>
                </>
              )}
            </Show>
            <Show when={who().as}>
              {(as) => (
                <>
                  <text fg={muted()}>·</text>
                  <text wrapMode="none" flexShrink={0} fg={muted()}>
                    {as()}
                  </text>
                </>
              )}
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

/**
 * The parts of `who` that fit in `width` cells, as the upstream TUI lays out its agent and model: the mode gives way
 * first, then the harness (its session's name says it) and the title, then whom the owner writes as; past that the
 * model is cut short with "…", to no fewer than 9 cells. The name always stays. An unknown width keeps everything.
 */
export function promptWhoLayout(who: PromptWho, width: number | undefined): PromptWho {
  if (width === undefined) return who
  const candidates: PromptWho[] = [
    who,
    { ...who, mode: undefined },
    { name: who.name, model: who.model, as: who.as },
    { name: who.name, model: who.model },
  ]
  const fit = candidates.find((candidate) => Bun.stringWidth(promptWhoText(candidate)) <= width)
  if (fit) return fit
  if (!who.model) return { name: who.name }
  const prefix = `${who.name} · `
  return {
    name: who.name,
    model: Locale.truncateWidth(who.model, Math.max(9, width - Bun.stringWidth(prefix))).replace(/\s+…$/, "…"),
  }
}

/** `who` as the row reads. */
export function promptWhoText(who: PromptWho) {
  return [
    who.name,
    ...(who.mode ? [who.mode] : []),
    ...(who.harness ? [who.harness] : []),
    ...(who.title ? ["·", who.title] : []),
    ...(who.model ? ["·", who.model] : []),
    ...(who.as ? ["·", who.as] : []),
  ].join(" ")
}

function fade(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

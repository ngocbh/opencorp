import type { ConnectionList, Session } from "@opencorp/protocol"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { useOffice } from "../../context/office"
import { sessionModel, statusLabel } from "@opencorp/client"
import { useTuiPaths } from "../../context/runtime"
import { abbreviateHome } from "../../runtime"
import { personLabel } from "../../util/transcript"
import { getScrollAcceleration } from "../../util/scroll"
import { display } from "../../util/printable"

const usd = (n: number) => `$${n.toFixed(2)}`
// Millions from 999,950 on, where thousands would round up to "1000.0k".
const tokens = (n: number) =>
  n < 1000 ? String(n) : n < 999_950 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`

/**
 * The session's cost against its cap, as `$0.12` or `$0.12 of $5.00`. On a subscription connection in `list` it adds
 * `(subscription, unpriced)`: the office records that connection's tokens at $0. A Codex session runs on the
 * owner's Codex login, so it gives its token counts, unpriced.
 */
export function costLabel(
  session: Pick<Session, "cost" | "cost_cap_usd" | "connection" | "model"> &
    Partial<Pick<Session, "harness" | "harness_usage">>,
  list?: ConnectionList,
) {
  if (session.harness === "codex") {
    const u = session.harness_usage
    return u ? `${tokens(u.input_tokens)} in · ${tokens(u.output_tokens)} out (Codex login, unpriced)` : "Codex login, unpriced"
  }
  const { connection } = sessionModel(session, list)
  const subscription = list?.connections.find((c) => c.name === connection)?.method === "subscription"
  if (session.cost === undefined) return subscription ? "subscription, unpriced" : undefined
  const cost = session.cost_cap_usd == null ? usd(session.cost) : `${usd(session.cost)} of ${usd(session.cost_cap_usd)}`
  return subscription ? `${cost} (subscription, unpriced)` : cost
}

/** The session's person, folder, status, cost, and id. */
export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const office = useOffice()
  const paths = useTuiPaths()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => office.state.sessions.find((s) => s.id === props.sessionID))
  const person = createMemo(() => office.state.people.find((p) => p.handle === session()?.person))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <Show when={session()}>
      {(current) => (
        <box
          backgroundColor={theme.backgroundPanel}
          width={42}
          height="100%"
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          position={props.overlay ? "absolute" : "relative"}
        >
          <scrollbox
            flexGrow={1}
            scrollAcceleration={scrollAcceleration()}
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: theme.background,
                foregroundColor: theme.borderActive,
              },
            }}
          >
            <box flexShrink={0} gap={1} paddingRight={1}>
              <box>
                <text fg={theme.text}>
                  <b>{personLabel(office.state.people, current().person)}</b>
                </text>
                <Show when={person()?.title}>
                  <text fg={theme.textMuted}>{person()!.title}</text>
                </Show>
              </box>
              <box>
                <text fg={theme.textMuted}>{display(abbreviateHome(current().cwd, paths.home))}</text>
                <text fg={theme.textMuted}>
                  {statusLabel(current())}
                  <Show when={costLabel(current(), office.connections())}>{(cost) => <span> · {cost()}</span>}</Show>
                </text>
              </box>
              <text fg={theme.textMuted}>{props.sessionID}</text>
            </box>
          </scrollbox>
        </box>
      )}
    </Show>
  )
}

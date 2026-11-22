import type { ConnectionList, Session } from "@opencorp/protocol"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { useOffice } from "../../context/office"
import { HARNESS_NAMES, sessionModel, statusLabel } from "@opencorp/client"
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
 * The session's cost against its cap, as `$0.12` or `$0.12 of $5.00`. The office counts a subscription's tokens toward
 * the cap at what the API would charge, and the subscription pays nothing, so a cost that holds such a part
 * (`subscription_cost`), or one on a subscription connection in `list`, reads `≈$0.12 at API prices, $0 on your
 * subscription`, or `…, $0.04 paid` for the part a key paid. A Codex or Claude Code session runs on the owner's own
 * login for it, so it gives its token counts, unpriced.
 */
export function costLabel(
  session: Pick<Session, "cost" | "cost_cap_usd" | "connection" | "model"> &
    Partial<Pick<Session, "harness" | "harness_usage" | "subscription_cost">>,
  list?: ConnectionList,
) {
  const harness = HARNESS_NAMES[session.harness ?? ""]
  if (harness !== undefined) {
    const u = session.harness_usage
    const login = `${harness} login, unpriced`
    return u ? `${tokens(u.input_tokens)} in · ${tokens(u.output_tokens)} out (${login})` : login
  }
  const { connection } = sessionModel(session, list)
  const subscription = list?.connections.find((c) => c.name === connection)?.method === "subscription"
  const free = "$0 on your subscription"
  if (session.cost === undefined) return subscription ? free : undefined
  const cost = session.cost_cap_usd == null ? usd(session.cost) : `${usd(session.cost)} of ${usd(session.cost_cap_usd)}`
  const part = session.subscription_cost ?? 0
  if (!subscription && part <= 0) return cost
  const paid = session.cost - part
  return `≈${cost} at API prices, ${part > 0 && paid >= 0.005 ? `${usd(paid)} paid` : free}`
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

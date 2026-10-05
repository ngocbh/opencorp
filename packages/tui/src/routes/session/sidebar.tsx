import type { ConnectionList, Session } from "@agent-corp/protocol"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { useOffice } from "../../context/office"
import { sessionModel } from "../../office/models"
import { useTuiPaths } from "../../context/runtime"
import { abbreviateHome } from "../../runtime"
import { personLabel } from "../../util/transcript"
import { getScrollAcceleration } from "../../util/scroll"

const usd = (n: number) => `$${n.toFixed(2)}`

/**
 * The session's cost against its cap, as `$0.12` or `$0.12 of $5.00`. On a subscription connection in `list` it adds
 * `(subscription, unpriced)`: the office records that connection's tokens at $0.
 */
export function costLabel(
  session: Pick<Session, "cost" | "cost_cap_usd" | "connection" | "model">,
  list?: ConnectionList,
) {
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
                <text fg={theme.textMuted}>{abbreviateHome(current().cwd, paths.home)}</text>
                <text fg={theme.textMuted}>
                  {current().status}
                  <Show when={costLabel(current(), office.connections())}>
                    {" "}
                    · {costLabel(current(), office.connections())}
                  </Show>
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

import type { BoxRenderable, RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { usePanel } from "../context/panel"
import { InteractivityProvider } from "../context/interactivity"
import { useTheme } from "../context/theme"
import { tint } from "../theme"

/**
 * The right pane's panel: its own interactivity scope, so only the focused side's keys and inputs run, and a click in
 * it focuses it. Unlike the upstream TUI's, it sits in a box in `color`, its driver's, so it reads as a layer over the
 * chat: bright while it has the keys, dim while the chat has them.
 */
export function PanelHost(props: {
  width: number
  focused: boolean
  color: RGBA
  onFocus: () => void
  onTarget: (node: BoxRenderable | undefined) => void
  children: JSX.Element
}) {
  const panels = usePanel()
  let node: BoxRenderable
  onMount(() => props.onTarget(node))
  onCleanup(() => props.onTarget(undefined))

  const Content = () => {
    const { theme } = useTheme()
    // Side panels sit on a raised surface; fullscreen takes over the base background.
    const background = () => (panels.presentation() === "panel" ? theme.backgroundPanel : theme.background)
    const border = () => (props.focused ? props.color : tint(theme.background, props.color, 0.4))
    return (
      <box
        id="session-panel"
        ref={(value: BoxRenderable) => (node = value)}
        flexGrow={1}
        minWidth={0}
        minHeight={0}
        focusable
        border
        borderStyle="single"
        borderColor={border()}
        focusedBorderColor={border()}
        backgroundColor={background()}
        onMouseDown={props.onFocus}
      >
        {props.children}
      </box>
    )
  }

  return (
    <InteractivityProvider enabled={props.focused}>
      <Content />
    </InteractivityProvider>
  )
}

import type { BoxRenderable, MouseEvent, RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { createSignal, onCleanup, onMount } from "solid-js"
import { usePanel } from "../context/panel"
import { InteractivityProvider } from "../context/interactivity"
import { useTheme } from "../context/theme"
import { tint } from "../theme"

/**
 * The right pane's panel: its own interactivity scope, so only the focused side's keys and inputs run, and a click in
 * it focuses it. Unlike the upstream TUI's, it sits in a box in `color`, its driver's, so it reads as a layer over the
 * chat: bright while it has the keys, dim while the chat has them. A `×` after its top-left corner, in the box's colour
 * and the text's under the mouse, closes it with a click, as `onClose` does.
 */
export function PanelHost(props: {
  width: number
  focused: boolean
  color: RGBA
  onFocus: () => void
  onClose: () => void
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
    const [closeHover, setCloseHover] = createSignal(false)
    // A press on the × neither moves the keys nor focuses the pane: only its release, closing the pane, counts.
    const hold = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
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
        {/* On the top edge, after the corner, out of the divider's reach: the handle takes the corner's column. */}
        <text
          position="absolute"
          top={-1}
          left={0}
          zIndex={2}
          width={1}
          fg={closeHover() ? theme.text : border()}
          selectable={false}
          onMouseOver={() => setCloseHover(true)}
          onMouseOut={() => setCloseHover(false)}
          onMouseDown={hold}
          onMouseUp={(event) => {
            event.stopPropagation()
            props.onClose()
          }}
        >
          ×
        </text>
      </box>
    )
  }

  return (
    <InteractivityProvider enabled={props.focused}>
      <Content />
    </InteractivityProvider>
  )
}

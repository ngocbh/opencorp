import { useTheme } from "../context/theme"
import type { createPaneResize } from "./pane-resize"

/** The two columns at a pane's edge that drag its width; the column on the `highlight` side lights up while hovered
 *  or dragged. */
export function PaneResizeHandle(props: {
  resize: ReturnType<typeof createPaneResize>
  left: number
  highlight?: "left" | "right"
}) {
  const { theme } = useTheme()

  return (
    <box
      position="absolute"
      left={props.left}
      top={0}
      zIndex={10}
      width={2}
      height="100%"
      onMouseOver={props.resize.onMouseOver}
      onMouseOut={props.resize.onMouseOut}
      onMouseDown={props.resize.onMouseDown}
    >
      <box
        width={1}
        height="100%"
        marginLeft={props.highlight === "right" ? 1 : 0}
        backgroundColor={props.resize.hovered() || props.resize.resizing() ? theme.borderActive : undefined}
      />
    </box>
  )
}

import { batch, createContext, createMemo, createSignal, useContext, type ParentProps } from "solid-js"
import { SESSION_PANEL_SPLIT_MIN_WIDTH } from "../ui/layout"

/** How the right pane shows: docked beside the chat, or full screen in its place. */
export type PanelPresentation = "panel" | "fullscreen"

/** What the right pane shows: instrument `id` of session `sessionID`, a shell or a Codex or Claude Code session. */
export type PanelTarget = {
  readonly id: string
  readonly sessionID: string
}

export function createPanelState() {
  const [current, setCurrent] = createSignal<PanelTarget>()
  const [requested, setRequested] = createSignal<PanelPresentation>("panel")
  const [width, setWidth] = createSignal(0)
  const canSplit = () => width() >= SESSION_PANEL_SPLIT_MIN_WIDTH
  const presentation = createMemo(() => (canSplit() ? requested() : "fullscreen"))
  return {
    current,
    width,
    canSplit,
    presentation,
    setWidth,
    open(target: PanelTarget, presentation: PanelPresentation = "panel") {
      batch(() => {
        setRequested(presentation)
        setCurrent((current) =>
          current?.id === target.id && current.sessionID === target.sessionID ? current : target,
        )
      })
    },
    close: () => setCurrent(),
    toggleFullscreen() {
      if (!canSplit()) return
      setRequested((current) => (current === "panel" ? "fullscreen" : "panel"))
    },
  }
}

const Context = createContext<ReturnType<typeof createPanelState>>()

export function PanelProvider(props: ParentProps) {
  return <Context.Provider value={createPanelState()}>{props.children}</Context.Provider>
}

export function usePanel() {
  const value = useContext(Context)
  if (!value) throw new Error("usePanel must be used within a PanelProvider")
  return value
}

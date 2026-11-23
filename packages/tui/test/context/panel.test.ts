// The right pane's state, ported from the upstream TUI with its tests: one panel at a time, split or full screen, and
// full screen forced below 108 columns without losing the choice. A panel here is an instrument of a session.
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPanelState } from "../../src/context/panel"
import { SESSION_PANEL_SPLIT_MIN_WIDTH } from "../../src/ui/layout"

test("presentation changes preserve the selected panel identity", () => {
  createRoot((dispose) => {
    const panels = createPanelState()
    panels.setWidth(160)
    panels.open({ id: "shell", sessionID: "session" })
    const current = panels.current()
    expect(panels.presentation()).toBe("panel")
    panels.toggleFullscreen()
    expect(panels.presentation()).toBe("fullscreen")
    expect(panels.current()).toBe(current)
    panels.toggleFullscreen()
    expect(panels.presentation()).toBe("panel")
    expect(panels.current()).toBe(current)
    panels.open({ id: "shell", sessionID: "session" })
    expect(panels.current()).toBe(current)
    dispose()
  })
})

test("narrow geometry overrides presentation without discarding the user's choice", () => {
  createRoot((dispose) => {
    const panels = createPanelState()
    panels.open({ id: "shell", sessionID: "session" })
    panels.setWidth(SESSION_PANEL_SPLIT_MIN_WIDTH - 1)
    expect(SESSION_PANEL_SPLIT_MIN_WIDTH).toBe(108)
    expect(panels.canSplit()).toBe(false)
    expect(panels.presentation()).toBe("fullscreen")
    panels.toggleFullscreen()
    panels.setWidth(SESSION_PANEL_SPLIT_MIN_WIDTH)
    expect(panels.canSplit()).toBe(true)
    expect(panels.presentation()).toBe("panel")
    panels.toggleFullscreen()
    panels.setWidth(60)
    panels.setWidth(160)
    expect(panels.presentation()).toBe("fullscreen")
    dispose()
  })
})

test("opening a different instrument changes the panel selection, and close empties it", () => {
  createRoot((dispose) => {
    const panels = createPanelState()
    panels.open({ id: "shell 1", sessionID: "session" })
    const current = panels.current()
    panels.open({ id: "codex 1", sessionID: "session" })
    expect(panels.current()).not.toBe(current)
    expect(panels.current()?.id).toBe("codex 1")
    panels.open({ id: "codex 1", sessionID: "other" })
    expect(panels.current()).toEqual({ id: "codex 1", sessionID: "other" })
    panels.close()
    expect(panels.current()).toBeUndefined()
    dispose()
  })
})

test("opening in full screen asks for it, and a later open asks again", () => {
  createRoot((dispose) => {
    const panels = createPanelState()
    panels.setWidth(160)
    panels.open({ id: "shell", sessionID: "session" }, "fullscreen")
    expect(panels.presentation()).toBe("fullscreen")
    panels.open({ id: "shell", sessionID: "session" })
    expect(panels.presentation()).toBe("panel")
    dispose()
  })
})

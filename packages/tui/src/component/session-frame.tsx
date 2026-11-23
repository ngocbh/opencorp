import {
  CliRenderEvents,
  RGBA,
  MouseEvent,
  type BoxRenderable,
  type Renderable,
  type ScrollBoxRenderable,
} from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { Instrument, Message } from "@opencorp/protocol"
import { isInstrumentNote } from "@opencorp/protocol"
import { openQuestions } from "@opencorp/client"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js"
import { useTuiConfig } from "../config"
import { InteractivityProvider } from "../context/interactivity"
import { useKV } from "../context/kv"
import { useLocal } from "../context/local"
import { useOffice } from "../context/office"
import { usePanel, type PanelPresentation } from "../context/panel"
import { PromptRefProvider, usePromptRef } from "../context/prompt"
import { useRoute } from "../context/route"
import { useBindings, useCommandShortcut, useOpenCorpKeymap } from "../keymap"
import { Session } from "../routes/session"
import { childState } from "../routes/session/composer/tabs"
import { InstrumentPanel, InstrumentScreen, type Driver } from "../routes/session/instrument-view"
import { endsLine } from "../routes/session/keys"
import { Sidebar } from "../routes/session/sidebar"
import { sessionOwner } from "../routes/session/speakers"
import { LIVE } from "../routes/session/terminal-pane"
import { useDialog } from "../ui/dialog"
import { clampSessionPaneWidth, SESSION_SIDEBAR_WIDTH } from "../ui/layout"
import { createPaneResize } from "../ui/pane-resize"
import { PaneResizeHandle } from "../ui/pane-resize-handle"
import { Toast } from "../ui/toast"
import { display } from "../util/printable"
import { interruptible } from "../util/status"
import { PanelHost } from "./panel-host"

/**
 * A chat and its one right pane, the upstream TUI's session frame. The pane shows an instrument of the chat, a shell
 * or a Codex or Claude Code session, else the sidebar. It is docked beside the chat, its width dragged with the handle
 * on the divider and kept on disk for every pane, or full screen, which a screen under 108 columns forces. The keys
 * go to one side at a time: a click, or <leader>left and <leader>right, moves them, and a pane never takes them while
 * the owner types elsewhere. Under 108 columns a pane without the keys waits, so it never covers a draft or a card.
 */
export function SessionFrame(props: { sessionID: string }) {
  const prompt = usePromptRef()
  const office = useOffice()
  const local = useLocal()
  const kv = useKV()
  const tuiConfig = useTuiConfig()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const panels = usePanel()
  const dialog = useDialog()
  const keymap = useOpenCorpKeymap()
  const { navigate } = useRoute()
  const showKey = useCommandShortcut("pane.focus.right")
  const availableWidth = () => dimensions().width
  const defaultPaneWidth = () => Math.max(1, Math.floor(panels.width() / 2))
  // One width for every pane, kept on disk; none until the handle is first dragged.
  const paneWidth = (): number | undefined => kv.get("pane_width")
  // Only a toggle that took effect is kept, so a narrow screen's full screen doesn't become the choice.
  const fullscreenChoice = (): boolean => kv.get("pane_fullscreen", false)
  const paneResize = createPaneResize({
    value: () => paneWidth() ?? defaultPaneWidth(),
    defaultValue: defaultPaneWidth,
    clamp: (width) => clampSessionPaneWidth(width, panels.width()),
    fromMouse: (event) => dimensions().width - event.x - 1,
    contains: (event, width) => event.x >= dimensions().width - width - 1 && event.x <= dimensions().width - width,
    onCommit: (width) => kv.set("pane_width", width),
  })
  let resizeRelease = false
  const finishPaneResize = (event: MouseEvent) => {
    if (paneResize.resizing()) {
      // A captured drag-end can be followed by mouse-up on the focus overlay.
      resizeRelease = true
      queueMicrotask(() => {
        resizeRelease = false
      })
    }
    paneResize.onMouseUp(event)
  }
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [sessionWidth, setSessionWidth] = createSignal<number>()
  const [activePane, setActivePane] = createSignal<"session" | "right">("session")
  let focusTerminal: (() => void) | undefined
  let showPicker: (() => void) | undefined
  let sessionScroll: ScrollBoxRenderable | undefined
  let sessionNode: BoxRenderable | undefined
  let rightNode: BoxRenderable | undefined
  let panelNode: BoxRenderable | undefined

  const session = createMemo(() => office.state.sessions.find((s) => s.id === props.sessionID))
  // An ended or failed shell stays in the list, with its scrollback, until the session next goes idle.
  const [retired, setRetired] = createSignal<ReadonlySet<string>>(new Set())
  const listed = () => office.state.instruments[props.sessionID] ?? []
  const shells = createMemo(() => listed().filter((i) => i.kind === "terminal" && !retired().has(i.id)))
  createEffect(
    on(
      () => session()?.status,
      (status, prev) => {
        if (status !== "idle" || prev === undefined || prev === "idle") return
        const ended = listed().filter((i) => i.kind === "terminal" && (i.status === "ended" || i.status === "failed"))
        if (ended.length) setRetired((r) => new Set([...r, ...ended.map((i) => i.id)]))
      },
    ),
  )
  // What the pane can show: the chat's shells and its Codex and Claude Code sessions.
  const instruments = createMemo(() => [...shells(), ...listed().filter((i) => i.kind !== "terminal")])

  const activePanel = createMemo(() => {
    const current = panels.current()
    if (current?.sessionID === props.sessionID) return current
  })
  // The open instrument, kept while it closes.
  const panelInstrument = createMemo<Instrument | undefined>((last) => {
    const id = activePanel()?.id
    if (!id) return undefined
    return instruments().find((i) => i.id === id) ?? (last?.id === id ? last : undefined)
  })
  // Under 108 columns the pane can only show full screen, which would hide the chat: without the keys, it waits.
  const parked = createMemo(() => activePanel() !== undefined && !panels.canSplit() && activePane() !== "right")
  const shown = () => activePanel() !== undefined && !parked()
  const fullscreen = () => shown() && panels.presentation() === "fullscreen"
  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (sidebarOpen()) return true
    return sidebar() === "auto" && wide()
  })
  const rightPane = createMemo(() => {
    if (shown()) return "panel"
    if (sidebarVisible()) return "sidebar"
  })
  const toggleSidebar = () => {
    batch(() => {
      const visible = rightPane() === "sidebar"
      setSidebar(() => (visible ? "hide" : "auto"))
      setSidebarOpen(!visible)
      if (!visible && activePanel()) closePanel()
    })
  }

  // The session's approver, the one person whose keys its shells take (`sessionOwner`). Whether that is who this TUI
  // acts as.
  const approver = () => sessionOwner(session(), office.state.people)
  const approving = () => !!office.person && office.person === approver()
  // Whether the owner has typed text into the open shell since their last Enter, Ctrl-C or Ctrl-D.
  const [midLine, setMidLine] = createSignal(false)
  // Whether the open instrument opened itself, for a password, and so closes itself once that is done.
  const [itself, setItself] = createSignal(false)
  // A pane that goes while the owner is mid-line in its shell, however it goes, leaves the rest of that line (a
  // password's, perhaps) going nowhere: the keys are dropped until its Enter, Ctrl-C or Ctrl-D, and only then does
  // the chat get them.
  const [dropping, setDropping] = createSignal(false)

  const focusSession = () => {
    // Full screen leaves no chat, unless it is a narrow screen's, which waits once the chat has the keys.
    if (fullscreen() && panels.canSplit()) return
    // Cards replace the input, so returning focus must not depend on it.
    if (activePane() === "right") renderer.currentFocusedRenderable?.blur()
    setActivePane("session")
    if (!dropping()) prompt.current?.focus()
  }
  const focusRightPane = () => {
    const current = renderer.currentFocusedRenderable
    if (current && within(current, sessionNode)) current.blur()
    setActivePane("right")
    // The focused shell's screen, or the session's prompt, takes the keys as it gains them.
    if (within(renderer.currentFocusedRenderable, panelNode)) return
    if (focusTerminal) return focusTerminal()
    panelNode?.focus()
  }
  // A click or the pane's keys move the keys between the sides. Focus that lands on the side without them (a dialog
  // handing it back to what had it when it opened) goes back to the side that has them.
  const onFocused = () => {
    const current = renderer.currentFocusedRenderable
    if (!current) return
    const stray =
      activePane() === "right" ? within(current, sessionNode) : rightPane() === "panel" && within(current, rightNode)
    if (!stray) return
    current.blur()
    if (dialog.stack.length > 0) return
    if (activePane() === "right") focusRightPane()
    else focusSession()
  }
  renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, onFocused)
  onCleanup(() => renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, onFocused))
  createEffect(() => {
    if (fullscreen()) focusRightPane()
  })
  createEffect(() => {
    if (rightPane() !== "panel") setActivePane("session")
  })

  // While they are dropped, no key reaches either side.
  onCleanup(
    keymap.intercept(
      "key",
      ({ event, consume }) => {
        if (!dropping()) return
        consume()
        if (!endsLine(event)) return
        setDropping(false)
        prompt.current?.focus()
      },
      { priority: 200 },
    ),
  )
  /** Starts dropping the owner's keys when the open pane goes while they are mid-line in its shell. */
  function leaving() {
    if (untrack(midLine)) setDropping(true)
  }

  /** Opens instrument `id` in the pane, with the keys and in the presentation last chosen; or, with `keys` false,
   *  beside the chat (waiting, on a narrow screen), the keys staying where they are: a pane never takes them while
   *  the owner types elsewhere. */
  function openPanel(id: string, keys = true) {
    const current = activePanel()
    if (current && current.id !== id) leaving()
    setItself(false)
    const presentation: PanelPresentation = keys && fullscreenChoice() ? "fullscreen" : "panel"
    batch(() => {
      panels.open({ id, sessionID: props.sessionID }, presentation)
      if (keys) setActivePane("right")
    })
    // The same panel stays mounted, so it takes the keys here rather than as it mounts.
    if (current?.id === id && keys) focusRightPane()
  }
  /** Opens instrument `id`, the frame's own or another chat's: a sibling of the Codex or Claude Code session this
   *  frame shows goes to the chat that lists it, with it in that chat's pane. A session no chat lists (one that ended
   *  before the office restarted) opens as its own chat, read-only once it has ended. */
  function openInstrument(id: string) {
    if (instruments().some((i) => i.id === id)) return openPanel(id)
    const chat = Object.keys(office.state.instruments).find((sid) =>
      office.state.instruments[sid]?.some((i) => i.id === id),
    )
    batch(() => {
      navigate({ type: "session", sessionID: chat ?? id })
      if (chat) panels.open({ id, sessionID: chat }, fullscreenChoice() ? "fullscreen" : "panel")
    })
  }
  /** Closes the pane; the chat gets the keys, once the owner has ended a line they were typing into it. */
  function closePanel() {
    if (!activePanel()) return
    leaving()
    setItself(false)
    focusSession()
    panels.close()
  }
  function toggleFullscreen() {
    if (!activePanel()) {
      const shell = cardShell()
      if (shell) openPanel(shell.id, false)
      return
    }
    const before = panels.presentation()
    panels.toggleFullscreen()
    if (panels.presentation() !== before) kv.set("pane_fullscreen", panels.presentation() === "fullscreen")
  }

  // It closes when it leaves the list: its host removed it, or its turn ended after it did.
  createEffect(() => {
    const id = activePanel()?.id
    if (id && !instruments().some((i) => i.id === id)) untrack(closePanel)
  })

  // A PTY shell waiting for the approver's password opens itself when no pane is open. It takes the keys only while
  // the owner types nowhere else, so the password can't go to the chat and on to the model; with a draft in the prompt
  // or a card open, it opens beside the chat (waiting, on a narrow screen) and the owner gives it the keys. It closes
  // once the wait ends and the owner has finished the line they were typing into it, a password's rest that must not
  // reach the chat, unless the owner has since opened something else.
  const secretWait = (i: Instrument) => i.interactive && i.status === "waiting" && i.waiting === "secret"
  const typingElsewhere = () =>
    !!prompt.current?.current.input || openQuestions(office.state, props.sessionID).length > 0
  createEffect(
    on(
      () => (approving() ? shells().find(secretWait)?.id : undefined),
      (id) => {
        if (!id || untrack(activePanel)) return
        openPanel(id, !untrack(typingElsewhere))
        setItself(true)
      },
    ),
  )
  createEffect(() => {
    if (!itself()) return
    const shell = panelInstrument()
    if (shell && (secretWait(shell) || midLine())) return
    untrack(closePanel)
  })

  /** The live shell the open approval card's terminal command would run in, if it names one. */
  const cardShell = createMemo(() => {
    const question = openQuestions(office.state, props.sessionID)[0]
    const held = question?.source === "approval" && session()?.harness !== "codex" ? question.approval : undefined
    if (!held || (held.tool !== "terminal_run" && held.tool !== "terminal_type")) return undefined
    const name = held.args?.shell
    return shells().find((i) => i.name === name && LIVE.includes(i.status))
  })

  // Who is at the controls of the open instrument: the owner while they type into the shell, or while the harness
  // runs a turn the owner's message started; otherwise its driver, the employee.
  const driver = createMemo<Driver | undefined>(() => {
    const instrument = panelInstrument()
    if (!instrument) return undefined
    const owner = approver()
    const you = instrument.kind === "terminal" ? activePane() === "right" && midLine() : ownersTurn(instrument.id)
    const handle = you ? owner : instrument.driver
    return { you, handle, color: local.person.color(handle) }
  })
  /** Whether Codex or Claude Code session `id` runs a turn its owner's message started. */
  function ownersTurn(id: string) {
    const child = office.state.sessions.find((s) => s.id === id)
    if (!child || !interruptible(child.status)) return false
    const last = (office.state.messages[id] ?? []).findLast((m: Message) => m.role === "user" && !isInstrumentNote(m))
    const owner = approver()
    return !!last && (!last.author || last.author === owner)
  }
  // Whether the open instrument takes typing: a live terminal, or a session whose prompt is still open.
  const takesTyping = () => {
    const instrument = panelInstrument()
    if (!instrument) return false
    if (instrument.kind === "terminal") return instrument.interactive && LIVE.includes(instrument.status)
    return childState(office.state.sessions.find((s) => s.id === instrument.id), instrument) !== "ended"
  }

  /** Goes from the session in the pane back to the chat: its keys, or, full screen, the pane closed. */
  const leavePane = () => (fullscreen() && panels.canSplit() ? closePanel() : focusSession())
  // A frame that mounts with its pane open, as a sibling's row opens it from another chat, gives it the keys.
  if (untrack(activePanel)) setActivePane("right")
  /** The line in the chat for a pane that waits. */
  const paneNote = () => {
    const instrument = parked() ? panelInstrument() : undefined
    return instrument && `${display(instrument.name)} is open in the pane: ${showKey()} shows it`
  }

  /** Focuses the chat and opens its picker, as the upstream TUI's terminal select does. */
  function selectInstrument() {
    if (fullscreen()) closePanel()
    focusSession()
    showPicker?.()
  }

  useBindings(() => ({
    priority: 2,
    enabled: dialog.stack.length === 0,
    commands: [
      {
        name: "pane.focus.left",
        title: "Give the chat the keys, the pane staying open",
        category: "Session",
        hidden: true,
        enabled: activePane() === "right" && (!fullscreen() || !panels.canSplit()),
        run: focusSession,
      },
      {
        name: "pane.focus.right",
        title: "Give the pane the keys",
        category: "Session",
        hidden: true,
        enabled: activePanel() !== undefined,
        run: focusRightPane,
      },
      {
        name: "pane.select",
        title: "Open the picker of the chat's sessions and shells",
        category: "Session",
        hidden: true,
        enabled: openQuestions(office.state, props.sessionID).length === 0,
        run: selectInstrument,
      },
      {
        name: "pane.close",
        title: "Close the pane",
        category: "Session",
        hidden: true,
        enabled: activePanel() !== undefined,
        run: closePanel,
      },
      {
        name: "pane.fullscreen",
        title: "Show the pane full screen, or beside the chat",
        category: "Session",
        hidden: true,
        enabled: activePanel() !== undefined || cardShell() !== undefined,
        run: toggleFullscreen,
      },
      {
        name: "pane.dismiss",
        title: "Close a pane that takes no typing",
        category: "Session",
        hidden: true,
        enabled: activePanel() !== undefined && activePane() === "right" && !takesTyping(),
        run: closePanel,
      },
    ],
    bindings: tuiConfig.keybinds.gather("pane", [
      "pane.focus.left",
      "pane.focus.right",
      "pane.select",
      "pane.close",
      "pane.fullscreen",
      "pane.dismiss",
    ]),
  }))

  // Pane management stays reachable from either input scope.
  useBindings(() => ({
    commands: [
      {
        namespace: "palette",
        name: "session.sidebar.toggle",
        title: rightPane() === "sidebar" ? "Hide sidebar" : "Show sidebar",
        category: "Session",
        run: () => {
          toggleSidebar()
          dialog.clear()
        },
      },
    ],
    bindings: tuiConfig.keybinds.gather("session.sidebar", ["session.sidebar.toggle"]),
  }))

  return (
    <box
      flexGrow={1}
      minWidth={0}
      minHeight={0}
      flexDirection="row"
      position="relative"
      onMouseDrag={paneResize.onMouseDrag}
      onMouseDragEnd={finishPaneResize}
      onMouseUp={finishPaneResize}
    >
      <box
        id="session-pane"
        ref={(value: BoxRenderable) => (sessionNode = value)}
        flexGrow={1}
        flexBasis={0}
        minWidth={0}
        minHeight={0}
        position={fullscreen() ? "absolute" : "relative"}
        visible={!fullscreen()}
        width={fullscreen() ? Math.max(0, panels.width() - paneResize.size()) : undefined}
        height="100%"
        onSizeChange={function () {
          setSessionWidth(this.width)
        }}
      >
        <InteractivityProvider enabled={activePane() === "session" && !fullscreen()}>
          <Session
            sessionID={props.sessionID}
            scrollRef={(value) => (sessionScroll = value)}
            width={sessionWidth()}
            shells={shells()}
            visibleID={activePanel()?.id}
            onOpen={openInstrument}
            onPicker={(show) => (showPicker = show)}
            keysDropped={dropping()}
            paneNote={paneNote()}
          />
        </InteractivityProvider>
        {/* While the pane has the keys, a click in the chat gives them back. */}
        <Show when={activePane() === "right"}>
          <box
            position="absolute"
            left={0}
            top={0}
            width="100%"
            height="100%"
            zIndex={1}
            onMouseScroll={(event) => {
              if (!sessionScroll || sessionScroll.isDestroyed) return
              const viewport = sessionScroll.viewport
              if (event.x < viewport.x || event.x >= viewport.x + viewport.width) return
              if (event.y < viewport.y || event.y >= viewport.y + viewport.height) return
              // Keep the focus-only click guard, but let the transcript handle its own wheel events.
              event.stopPropagation()
              sessionScroll.processMouseEvent(new MouseEvent(sessionScroll, event))
            }}
            // Consume the release before revealing permission buttons underneath.
            onMouseUp={() => {
              if (paneResize.resizing() || resizeRelease) return
              focusSession()
            }}
          />
        </Show>
      </box>
      <Show when={rightPane() === "panel" || (rightPane() === "sidebar" && wide())}>
        <box
          ref={(value: BoxRenderable) => (rightNode = value)}
          flexShrink={0}
          width={
            fullscreen() ? availableWidth() : rightPane() === "sidebar" ? SESSION_SIDEBAR_WIDTH : paneResize.size()
          }
          minWidth={0}
          minHeight={0}
        >
          <Show
            when={rightPane() === "sidebar"}
            fallback={
              <Show keyed when={shown() ? activePanel() : undefined}>
                {(item) => (
                  <Show when={panelInstrument()}>
                    {(instrument) => (
                      <PanelHost
                        width={fullscreen() ? availableWidth() : paneResize.size()}
                        focused={activePane() === "right"}
                        color={driver()!.color}
                        onFocus={focusRightPane}
                        onTarget={(node) => {
                          panelNode = node
                          if (node && activePane() === "right") focusRightPane()
                        }}
                      >
                        <InstrumentPanel
                          instrument={instrument()}
                          driver={driver()!}
                          focused={activePane() === "right"}
                          approver={approving()}
                          dismissable={!takesTyping()}
                        >
                          <Show
                            when={instrument().kind === "terminal"}
                            fallback={
                              <PromptRefProvider drafts={prompt.drafts}>
                                <Session
                                  sessionID={item.id}
                                  pane={{ close: closePanel, leave: leavePane }}
                                  width={(fullscreen() ? availableWidth() : paneResize.size()) - 2}
                                  onOpen={openInstrument}
                                />
                              </PromptRefProvider>
                            }
                          >
                            <InstrumentScreen
                              sessionID={props.sessionID}
                              instrument={instrument()}
                              // A dialog over it has the keys while it shows.
                              focused={activePane() === "right" && dialog.stack.length === 0}
                              color={driver()!.color}
                              onFocusRequest={(focus) => (focusTerminal = focus)}
                              onLine={setMidLine}
                            />
                          </Show>
                        </InstrumentPanel>
                      </PanelHost>
                    )}
                  </Show>
                )}
              </Show>
            }
          >
            <Sidebar sessionID={props.sessionID} />
          </Show>
        </box>
      </Show>
      <Show when={!fullscreen() && rightPane() === "panel" && availableWidth() >= 3}>
        <PaneResizeHandle resize={paneResize} left={availableWidth() - paneResize.size() - 1} highlight="right" />
      </Show>
      <Show when={rightPane() === "sidebar" && !wide()}>
        <box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          alignItems="flex-end"
          backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
        >
          <Sidebar sessionID={props.sessionID} />
        </box>
      </Show>
      {/* Over the pane too; in a column the width of the screen, as the chat is, so it lays out as it did there. It
          has no height: clicks pass by. */}
      <box position="absolute" left={0} top={0} width="100%" zIndex={2500}>
        <Toast />
      </box>
    </box>
  )
}

function within(node: Renderable | null | undefined, root: Renderable | undefined) {
  if (!root) return false
  for (let current = node; current; current = current.parent) {
    if (current === root) return true
  }
  return false
}

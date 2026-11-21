import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  untrack,
  useContext,
} from "solid-js"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import type { ErrorPart, FilePart, Instrument, Message, Part, TextPart, ToolPart } from "@opencorp/protocol"
import { createTwoFilesPatch } from "diff"
import { useRoute, useRouteData } from "../../context/route"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths } from "../../context/runtime"
import { Spinner } from "../../component/spinner"
import { useTheme } from "../../context/theme"
import {
  BoxRenderable,
  CliRenderEvents,
  MouseEvent,
  ScrollBoxRenderable,
  TextAttributes,
  RGBA,
  type Renderable,
} from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import { Locale } from "../../util/locale"
import { Dynamic, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogMessage } from "./dialog-message"
import { DialogMode } from "./dialog-mode"
import { DialogRules } from "./dialog-rules"
import { PermissionPrompt } from "./permission"
import { costLabel, Sidebar } from "./sidebar"
import { filetype } from "../../util/filetype"
import { errorMessage } from "../../util/error"
import { interruptible } from "../../util/status"
import { Toast, useToast } from "../../ui/toast"
import { useCostCap } from "../../component/cost-cap"
import { useKV } from "../../context/kv.tsx"
import { usePromptRef } from "../../context/prompt"
import { useEpilogue } from "../../context/epilogue"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript, outputText, personLabel } from "../../util/transcript"
import { sessionEpilogue } from "../../util/presentation"
import { setPreLayoutSiblingMargin } from "../../util/layout"
import { useTuiConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseShellOutput, collapseToolOutput } from "../../util/collapse-tool-output"
import { OPENCORP_BASE_MODE, useBindings, useOpenCorpKeymap } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { useOffice } from "../../context/office"
import { usePermission } from "../../context/permission"
import { modelLabel, OfficeError, OfficeUnavailable, isNotImplemented, openQuestions, statusLabel } from "@opencorp/client"
import { answerShown } from "../chat/answer"
import { QuestionCard } from "../chat/card"
import { HarnessCard } from "../chat/harness-card"
import { SideChat, SideHeader } from "../chat/side"
import { freeze, frozenList, unfreeze, type Freeze } from "../chat/freeze"
import { display } from "../../util/printable"
import { InteractivityProvider } from "../../context/interactivity"
import { clampPaneWidth, createPaneResize } from "../../ui/pane-resize"
import { PaneResizeHandle } from "../../ui/pane-resize-handle"
import { DialogInstruments, DialogInstrumentView } from "./dialog-instruments"
import { waitingInstrument } from "./instrument-line"
import { InstrumentView, nextPlacement, PLACEMENTS, type InstrumentPlacement } from "./instrument-view"
import { childSessions, InstrumentFooter } from "./instrument-footer"
import { endsLine } from "./keys"
import { LIVE } from "./terminal-pane"

export const alwaysSeparate = new WeakSet<BoxRenderable>()

const sessionBindingCommands = [
  "session.sidebar.toggle",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.generic_tool_output",
  "session.first",
  "session.last",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
  "session.parent",
  "session.child.next",
  "session.child.previous",
] as const

const sessionGlobalBindingCommands = [
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
] as const

const sessionGlobalUnfocusedBindingCommands = ["session.first", "session.last"] as const

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  tui: ReturnType<typeof useTuiConfig>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

/** Whether a message has a text part with more than whitespace: the view draws nothing for a blank one. */
function hasText(message: Message) {
  return message.parts.some((part) => part.type === "text" && part.text.trim())
}

/** The ids of a transcript's assistant messages. */
function assistantIds(list: Message[]): Record<string, true> {
  return Object.fromEntries(list.flatMap((m) => (m.role === "assistant" ? [[m.id, true]] : [])))
}

/** The text of a message's text parts, joined. */
function messageText(message: Message) {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
}

export function Session() {
  const setEpilogue = useEpilogue()
  const clipboard = useClipboard()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const office = useOffice()
  const paths = useTuiPaths()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => office.state.sessions.find((s) => s.id === route.sessionID))
  const cards = createMemo(() => openQuestions(office.state, route.sessionID))
  const question = createMemo(() => cards()[0])
  // A Codex session shows every open card above a prompt that stays; the first card or the prompt has the keys.
  const codex = createMemo(() => session()?.harness === "codex")
  // The open card is an approval card, which shows as the permission prompt.
  const approval = createMemo(() => !codex() && question()?.source === "approval")
  // A card on the chat (an approval, a question), which takes what room it needs and scrolls in the rest.
  const card = createMemo(() => !codex() && question() !== undefined)
  const permission = usePermission()
  // Whether the chat's mode can be switched here. Never while a card is open: the card hides the prompt and its mode
  // label, and a switch to dontAsk would answer an approval card.
  const switchable = () => permission.mode(route.sessionID) !== null && !question()
  const [focus, setFocus] = createSignal<"card" | "prompt">("card")
  const cardFocused = createMemo(() => codex() && cards().length > 0 && focus() === "card")
  // Cards opening when none were open take the keys, unless the prompt holds a draft: keys typed for the prompt must
  // never land on a card, where a digit or Enter picks an option.
  createEffect(
    on(
      () => cards().length > 0,
      (open) => open && setFocus(promptRef.current?.current.input ? "prompt" : "card"),
    ),
  )
  // The card whose side chat is showing; the view shows the side session in place of the chat.
  const [sideOf, setSideOf] = createSignal<string>()
  const sideQuestion = createMemo(() => {
    const q = question()
    return q && q.id === sideOf() ? q : undefined
  })
  const sideSession = createMemo(() => office.state.sessions.find((s) => s.id === sideQuestion()?.side_session_id))
  // Until its first message the side session doesn't exist, so the side view starts empty.
  const viewID = createMemo(() => (sideOf() ? sideQuestion()?.side_session_id : route.sessionID))
  const messages = createMemo(() => {
    const id = viewID()
    return id ? (office.state.messages[id] ?? []) : []
  })
  // Esc freezes what the transcript shows until the next message is sent.
  const [frozen, setFrozen] = createSignal<Freeze>()
  const shown = createMemo(() => frozenList(frozen(), messages()))
  const viewSession = createMemo(() => office.state.sessions.find((s) => s.id === viewID()))
  const viewStatus = createMemo(() => viewSession()?.status)
  /**
   * The viewed session's assistant messages from before its current (or next) turn began. Esc
   * stops that turn, and what a later turn writes after a message sent before Esc still shows.
   */
  let turnStart: Record<string, true> | undefined
  createEffect(
    on(
      viewID,
      () => {
        setFrozen(undefined)
        turnStart = undefined
      },
      { defer: true },
    ),
  )
  // The next turn starts after everything the one that just ended wrote. A turn ends when the
  // session stops working, or when its finished replies grow: a steer the reply didn't read
  // starts the next turn at once, with no idle between.
  createEffect(
    on(
      () => [viewID(), interruptible(viewStatus()), viewSession()?.turns ?? 0] as const,
      ([id, live, turns], prev) => {
        if (!prev || prev[0] !== id) return
        if ((prev[1] && !live) || turns > prev[2]) turnStart = assistantIds(messages())
      },
      { defer: true },
    ),
  )
  /** Esc: freezes the view; the turn after the stopped one starts from what it shows now. */
  function interrupt() {
    // A Codex steer joins the live turn, so the next message after it can still be the stopped turn's.
    setFrozen(freeze(messages(), frozen(), codex() ? undefined : turnStart))
    turnStart = assistantIds(messages())
  }
  /**
   * Ends the freeze as the user sends, before the office answers, so the new reply's first
   * message shows even if it streams in first; returns an undo for a send that fails.
   */
  function lift() {
    const start = turnStart
    // A message to a session between turns starts one.
    if (!interruptible(viewStatus())) turnStart = assistantIds(messages())
    const started = turnStart
    const f = frozen()
    const lifted = f?.active ? unfreeze(f, messages()) : undefined
    const view = viewID()
    if (lifted) setFrozen(lifted)
    // A newer Esc, or a switch to or from the side view, has since replaced the lifted freeze.
    return () => {
      if (viewID() !== view) return
      if (turnStart === started) turnStart = start
      if (lifted && frozen() === lifted) setFrozen(f)
    }
  }
  // The side chat closes with its question.
  createEffect(() => {
    if (sideOf() && !sideQuestion()) setSideOf(undefined)
  })
  const person = createMemo(() => personLabel(office.state.people, session()?.person ?? ""))

  createEffect(() => {
    const current = session()
    setEpilogue(sessionEpilogue({ title: current ? `${person()} · ${current.cwd}` : "", sessionID: current?.id }))
  })
  onCleanup(() => setEpilogue())

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

  // This device's choice of how an instrument opens; the open one, how it shows and whether it opened itself; and
  // whether it has the keys.
  const [instrumentView, setInstrumentView] = kv.signal<InstrumentPlacement>("instrument_view", "floating")
  const defaultPlacement = () => (PLACEMENTS.includes(instrumentView()) ? instrumentView() : "floating")
  const [opened, setOpened] = createSignal<{ id: string; view: InstrumentPlacement; itself?: true } | null>(null)
  const [instrumentFocused, setInstrumentFocused] = createSignal(false)
  const split = () => opened()?.view === "split"
  // The chat's own keys, which the open instrument mutes while it has the keys, as the provider mutes the chat's view.
  const chatKeys = () => !instrumentFocused()
  // A split starts at half the screen; its handle drags it.
  const [paneWidth, setPaneWidth] = createSignal<number>()
  const defaultPaneWidth = () => Math.max(1, Math.floor(dimensions().width / 2))
  const paneResize = createPaneResize({
    value: () => paneWidth() ?? defaultPaneWidth(),
    defaultValue: defaultPaneWidth,
    clamp: (width) => clampPaneWidth(width, dimensions().width),
    fromMouse: (event) => dimensions().width - event.x - 1,
    contains: (event, width) => event.x >= dimensions().width - width - 1 && event.x <= dimensions().width - width,
    onCommit: (width) => setPaneWidth(width),
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
  /** Where the open instrument sits: 80% of the screen, centred, floating; the right pane of a split; or all of the
   *  screen but the line under the prompt and the row below it. */
  const placement = createMemo(() => {
    const { width, height } = dimensions()
    const view = opened()?.view
    if (view === "split") return { width: paneResize.size(), height: undefined, left: undefined, top: undefined }
    if (view === "full") return { width, height: Math.max(1, height - 2), left: 0, top: 0 }
    const w = Math.floor(width * 0.8)
    const h = Math.floor(height * 0.8)
    return { width: w, height: h, left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2) }
  })
  // An ended or failed shell stays in the list, with its scrollback, until the session next goes idle.
  const [retired, setRetired] = createSignal<ReadonlySet<string>>(new Set())
  const instruments = createMemo(() =>
    (office.state.instruments[route.sessionID] ?? []).filter((i) => i.kind === "terminal" && !retired().has(i.id)),
  )
  createEffect(
    on(
      () => session()?.status,
      (status, prev) => {
        if (status !== "idle" || prev === undefined || prev === "idle") return
        const ended = (office.state.instruments[route.sessionID] ?? []).filter(
          (i) => i.status === "ended" || i.status === "failed",
        )
        if (ended.length) setRetired((r) => new Set([...r, ...ended.map((i) => i.id)]))
      },
    ),
  )
  // The chat's Codex sessions, each its own child session, which open as a chat; in a child, its chat and siblings.
  const harnesses = createMemo(() =>
    (office.state.instruments[route.sessionID] ?? []).filter((i) => i.kind !== "terminal"),
  )
  const parentID = createMemo(() => session()?.instrument_of ?? undefined)
  const children = createMemo(() => childSessions(office.state.sessions, parentID() ?? route.sessionID))
  // The store may not hold a child yet (it holds the latest sessions): the chat's list names it too.
  const firstChild = () => children()[0]?.id ?? harnesses()[0]?.id
  /** Opens child session `sessionID` in place of this chat. */
  function enterChild(sessionID: string) {
    dialog.clear()
    navigate({ type: "session", sessionID })
  }
  /** Moves to the next (1) or previous (-1) Codex session of the chat, round its list. */
  function moveChild(direction: number) {
    const list = children()
    if (list.length < 2) return
    const at = list.findIndex((s) => s.id === route.sessionID)
    const next = list[(at + direction + list.length) % list.length]
    if (next) enterChild(next.id)
  }
  // The open instrument, kept while it closes.
  const openInstrument = createMemo<Instrument | undefined>((last) => {
    const id = opened()?.id
    if (!id) return undefined
    return instruments().find((i) => i.id === id) ?? (last?.id === id ? last : undefined)
  })
  // It closes when it leaves the list: its host removed it, or its turn ended after it did.
  createEffect(() => {
    const id = opened()?.id
    if (id && !instruments().some((i) => i.id === id)) closeInstrument()
  })
  // The session's approver, the one person whose keys its shells take: who opened it, else the CEO, the company's
  // human at the top of the org chart; with more than one there, it isn't known. Whether that is who this TUI acts as.
  const approver = () => {
    const opener = session()?.opened_by
    if (opener) return opener
    const top = office.state.people.filter((p) => p.kind === "human" && !p.manager)
    return top.length === 1 ? top[0]!.handle : undefined
  }
  const approving = () => !!office.person && office.person === approver()
  // Whether the owner has typed text into the open shell since their last Enter, Ctrl-C or Ctrl-D.
  const [midLine, setMidLine] = createSignal(false)
  // A PTY shell waiting for the approver's password opens itself when none is open: with the keys, in the default view,
  // or, while the prompt holds a draft, beside it with the draft keeping them. It goes back to the list once the wait
  // ends and the owner has finished the line they were typing into it, a password's rest that must not reach the
  // chat, unless the owner has since moved it on.
  const secretWait = (i: Instrument) => i.interactive && i.status === "waiting" && i.waiting === "secret"
  createEffect(
    on(
      () => (approving() ? instruments().find(secretWait)?.id : undefined),
      (id) => {
        if (!id || untrack(opened)) return
        if (untrack(() => promptRef.current?.current.input)) return setOpened({ id, view: "split", itself: true })
        setOpened({ id, view: defaultPlacement(), itself: true })
        focusInstrument()
      },
    ),
  )
  createEffect(() => {
    const current = opened()
    if (!current?.itself) return
    const shell = instruments().find((i) => i.id === current.id)
    if (shell && (secretWait(shell) || midLine())) return
    untrack(closeInstrument)
  })

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    // A split takes the sidebar's place while it shows.
    if (split()) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(
    () => dimensions().width - (sidebarVisible() ? 42 : 0) - (split() ? paneResize.size() : 0) - 4,
  )

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const costCap = useCostCap()

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => {
        office
          .syncSession(sessionID)
          .then(() => {
            if (route.sessionID !== sessionID) return
            toBottom()
            // A turn may have started before this view opened (the first message is sent from home): it
            // began at the last user message, or begins after what is here now.
            if (turnStart || viewID() !== sessionID) return
            const list = messages()
            const last = Math.max(list.findLastIndex((m) => m.role === "user"), 0)
            turnStart = assistantIds(interruptible(viewStatus()) ? list.slice(0, last) : list)
          })
          .catch((error) => {
            // An office that is down loads the session when it comes back.
            if (route.sessionID !== sessionID || error instanceof OfficeUnavailable) return
            const missing = error instanceof OfficeError && error.code === "not_found"
            toast.show({
              message: missing ? `Session not found: ${sessionID}` : errorMessage(error),
              variant: "error",
              duration: 5000,
            })
            navigate({ type: "home" })
          })
      },
    ),
  )

  let seeded = false
  let scroll: ScrollBoxRenderable
  const bind = (r: PromptRef | undefined) => {
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const dialog = useDialog()
  const renderer = useRenderer()

  let chatNode: BoxRenderable | undefined
  let viewNode: BoxRenderable | undefined
  // What gives the open shell's terminal the keys again, while it has one.
  let focusView: (() => void) | undefined
  // What had the keys in the chat when the open instrument took them, given back after.
  let chatFocus: Renderable | null = null
  function focusInstrument() {
    if (instrumentFocused()) return
    const current = renderer.currentFocusedRenderable
    if (current && within(current, chatNode)) {
      chatFocus = current
      current.blur()
    }
    setInstrumentFocused(true)
  }
  function focusChat() {
    if (!instrumentFocused()) return
    const current = renderer.currentFocusedRenderable
    if (current && within(current, viewNode)) current.blur()
    setInstrumentFocused(false)
    if (!dropping()) giveChatFocus()
  }
  /** Gives back what had the keys in the chat when the open instrument took them. */
  function giveChatFocus() {
    const saved = chatFocus
    chatFocus = null
    if (saved && !saved.isDestroyed && within(saved, chatNode)) saved.focus()
  }
  // A view that goes while the owner is mid-line in its shell, however it goes, leaves the rest of that line (a
  // password's, perhaps) going nowhere: the keys are dropped until its Enter, Ctrl-C or Ctrl-D, and only then does
  // the chat get them.
  const [dropping, setDropping] = createSignal(false)
  const keymap = useOpenCorpKeymap()
  onCleanup(
    keymap.intercept(
      "key",
      ({ event, consume }) => {
        if (!dropping()) return
        consume()
        if (!endsLine(event)) return
        setDropping(false)
        giveChatFocus()
      },
      { priority: 200 },
    ),
  )
  /** Starts dropping the owner's keys when the open view goes while they are mid-line in its shell. */
  function leaving() {
    if (untrack(midLine)) setDropping(true)
  }
  // Focus that lands in the open instrument gives it the keys. While it has them, focus that lands in the chat (a
  // dialog handing it back to the prompt) goes back to the instrument.
  const onFocused = () => {
    const current = renderer.currentFocusedRenderable
    if (!current || !opened()) return
    if (within(current, viewNode)) focusInstrument()
    else if (instrumentFocused() && within(current, chatNode)) {
      current.blur()
      if (dialog.stack.length === 0) focusView?.()
    }
  }
  renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, onFocused)
  onCleanup(() => renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, onFocused))

  /** Opens instrument `id` in `view`, the setting's unless given, with the keys unless `keys` is false. */
  function showInstrument(id: string, view = defaultPlacement(), keys = true) {
    if (opened() && opened()!.id !== id) leaving()
    setOpened({ id, view })
    if (keys) focusInstrument()
    else focusChat()
  }
  /** Puts the open instrument back in the list; the chat gets the keys, once the owner has ended a line they were
   *  typing into it. */
  function closeInstrument() {
    if (!opened()) return
    leaving()
    setOpened(null)
    focusChat()
  }
  /** The live shell the open approval card's terminal command would run in, if it names one. */
  const cardShell = createMemo(() => {
    const held = approval() ? question()?.approval : undefined
    if (!held || (held.tool !== "terminal_run" && held.tool !== "terminal_type")) return undefined
    const name = held.args?.shell
    return instruments().find((i) => i.name === name && LIVE.includes(i.status))
  })
  /** Opens the shell an open approval card would run in, beside the card, which keeps the keys; else the shell
   *  waiting on the owner, else the one that changed last. With one open, moves it to its next view, and after full
   *  screen back to the list. */
  function cycleInstrument() {
    const current = opened()
    if (!current) {
      const beside = cardShell()
      if (beside) return showInstrument(beside.id, "split", false)
      const list = instruments()
      const next =
        waitingInstrument(list) ??
        list.reduce<Instrument | undefined>((a, b) => (!a || b.updated_at >= a.updated_at ? b : a), undefined)
      if (next) showInstrument(next.id)
      return
    }
    const view = nextPlacement(current.view)
    if (!view) return closeInstrument()
    setOpened({ id: current.id, view })
    // Full screen leaves no chat to keep the keys.
    if (view === "full" || instrumentFocused()) focusInstrument()
  }

  /** The id of the next or previous message with text, relative to the scroll position. */
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const scrollTop = scroll.y
    const visibleMessages = scroll
      .getChildren()
      .filter((c) => {
        const message = c.id && messages().find((m) => m.id === c.id)
        return !!message && hasText(message)
      })
      .sort((a, b) => a.y - b.y)
    if (visibleMessages.length === 0) return null
    if (direction === "next") return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Scrolls to the next message in `direction`, or by a page when there is none.
  const scrollToMessage = (direction: "next" | "prev") => {
    const targetID = findNextVisibleMessage(direction)
    const child = targetID && scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    else scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  function transcript(toolDetails: boolean) {
    const current = session()
    return current && formatTranscript(current, messages(), office.state.people, { toolDetails })
  }

  const sessionCommandList = createMemo(() => [
    {
      title: "End the session",
      value: "session.end",
      category: "Session",
      slash: { name: "end" },
      run: () => {
        dialog.clear()
        // The office interrupts a busy session before it ends it.
        office.client.sessions
          .end(route.sessionID)
          .then(() => toast.show({ message: "Ending the session", variant: "info" }))
          .catch((error) =>
            isNotImplemented(error)
              ? toast.show({ message: "Ending a session is not available yet", variant: "warning" })
              : toast.show({ message: errorMessage(error), variant: "error", duration: 5000 }),
          )
      },
    },
    {
      title: "Set the cost cap",
      value: "session.cost_cap",
      category: "Session",
      slash: { name: "cost-cap" },
      run: () => costCap.ask(route.sessionID),
    },
    {
      title: "Switch the chat's mode…",
      value: "session.mode",
      category: "Session",
      enabled: switchable(),
      run: () => dialog.replace(() => <DialogMode sessionID={route.sessionID} />),
    },
    {
      title: "Open an instrument…",
      value: "session.instrument.list",
      category: "Session",
      enabled: instruments().length > 0 || harnesses().length > 0,
      run: () =>
        dialog.replace(() => (
          <DialogInstruments
            instruments={[...instruments(), ...harnesses()]}
            current={opened()?.id}
            // A Codex session is a child session: it opens as a chat.
            onOpen={(id) => (harnesses().some((i) => i.id === id) ? enterChild(id) : showInstrument(id))}
          />
        )),
    },
    {
      title: "Go to the chat's first Codex session",
      value: "session.child.first",
      category: "Session",
      enabled: !parentID() && firstChild() !== undefined,
      run: () => enterChild(firstChild()!),
    },
    {
      title: "Go back to the chat that drives this Codex session",
      value: "session.parent",
      category: "Session",
      enabled: !!parentID(),
      run: () => enterChild(parentID()!),
    },
    {
      title: "Next Codex session of the chat",
      value: "session.child.next",
      category: "Session",
      enabled: !!parentID() && children().length > 1,
      run: () => moveChild(1),
    },
    {
      title: "Previous Codex session of the chat",
      value: "session.child.previous",
      category: "Session",
      enabled: !!parentID() && children().length > 1,
      run: () => moveChild(-1),
    },
    {
      title: "List the chat's rules",
      value: "session.rules",
      category: "Session",
      slash: { name: "rules" },
      run: () => dialog.replace(() => <DialogRules sessionID={route.sessionID} />),
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      category: "Session",
      run: () => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      category: "Session",
      run: () => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: { name: "timestamps", aliases: ["toggle-timestamps"] },
      run: () => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      category: "Session",
      run: () => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      category: "Session",
      run: () => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      run: () => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Choose how instruments open…",
      value: "session.instrument.view",
      category: "Session",
      run: () =>
        dialog.replace(() => (
          <DialogInstrumentView current={defaultPlacement()} onPick={(view) => setInstrumentView(() => view)} />
        )),
    },
    ...(
      [
        ["Page up", "session.page.up", () => scroll.scrollBy(-scroll.height / 2)],
        ["Page down", "session.page.down", () => scroll.scrollBy(scroll.height / 2)],
        ["Line up", "session.line.up", () => scroll.scrollBy(-1)],
        ["Line down", "session.line.down", () => scroll.scrollBy(1)],
        ["Half page up", "session.half.page.up", () => scroll.scrollBy(-scroll.height / 4)],
        ["Half page down", "session.half.page.down", () => scroll.scrollBy(scroll.height / 4)],
        ["First message", "session.first", () => scroll.scrollTo(0)],
        ["Last message", "session.last", () => scroll.scrollTo(scroll.scrollHeight)],
      ] as const
    ).map(([title, value, move]) => ({
      title,
      value,
      category: "Session",
      hidden: true,
      run: () => {
        move()
        dialog.clear()
      },
    })),
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      category: "Session",
      hidden: true,
      run: () => {
        const message = messages().findLast((m) => m.role === "user" && hasText(m))
        const child = message && scroll.getChildren().find((child) => child.id === message.id)
        if (child) scroll.scrollBy(child.y - scroll.y - 1)
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("next"),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("prev"),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      category: "Session",
      run: () => {
        const last = messages().findLast((message) => message.role === "assistant")
        const text = last && messageText(last)
        dialog.clear()
        if (!text) return toast.show({ message: "No assistant text to copy", variant: "error" })
        clipboard
          .write?.(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: { name: "copy" },
      run: async () => {
        try {
          const text = transcript(showDetails())
          if (!text) return
          await clipboard.write?.(text)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      slash: { name: "export" },
      run: async () => {
        try {
          const current = session()
          if (!current) return
          const options = await DialogExportOptions.show(
            dialog,
            `session-${current.id.slice(0, 8)}.md`,
            showDetails(),
            false,
          )
          if (options === null) return
          const text = transcript(options.toolDetails)!
          if (options.openWithoutSaving) {
            await openEditor({ renderer, value: text, cwd: current.cwd })
          } else {
            const filename = options.filename.trim()
            const filepath = path.join(paths.cwd, filename)
            await writeExport(filepath, text)
            const result = await openEditor({ renderer, value: text, cwd: current.cwd })
            if (result !== undefined) await writeExport(filepath, result)
            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
  ])

  const sessionCommands = createMemo(() =>
    sessionCommandList().map((command) => ({
      namespace: "palette",
      name: command.value,
      slashName: "slash" in command ? command.slash?.name : undefined,
      slashAliases: "slash" in command ? command.slash?.aliases : undefined,
      ...command,
    })),
  )

  useBindings(() => ({
    commands: sessionCommands(),
  }))

  // No mode: it must work from a card (question mode) and from the prompt (base mode).
  useBindings(() => ({
    commands: [
      {
        name: "session.card.focus",
        title: "Move between the open card and the prompt",
        category: "Session",
        hidden: true,
        enabled: chatKeys() && codex() && cards().length > 0 && dialog.stack.length === 0,
        run: () => setFocus((f) => (f === "card" ? "prompt" : "card")),
      },
    ],
    bindings: tuiConfig.keybinds.gather("session.card", ["session.card.focus"]),
  }))

  // Above the app's Shift+Tab (previous person): in a chat it switches the mode.
  useBindings(() => ({
    mode: OPENCORP_BASE_MODE,
    priority: 1,
    commands: [
      {
        name: "session.mode.cycle",
        title: "Cycle the chat's mode",
        category: "Session",
        hidden: true,
        enabled: chatKeys() && switchable() && dialog.stack.length === 0,
        run: () =>
          void permission
            .cycle(route.sessionID)
            .catch((e) => toast.show({ message: errorMessage(e), variant: "error" })),
      },
    ],
    bindings: tuiConfig.keybinds.gather("session.mode", ["session.mode.cycle"]),
  }))

  // No mode, so they work from a card as from the prompt; above the prompt's Esc, which clears a draft or interrupts.
  useBindings(() => ({
    priority: 2,
    commands: [
      {
        name: "session.instrument.cycle",
        title: "Open an instrument, or switch how it shows",
        category: "Session",
        hidden: true,
        enabled: dialog.stack.length === 0 && (opened() !== null || instruments().length > 0),
        run: cycleInstrument,
      },
      {
        name: "session.instrument.close",
        title: "Put the open instrument back in the list",
        category: "Session",
        hidden: true,
        enabled: opened() !== null && instrumentFocused() && dialog.stack.length === 0,
        run: closeInstrument,
      },
      {
        name: "session.instrument.focus.chat",
        title: "Give the chat the keys, the open instrument staying open",
        category: "Session",
        hidden: true,
        // Full screen leaves no chat to type in.
        enabled: opened() !== null && opened()?.view !== "full" && instrumentFocused() && dialog.stack.length === 0,
        run: focusChat,
      },
      {
        name: "session.instrument.focus",
        title: "Give the open instrument the keys",
        category: "Session",
        hidden: true,
        enabled: opened() !== null && !instrumentFocused() && dialog.stack.length === 0,
        run: focusInstrument,
      },
    ],
    bindings: tuiConfig.keybinds.gather("session.instrument", [
      "session.instrument.cycle",
      "session.instrument.close",
      "session.instrument.focus.chat",
      "session.instrument.focus",
    ]),
  }))

  useBindings(() => ({
    enabled: chatKeys(),
    bindings: tuiConfig.keybinds.gather("session.global", sessionGlobalBindingCommands),
  }))

  useBindings(() => ({
    enabled: () => chatKeys() && renderer.currentFocusedEditor === null,
    bindings: tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCORP_BASE_MODE,
    enabled: chatKeys(),
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  const lastAssistant = createMemo(() => shown().findLast((x) => x.role === "assistant"))

  return (
    <context.Provider
      value={{
        get width() {
          return contentWidth()
        },
        sessionID: route.sessionID,
        conceal,
        showTimestamps,
        showDetails,
        showGenericToolOutput,
        diffWrapMode,
        tui: tuiConfig,
      }}
    >
      <box
        flexDirection="row"
        flexGrow={1}
        minHeight={0}
        position="relative"
        onMouseDrag={paneResize.onMouseDrag}
        onMouseDragEnd={finishPaneResize}
        onMouseUp={finishPaneResize}
      >
        <box
          ref={(r: BoxRenderable) => (chatNode = r)}
          flexGrow={1}
          minWidth={0}
          minHeight={0}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          gap={1}
        >
          {/* While the open instrument has the keys, the chat's prompt and cards have none. */}
          <InteractivityProvider enabled={!instrumentFocused()}>
            <Show when={session()}>
              {(current) => (
                <>
                  <Show when={sideQuestion()}>{(q) => <SideHeader question={q()} session={sideSession()} />}</Show>
                  <box flexShrink={0} paddingTop={1} visible={!sideOf()}>
                    <text fg={theme.text} wrapMode="none">
                      <b>{person()}</b>
                      <span
                        style={{ fg: ["busy", "waiting"].includes(current().status) ? theme.warning : theme.textMuted }}
                      >
                        {" "}
                        · {statusLabel(current())}
                      </span>
                      <Show when={costLabel(current(), office.connections())}>
                        {(cost) => <span style={{ fg: theme.textMuted }}> · {cost()}</span>}
                      </Show>
                      <span style={{ fg: theme.textMuted }}>
                        {" · "}
                        {display(modelLabel(current(), office.connections()))}
                      </span>
                    </text>
                    <Show when={current().model_note}>
                      {(note) => (
                        <text fg={theme.warning} wrapMode="word">
                          {display(note())}
                        </text>
                      )}
                    </Show>
                  </box>
                  <scrollbox
                    ref={(r) => (scroll = r)}
                    viewportOptions={{
                      paddingRight: showScrollbar() ? 1 : 0,
                    }}
                    verticalScrollbarOptions={{
                      paddingLeft: 1,
                      visible: showScrollbar(),
                      trackOptions: {
                        backgroundColor: theme.backgroundElement,
                        foregroundColor: theme.border,
                      },
                    }}
                    stickyScroll={true}
                    stickyStart="bottom"
                    flexGrow={1}
                    // Under a card the transcript takes what the card leaves, and keeps a few rows.
                    flexBasis={card() ? 0 : "auto"}
                    minHeight={card() ? 3 : 0}
                    scrollAcceleration={scrollAcceleration()}
                  >
                    <For each={shown()}>
                      {(message, index) => (
                        <Switch>
                          <Match when={message.role === "user"}>
                            <UserMessage
                              index={index()}
                              onMouseUp={() => {
                                if (renderer.getSelection()?.getSelectedText()) return
                                dialog.replace(() => <DialogMessage messageID={message.id} sessionID={route.sessionID} />)
                              }}
                              message={message}
                            />
                          </Match>
                          <Match when={message.role === "assistant"}>
                            <AssistantMessage message={message} last={lastAssistant()?.id === message.id} />
                          </Match>
                        </Switch>
                      )}
                    </For>
                  </scrollbox>
                  <Show when={dropping()}>
                    <text fg={theme.warning} flexShrink={0} wrapMode="word">
                      The shell closed: keys are dropped until Enter
                    </text>
                  </Show>
                  {/* A card may shrink to what the chat leaves it: its body scrolls in what remains. */}
                  <box flexShrink={card() ? 1 : 0}>
                    <Show
                      when={codex()}
                      fallback={
                        <Show
                          when={question()?.id}
                          keyed
                          fallback={
                            <Prompt
                              visible={true}
                              ref={bind}
                              onSend={lift}
                              onSubmit={() => toBottom()}
                              onInterrupt={interrupt}
                              sessionID={route.sessionID}
                            />
                          }
                        >
                          {/* Keyed and untracked: a card's source never changes, so the choice is made once. */}
                          {(_id) =>
                            question()?.source === "approval" ? (
                              <PermissionPrompt question={question()} />
                            ) : (
                              <>
                                <QuestionCard
                                  question={question()}
                                  hidden={!!sideOf()}
                                  onChat={() => setSideOf(question()?.id)}
                                />
                                <Show when={sideQuestion()}>
                                  {(q) => (
                                    <SideChat
                                      question={q()}
                                      session={sideSession()}
                                      onBack={() => setSideOf(undefined)}
                                      onSend={() => {
                                        const undo = lift()
                                        toBottom()
                                        return undo
                                      }}
                                      onInterrupt={interrupt}
                                    />
                                  )}
                                </Show>
                              </>
                            )
                          }
                        </Show>
                      }
                    >
                      {/* A child session: the Codex session an employee's chat drives, with the way back to it. */}
                      <Show when={parentID() ? current() : undefined}>
                        {(child) => <InstrumentFooter session={child()} />}
                      </Show>
                      {/* Keyed by id, so a card whose question is re-read (a reconnect) keeps its state. */}
                      <For each={cards().map((q) => q.id)}>
                        {(id, i) => (
                          <Show when={office.state.questions[id]}>
                            {(q) => (
                              <HarnessCard
                                question={q()}
                                active={i() === 0 && cardFocused()}
                                waiting={i() > 0}
                                onInterrupt={interrupt}
                              />
                            )}
                          </Show>
                        )}
                      </For>
                      <Prompt
                        visible={true}
                        inactive={cardFocused()}
                        ref={bind}
                        onSend={lift}
                        onSubmit={() => toBottom()}
                        onInterrupt={interrupt}
                        sessionID={route.sessionID}
                      />
                    </Show>
                  </box>
                </>
              )}
            </Show>
          </InteractivityProvider>
          {/* A click in the chat beside a split gives it the keys; over a floating view it does nothing. */}
          <Show when={opened() && instrumentFocused()}>
            <box
              position="absolute"
              left={0}
              top={0}
              width="100%"
              height="100%"
              zIndex={1}
              onMouseScroll={(event) => {
                if (!scroll || scroll.isDestroyed) return
                const viewport = scroll.viewport
                if (event.x < viewport.x || event.x >= viewport.x + viewport.width) return
                if (event.y < viewport.y || event.y >= viewport.y + viewport.height) return
                // Keep the focus-only click guard, but let the transcript handle its own wheel events.
                event.stopPropagation()
                scroll.processMouseEvent(new MouseEvent(scroll, event))
              }}
              // Consume the release before revealing permission buttons underneath.
              onMouseUp={() => {
                if (paneResize.resizing() || resizeRelease) return
                if (split()) focusChat()
              }}
            />
          </Show>
        </box>
        {/* Keyed by the instrument, so cycling its views keeps its screen. */}
        <Show when={opened()?.id} keyed>
          {(_id) => (
            <box
              ref={(r: BoxRenderable) => (viewNode = r)}
              position={split() ? "relative" : "absolute"}
              zIndex={split() ? 0 : 2000}
              flexShrink={0}
              left={placement().left}
              top={placement().top}
              width={placement().width}
              height={placement().height}
            >
              <Show when={openInstrument()}>
                {(instrument) => (
                  <InstrumentView
                    sessionID={route.sessionID}
                    instrument={instrument()}
                    view={opened()?.view ?? "floating"}
                    // A dialog over it has the keys while it shows.
                    focused={instrumentFocused() && dialog.stack.length === 0}
                    approver={approving()}
                    onFocus={focusInstrument}
                    onFocusRequest={(focus) => (focusView = focus)}
                    onLine={setMidLine}
                  />
                )}
              </Show>
            </box>
          )}
        </Show>
        <Show when={split() && dimensions().width >= 3}>
          <PaneResizeHandle resize={paneResize} left={dimensions().width - paneResize.size() - 1} highlight="right" />
        </Show>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} />
              </box>
            </Match>
          </Switch>
        </Show>
        {/* Beside the open instrument, not in the chat under it, so it shows over a floating view; in a column the
            width of the screen, as the chat is, so it lays out as it did there. It has no height: clicks pass by. */}
        <box position="absolute" left={0} top={0} width="100%" zIndex={2500}>
          <Toast />
        </box>
      </box>
    </context.Provider>
  )
}

/** Whether `node` is `root` or inside it. */
function within(node: Renderable | null | undefined, root: Renderable | undefined) {
  if (!root) return false
  for (let current = node; current; current = current.parent) {
    if (current === root) return true
  }
  return false
}

function UserMessage(props: { message: Message; onMouseUp: () => void; index: number }) {
  const ctx = use()
  const text = createMemo(() =>
    props.message.parts
      .flatMap((x) => (x.type === "text" ? [x.text] : []))
      .join("\n\n")
      .trim(),
  )
  const files = createMemo(() => props.message.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)

  return (
    <Show when={text() || files().length}>
      <box
        id={props.message.id}
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        border={["left"]}
        borderColor={theme.secondary}
        customBorderChars={SplitBorder.customBorderChars}
        marginTop={props.index === 0 ? 0 : 1}
      >
        <box
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={props.onMouseUp}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
          flexShrink={0}
        >
          <Show when={text()}>
            <text fg={theme.text}>{text()}</text>
          </Show>
          <Show when={files().length}>
            <box paddingTop={text() ? 1 : 0}>
              <For each={files()}>
                {(file) => (
                  <text fg={theme.textMuted}>
                    {file.path} ({file.mime})
                  </text>
                )}
              </For>
            </box>
          </Show>
          <Show when={ctx.showTimestamps()}>
            <text fg={theme.textMuted}>{Locale.todayTimeOrDateTime(Date.parse(props.message.created_at))}</text>
          </Show>
        </box>
      </box>
    </Show>
  )
}

function AssistantMessage(props: { message: Message; last: boolean }) {
  return (
    <For each={props.message.parts}>
      {(part, index) => {
        const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
        return (
          <Show when={component()}>
            <Dynamic
              last={props.last && index() === props.message.parts.length - 1}
              component={component()}
              part={part as any}
            />
          </Show>
        )
      }}
    </For>
  )
}

const INLINE_TOOL_ICON_WIDTH = 2

function TextPartView(props: { last: boolean; part: TextPart }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} marginTop={1} flexShrink={0}>
        <markdown
          syntaxStyle={syntax()}
          streaming={true}
          internalBlockMode="top-level"
          content={props.part.text.trim()}
          tableOptions={{ style: "grid" }}
          conceal={ctx.conceal()}
          fg={theme.markdownText}
          bg={theme.background}
        />
      </box>
    </Show>
  )
}

function FilePartView(props: { last: boolean; part: FilePart }) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  return (
    <InlineToolRow icon="↳" color={theme.textMuted} complete={true} pending="">
      {pathFormatter.format(props.part.path)} ({props.part.mime})
    </InlineToolRow>
  )
}

function ErrorPartView(props: { last: boolean; part: ErrorPart }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text fg={theme.error}>{props.part.message}</text>
    </box>
  )
}

export type ToolView =
  | "shell"
  | "typed"
  | "terminal"
  | "read"
  | "write"
  | "edit"
  | "patch"
  | "list"
  | "search"
  | "question"
  | "generic"

const pick = (input: Record<string, unknown>, map: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(map).flatMap(([to, from]) => (input[from] === undefined ? [] : [[to, input[from]]])),
  )

/** A terminal tool's reply: the one JSON object the office returns for every call, empty while the call hasn't
 *  replied (its output is nothing, or `{}`); undefined when it isn't one. */
function terminalReply(output: string | undefined): Record<string, unknown> | undefined {
  if (!output?.trim()) return {}
  try {
    const reply: unknown = JSON.parse(output)
    return reply !== null && typeof reply === "object" && !Array.isArray(reply)
      ? (reply as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** A terminal tool's view, from its input and its reply: the shell by the reply's name, else the input's, else a
 *  new one (`run` alone may start one); the shell's state; and in place of the JSON, a command's output. `terminal`
 *  marks the input as a terminal's, so a view reads a shell and its state only there, not from any tool's arguments. */
function terminalView(
  tool: string,
  input: Record<string, unknown>,
  reply: Record<string, unknown>,
): { view: ToolView; input: Record<string, unknown>; output: string } {
  const named = stringValue(input.shell)
  const shell =
    stringValue(reply.shell) ?? (named && named !== "new" ? named : tool === "run" ? "a new shell" : "a shell")
  const state = {
    terminal: true,
    shell,
    status: stringValue(reply.status),
    waiting: stringValue(reply.waiting),
    refused: stringValue(reply.refused),
    error: stringValue(reply.error),
  }
  if (tool === "run")
    return {
      view: "shell",
      input: { command: input.command, exit_code: reply.exit, ...state },
      output: stringValue(reply.output) ?? "",
    }
  if (tool === "type")
    return { view: "typed", input: { text: input.text, enter: input.enter !== false, ...state }, output: "" }
  return { view: "terminal", input: { action: tool, ...state }, output: "" }
}

/** The renderer for an office tool, by the name the model called it (a workspace tool as `workspace_<tool>` when
 *  its flow grants the group, else by its own name), and its input renamed to the fields that renderer reads. A
 *  terminal tool's view reads its reply too, given as `output`, and says what to show in its place. */
export function toolView(
  tool: string,
  input: Record<string, unknown> = {},
  output?: string,
): { view: ToolView; input: Record<string, unknown>; title?: string; output?: string } {
  switch (tool) {
    case "terminal_run":
    case "terminal_type":
    case "terminal_read":
    case "terminal_interrupt":
    case "terminal_close": {
      const reply = terminalReply(output)
      if (reply !== undefined) return terminalView(tool.slice("terminal_".length), input, reply)
      break
    }
    case "workspace_read_file":
    case "read_file":
      return { view: "read", input: pick(input, { filePath: "path", offset: "offset", limit: "limit" }) }
    case "workspace_write_file":
    case "write_file":
      return { view: "write", input: pick(input, { filePath: "path", content: "content" }) }
    case "workspace_edit_file":
    case "edit_file":
      return {
        view: "edit",
        input: pick(input, { filePath: "path", oldString: "old", newString: "new", replaceAll: "replace_all" }),
      }
    case "workspace_list":
    case "list":
      return { view: "list", input: pick(input, { path: "path" }) }
    case "workspace_search":
    case "search":
      return { view: "search", input: pick(input, { pattern: "pattern", path: "path", include: "glob" }) }
    case "workspace_shell":
    case "shell":
      return { view: "shell", input }
    case "ask_user":
      return { view: "question", input }
    case "codex.command":
      return { view: "shell", input }
    case "codex.file_change":
      return { view: "patch", input }
    case "codex.mcp_tool_call":
      return { view: "generic", input, title: `${stringValue(input.server) ?? "?"}/${stringValue(input.tool) ?? "?"}` }
    case "codex.request": {
      // The summary is the card's whole text (a command, JSON, a reason); its first line names the request.
      const head = stringValue(input.summary)?.split("\n")[0].replace(/:\s*$/, "")
      return { view: "generic", input, title: `${stringValue(input.kind) ?? "?"}: ${head || "?"}` }
    }
  }
  return { view: "generic", input }
}

/** The line edit_file's reply says a single-place edit starts on, if it says one. */
export function editStartLine(output: string | undefined): number | undefined {
  const match = output?.match(/^replaced 1 occurrence in .* at line (\d+)$/s)
  return match ? Number(match[1]) : undefined
}

/** A unified diff of an edit's two sides, its hunks moved to start at `line` of the file. */
function editPatch(file: string, oldString: string, newString: string, line = 1) {
  const patch = createTwoFilesPatch(file, file, oldString, newString)
  return patch.replace(
    /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/gm,
    (_, a, aLen = "", b, bLen = "") => `@@ -${+a + line - 1}${aLen} +${+b + line - 1}${bLen} @@`,
  )
}

/**
 * One unified diff per change of a Codex file change. Codex sends a new or deleted file's whole content as its
 * `diff`, so those become a patch against an empty side; an update's diff is already unified (a move's
 * "Moved to: …" line is dropped).
 */
export function codexPatch(changes: { path: string; kind?: string | null; diff?: string }[]): string {
  return changes
    .map((c) => {
      const body = c.diff ?? ""
      if (c.kind === "add") return createTwoFilesPatch(c.path, c.path, "", body)
      if (c.kind === "delete") return createTwoFilesPatch(c.path, c.path, body, "")
      const diff = body.replace(/\n\nMoved to: .*$/s, "")
      return diff.startsWith("--- ") ? diff : `--- ${c.path}\n+++ ${c.path}\n${diff}`
    })
    .join("\n")
}

const APPROVED = new Set(["turn", "session"])
const DENIED = new Set(["decline", "cancel"])

/** Who decided on a Codex tool part and how ("approved by @x"), or nothing when no one did. */
export function approvalNote(input: Record<string, unknown>): string | undefined {
  const approval = input.approval as { decision?: unknown; by?: unknown } | undefined
  if (!approval || typeof approval !== "object") return undefined
  const decision = stringValue(approval.decision) ?? ""
  const by = stringValue(approval.by)
  const who = by ? ` by @${by}` : ""
  if (decision.startsWith("accept") || APPROVED.has(decision)) return `approved${who}`
  if (DENIED.has(decision)) return `denied${who}`
  return `answered${who}`
}

const PART_MAPPING = {
  text: TextPartView,
  file: FilePartView,
  tool: ToolPartView,
  error: ErrorPartView,
}

function ToolPartView(props: { last: boolean; part: ToolPart }) {
  const ctx = use()
  const view = createMemo(() => toolView(props.part.tool, props.part.input ?? {}, outputText(props.part.output)))

  // Completed tools fold away when tool details are hidden.
  const shouldHide = createMemo(() => !ctx.showDetails() && props.part.state === "completed")

  const toolprops = {
    get input() {
      return view().input
    },
    get output() {
      return (view().output ?? outputText(props.part.output)) || undefined
    },
    get tool() {
      return props.part.tool
    },
    get title() {
      return view().title
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={view().view === "shell"}>
          <Shell {...toolprops} />
        </Match>
        <Match when={view().view === "typed"}>
          <TypedLine {...toolprops} />
        </Match>
        <Match when={view().view === "terminal"}>
          <ShellCall {...toolprops} />
        </Match>
        <Match when={view().view === "list"}>
          <List {...toolprops} />
        </Match>
        <Match when={view().view === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={view().view === "search"}>
          <Search {...toolprops} />
        </Match>
        <Match when={view().view === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={view().view === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={view().view === "patch"}>
          <Patch {...toolprops} />
        </Match>
        <Match when={view().view === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps = {
  input: Record<string, unknown>
  tool: string
  /** A generic tool's title in place of its name and input, such as a Codex MCP call's `server/tool`. */
  title?: string
  output?: string
  part: ToolPart
}

const running = (part: ToolPart) => part.state === "pending" || part.state === "running"

function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 3
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command…" complete={true} part={props.part}>
          {props.title ?? `${props.tool} ${input(props.input)}`}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.title ?? `${props.tool} ${input(props.input)}`}`}
        part={props.part}
        onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={collapsed().overflow}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
}) {
  const { theme } = useTheme()
  const ctx = use()
  const permission = usePermission()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)

  // A call held on an open approval card shows in the warning colour until the card is answered. The card names the
  // call by yian's id, which the part carries once the call waited; its `call_id` is the model's.
  const waiting = createMemo(() => {
    const id = props.part.yian_call_id
    return !!id && permission.waiting(ctx.sessionID, id)
  })
  const error = createMemo(() => (props.part.state === "error" ? (props.part.error ?? "failed") : undefined))
  const note = createMemo(() => approvalNote(props.part.input ?? {}))
  const interrupted = createMemo(() => props.part.state === "interrupted")
  const failed = createMemo(() => Boolean(error()))
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (waiting()) return theme.warning
    if (failed()) return theme.error
    if (hover() && props.onClick) return theme.text
    if (props.complete) return theme.textMuted
    return theme.text
  })

  return (
    <InlineToolRow
      icon={props.icon}
      iconColor={props.iconColor}
      color={fg()}
      errorColor={theme.error}
      failed={failed()}
      denied={interrupted()}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={props.complete}
      pending={props.pending}
      failure={props.failure}
      spinner={props.spinner}
      separate={props.separate}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
      {note() ? ` · ${note()}` : ""}
    </InlineToolRow>
  )
}

export function InlineToolRow(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box
      paddingLeft={3}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
      ref={(el: BoxRenderable) => {
        if (props.separate) alwaysSeparate.add(el)
        setPreLayoutSiblingMargin(el, (previous) => {
          return props.separate ||
            (previous instanceof BoxRenderable && (previous.height > 1 || alwaysSeparate.has(previous)))
            ? 1
            : 0
        })
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={props.color} children={props.children} />
        </Match>
        <Match when={true}>
          <Show
            fallback={
              <text
                paddingLeft={3}
                fg={props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                ~ {props.pending}
              </text>
            }
            when={props.complete || props.failed}
          >
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <text
                flexGrow={1}
                fg={props.failed ? props.errorColor : props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
              </text>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title?: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state === "error" ? props.part.error : undefined))
  const note = createMemo(() => (props.part ? approvalNote(props.part.input ?? {}) : undefined))
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show when={props.title}>
        {(title) => (
          <Show
            when={props.spinner}
            fallback={
              <text paddingLeft={3} fg={theme.textMuted}>
                {title()}
              </text>
            }
          >
            <Spinner color={theme.textMuted}>{title().replace(/^# /, "")}</Spinner>
          </Show>
        )}
      </Show>
      {props.children}
      <Show when={note()}>
        <text fg={theme.textMuted}>{note()}</text>
      </Show>
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

/** " (exit N)" for a command that exited non-zero, as a Codex command's part records; else nothing. */
function exitNote(input: Record<string, unknown>) {
  const code = input.exit_code
  return typeof code === "number" && code !== 0 ? ` (exit ${code})` : ""
}

/** What a terminal tool's reply says the owner should read: why nothing was done, or why the shell failed. */
function shellNote(input: Record<string, unknown>) {
  const refused = stringValue(input.refused)
  if (refused) return `refused: ${display(refused)}`
  const error = stringValue(input.error)
  if (input.status === "failed" && error) return `failed: ${display(error)}`
  return undefined
}

/** The shell a terminal tool's view names, as drawn; none for any other tool. */
const shellName = (input: Record<string, unknown>) =>
  input.terminal === true ? display(stringValue(input.shell) ?? "") : ""

/** A command's output as drawn: escapes and control characters gone, and a lone CR starting a line, as in a shell's
 *  own view. */
const shownOutput = (output: string) => display(output.replace(/\r\n?/g, "\n")).trim()

/**
 * A shell command: `$ <command>` and its output, folded to 10 lines that a click expands. An agent's terminal
 * command names its shell, muted, and folds as the upstream TUI's shell view does: the command to two rows and the
 * output to its end. Its reply is a snapshot, so a command it left running or waiting spins, or takes the warning
 * colour, only while its shell still runs it.
 */
function Shell(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const office = useOffice()
  const permission = usePermission()
  const output = createMemo(() => shownOutput(props.output ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const terminal = () => props.input.terminal === true
  const command = createMemo(() => display(stringValue(props.input.command) ?? ""))
  const shell = createMemo(() => shellName(props.input))
  const collapsed = createMemo(() =>
    terminal()
      ? collapseShellOutput(command(), output(), maxLines, maxChars())
      : { input: command(), ...collapseToolOutput(output(), maxLines, maxChars()) },
  )
  const shownCommand = () => (expanded() ? command() : collapsed().input)
  const shownText = () => (expanded() ? output() : collapsed().output)
  const toggle = () => setExpanded((prev) => !prev)
  // The session's shell still running the command the reply left running or waiting, if one is.
  const instrument = createMemo(() => {
    const { status } = props.input
    if (!terminal() || (status !== "running" && status !== "waiting")) return undefined
    const name = stringValue(props.input.shell)
    return office.state.instruments[ctx.sessionID]?.find(
      (i) =>
        i.kind === "terminal" &&
        i.name === name &&
        i.command === props.input.command &&
        (i.status === "running" || i.status === "waiting"),
    )
  })
  const live = createMemo(() => running(props.part) || instrument() !== undefined)
  const secret = () => instrument()?.waiting === "secret"
  const note = createMemo(() => (terminal() ? shellNote(props.input) : undefined))
  // As the upstream TUI's shell view: the command in the warning colour while it waits on the owner, on an open
  // approval card or in its shell.
  const color = createMemo(() => {
    const id = props.part.yian_call_id
    const held = !!id && permission.waiting(ctx.sessionID, id)
    return held || instrument()?.status === "waiting" ? theme.warning : theme.text
  })
  const where = () => (
    <Show when={shell()}>
      <span style={{ fg: theme.textMuted }}> in {shell()}</span>
    </Show>
  )

  return (
    <Switch>
      <Match when={output() || note() || secret()}>
        <BlockTool part={props.part} onClick={collapsed().overflow ? toggle : undefined}>
          <box gap={1}>
            <Show
              when={live()}
              fallback={
                <text fg={theme.text}>
                  $ {shownCommand()}
                  {where()}
                  {exitNote(props.input)}
                </text>
              }
            >
              <Spinner color={color()}>
                {shownCommand()}
                {where()}
              </Spinner>
            </Show>
            <Show when={output()}>
              <text fg={theme.text}>{shownText()}</text>
            </Show>
            <Show when={collapsed().overflow}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
            <Show when={secret()}>
              <text fg={theme.warning}>waiting for your password</text>
            </Show>
            <Show when={note()}>
              <text fg={props.input.refused ? theme.textMuted : theme.error}>{note()}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="$"
          pending="Writing command…"
          complete={command()}
          spinner={live() && !!command()}
          part={props.part}
          onClick={collapsed().overflow ? toggle : undefined}
        >
          {shownCommand()}
          {where()}
          {exitNote(props.input)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

/** A line an agent typed into a shell: `⌨ <text> into <shell>`, and `⏎` when it pressed Enter after it. A newline in
 *  the text is an Enter, and shows as `⏎` too, so the line stays one row. */
function TypedLine(props: ToolProps) {
  const text = createMemo(() => stringValue(props.input.text))
  const line = createMemo(() =>
    [display((text() ?? "").replace(/\n/g, "⏎")), "into", shellName(props.input), props.input.enter ? "⏎" : ""]
      .filter(Boolean)
      .join(" "),
  )
  const note = createMemo(() => shellNote(props.input))
  return (
    <InlineTool
      icon="⌨"
      pending="Typing…"
      complete={text() !== undefined}
      spinner={running(props.part)}
      part={props.part}
    >
      {line()}
      {note() ? ` · ${note()}` : ""}
    </InlineTool>
  )
}

const SHELL_CALLS: Record<string, string> = { read: "Read", interrupt: "Interrupt", close: "Close" }

/** A read, interrupt or close of an agent's shell, on one line: the shell, and what its reply says of it. */
function ShellCall(props: ToolProps) {
  const state = createMemo(() => shellNote(props.input) ?? display(stringValue(props.input.status) ?? ""))
  return (
    <InlineTool icon="$" pending="" complete={true} spinner={running(props.part)} part={props.part}>
      {SHELL_CALLS[stringValue(props.input.action) ?? ""]} {shellName(props.input)}
      {state() ? ` · ${state()}` : ""}
    </InlineTool>
  )
}

function Write(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="←" pending="Preparing write…" complete={stringValue(props.input.filePath)} part={props.part}>
      Write {pathFormatter.format(stringValue(props.input.filePath))}
    </InlineTool>
  )
}

function List(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Listing files…" complete={true} part={props.part}>
      List {pathFormatter.format(stringValue(props.input.path) ?? ".")}
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool
      icon="→"
      pending="Reading file…"
      complete={stringValue(props.input.filePath)}
      spinner={props.part.state === "running"}
      part={props.part}
    >
      Read {pathFormatter.format(stringValue(props.input.filePath))} {input(props.input, ["filePath"])}
    </InlineTool>
  )
}

function Search(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Searching content…" complete={stringValue(props.input.pattern)} part={props.part}>
      Search "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={stringValue(props.input.include)}>({stringValue(props.input.include)})</Show>
    </InlineTool>
  )
}

function Edit(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const view = createMemo(() => {
    if (ctx.tui.diff_style === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })
  const file = createMemo(() => stringValue(props.input.filePath) ?? "")
  const ft = createMemo(() => filetype(file()))
  const oldString = createMemo(() => stringValue(props.input.oldString))
  const newString = createMemo(() => stringValue(props.input.newString))
  // The edit's input carries both sides, so the diff is built here rather than sent. Its lines
  // are numbered only when the reply says where in the file the edit landed.
  const startLine = createMemo(() => editStartLine(props.output))
  const diffContent = createMemo(() => editPatch(file(), oldString() ?? "", newString() ?? "", startLine()))

  return (
    <Switch>
      <Match when={props.part.state === "completed" && oldString() !== undefined && newString() !== undefined}>
        <BlockTool title={"← Edit " + pathFormatter.format(file())} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={startLine() !== undefined}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit…" complete={file()} part={props.part}>
          Edit {pathFormatter.format(file())} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

type CodexChange = { path: string; kind?: string | null; move_path?: string; diff?: string }

function Patch(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const view = createMemo(() => {
    if (ctx.tui.diff_style === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })
  const changes = createMemo(() => (Array.isArray(props.input.changes) ? (props.input.changes as CodexChange[]) : []))
  const paths = createMemo(() =>
    changes()
      .map((c) => pathFormatter.format(c.path) + (c.move_path ? ` → ${pathFormatter.format(c.move_path)}` : ""))
      .join(", "),
  )

  return (
    <Switch>
      <Match when={changes().length > 0}>
        <BlockTool title={"← Edit " + paths()} part={props.part}>
          {/* The diff renderer shows only a patch's first file, so each file gets its own. */}
          <For each={changes()}>
            {(change) => (
              <box paddingLeft={1}>
                <diff
                  diff={codexPatch([change])}
                  view={view()}
                  filetype={filetype(change.path)}
                  syntaxStyle={syntax()}
                  showLineNumbers={false}
                  width="100%"
                  wrapMode={ctx.diffWrapMode()}
                  fg={theme.text}
                  addedBg={theme.diffAddedBg}
                  removedBg={theme.diffRemovedBg}
                  contextBg={theme.diffContextBg}
                  addedSignColor={theme.diffHighlightAdded}
                  removedSignColor={theme.diffHighlightRemoved}
                  lineNumberFg={theme.diffLineNumber}
                  lineNumberBg={theme.diffContextBg}
                  addedLineNumberBg={theme.diffAddedLineNumberBg}
                  removedLineNumberBg={theme.diffRemovedLineNumberBg}
                />
              </box>
            )}
          </For>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit…" complete={!running(props.part)} part={props.part}>
          Edit (no changes)
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const { theme } = useTheme()
  const question = createMemo(() => stringValue(props.input.question))
  return (
    <Switch>
      <Match when={props.part.state === "completed" && props.output}>
        <BlockTool title="# Question" part={props.part}>
          <box flexDirection="column">
            <text fg={theme.textMuted}>{question()}</text>
            <text fg={theme.text}>{answerShown(props.output ?? "")}</text>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking a question…" complete={question()} part={props.part}>
          Asked "{question()}"
        </InlineTool>
      </Match>
    </Switch>
  )
}

function input(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

import {
  batch,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  For,
  mapArray,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import {
  type ErrorPart,
  type FilePart,
  type Instrument,
  isInstrumentNote,
  type Message,
  type Part,
  type Question as OfficeQuestion,
  type TextPart,
  type ToolPart,
} from "@opencorp/protocol"
import { createTwoFilesPatch } from "diff"
import { useRoute, useRouteData } from "../../context/route"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths } from "../../context/runtime"
import { Spinner } from "../../component/spinner"
import { useTheme } from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, type RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import { Locale } from "../../util/locale"
import { Dynamic, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogMessage } from "./dialog-message"
import { DialogMode } from "./dialog-mode"
import { DialogRules } from "./dialog-rules"
import { PermissionPrompt } from "./permission"
import { costLabel } from "./sidebar"
import { filetype } from "../../util/filetype"
import { errorMessage } from "../../util/error"
import { interruptible } from "../../util/status"
import { useToast } from "../../ui/toast"
import { useSessionLinks } from "../../ui/session-link"
import { useCostCap } from "../../component/cost-cap"
import { useKV } from "../../context/kv.tsx"
import { usePromptRef } from "../../context/prompt"
import { useEpilogue } from "../../context/epilogue"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript, outputText, personLabel } from "../../util/transcript"
import { sessionEpilogue } from "../../util/presentation"
import { useTuiConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseShellOutput, collapseToolOutput } from "../../util/collapse-tool-output"
import { OPENCORP_BASE_MODE, useBindings, useCommandShortcut } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { useOffice } from "../../context/office"
import { usePermission } from "../../context/permission"
import { modelLabel, OfficeError, OfficeUnavailable, isNotImplemented, statusLabel, type OfficeState } from "@opencorp/client"
import { answerShown } from "../chat/answer"
import { QuestionCard } from "../chat/card"
import { HarnessCard } from "../chat/harness-card"
import { SideChat, SideHeader } from "../chat/side"
import { freeze, frozenList, unfreeze, type Freeze } from "../chat/freeze"
import { display } from "../../util/printable"
import { useLocal } from "../../context/local"
import { Composer } from "./composer"
import { busyCounts, busyTab, childState, familyQuestions, HARNESS_TITLE, harnessFamily } from "./composer/tabs"
import { sessionOwner, speakerLabel } from "./speakers"
import { NoteLine } from "./note-line"
import { alwaysSeparate, InlineToolRow } from "./message-parts"
import { context, use } from "./render-context"
import { SessionGroupView } from "./group-view"
import { groupMemory } from "./group-memory"
import {
  defaultVerbosity,
  groupID,
  verbosities,
  type GroupKind,
  type PartRef,
  type SessionEntry,
  type SessionRow,
  type Verbosity,
} from "./grouping/session"
import { blankText, reduceMessageRows } from "./rows"
import { EntryAnchor, useAnchor } from "./anchor-view"
import {
  containsAnchor,
  createTimelineAnchors,
  isMessageRef,
  messageRef,
  scrollMemory,
  type ScrollAnchor,
} from "./anchors"
import { rowsAfter, rowsBefore, rowWeight } from "./mount-budget"
import { createHistoryPrepend } from "./history"

export { alwaysSeparate, InlineToolRow } from "./message-parts"

const sessionBindingCommands = [
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.scrollbar",
  "session.toggle.exploration_grouping",
  "session.verbosity.cycle",
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

// Budgets count rendered entries (see mount-budget.ts); a collapsed group costs one.
// The tail comfortably overfills a tall viewport; older rows mount as the reader approaches them.
const TRANSCRIPT_TAIL_ROWS = 40
const TRANSCRIPT_BACKFILL_CHUNK = 60

/** Whether a message has a text part with more than whitespace: the view draws nothing for a blank one. */
function hasText(message: Message) {
  return message.parts.some((part) => part.type === "text" && part.text.trim())
}

/** The ids of `message`'s calls that wait on an approval card, by `waiting`, which takes a call's yian id. */
function waitingCalls(message: Message, waiting: (callID: string) => boolean) {
  return new Set(
    message.parts.flatMap((part) =>
      part.type === "tool" && part.yian_call_id && waiting(part.yian_call_id) ? [part.id] : [],
    ),
  )
}

/**
 * A reply's rows as it renders them, for a reactive scope to read: each run of tool calls grouped as `verbosity`
 * says, the calls waiting on an approval card (`waiting`, by a call's yian id) kept out of their group's summary, and
 * each part's blankness in a memo of its own, so a streamed delta rebuilds the rows only when a text stops being blank.
 */
function replyRows(message: () => Message, verbosity: () => Verbosity, waiting: (callID: string) => boolean) {
  const blanks = createMemo(mapArray(() => message().parts, (part) => createMemo(() => blankText(part))))
  return () => {
    const blank = blanks()
    const reply = message()
    const pending = waitingCalls(reply, waiting)
    return reduceMessageRows(reply, verbosity(), toolName, pending, (_, index) => !!blank[index]?.())
  }
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

export type SessionProps = {
  sessionID: string
  /** Set when it shows in the right pane beside a chat: no header, since the pane's names it; no epilogue; and the
   *  ways back to the chat close the pane (`close`) or give the chat the keys (`leave`). */
  pane?: { close: () => void; leave: () => void }
  /** Its width, which the frame measures; the screen's when not given. */
  width?: number
  scrollRef?: (scroll: ScrollBoxRenderable | undefined) => void
  /** The chat's shells, as its picker lists them. */
  shells?: readonly Instrument[]
  /** The instrument the pane shows, which the picker marks. */
  visibleID?: string
  /** Opens instrument `id`, a shell or a Codex or Claude Code session, in the right pane. */
  onOpen?: (id: string) => void
  /** Takes what opens the picker on its busiest tab, for the pane's key that goes back to it. */
  onPicker?: (show: (() => void) | undefined) => void
  /** What closed while the owner was typing into it, a shell or a card, when their keys are dropped until Enter. */
  keysDropped?: "shell" | "card"
  /** Called when a card closes under the owner's typing without their answer from here, to drop their keys. */
  onCardLost?: () => void
  /** A line saying the pane holds an instrument it can't show beside the chat, and how to show it. */
  paneNote?: string
}

export function Session(props: SessionProps) {
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
  const local = useLocal()
  const promptRef = usePromptRef()
  const session = createMemo(() => office.state.sessions.find((s) => s.id === props.sessionID))
  // The open cards here: this session's own first, then, in a chat, its Codex and Claude Code sessions'.
  const cards = createMemo(() => familyQuestions(office.state, props.sessionID))
  // A Codex session shows every open card above a prompt that stays; the first card or the prompt has the keys.
  const codex = createMemo(() => session()?.harness === "codex")
  // A Codex or Claude Code session: a harness of its own, which takes a message mid-turn into the running turn.
  const harnessed = createMemo(() => session()?.harness === "codex" || session()?.harness === "claude")
  // The cards above a prompt that stays: a Codex session's own, or a chat's Codex sessions', shown in the chat as in
  // their own view.
  const stacked = createMemo(() => (harnessed() ? cards() : cards().filter((q) => q.session_id !== props.sessionID)))
  // The chat's own cards, which take the prompt's place in turn.
  const own = createMemo(() => (harnessed() ? [] : cards().filter((q) => q.session_id === props.sessionID)))
  // The card with the keys, or none while the prompt has them. It keeps them until it closes or ctrl+t moves them,
  // wherever a card that opens meanwhile sorts, the chat's own included: keys typed for it, a secret's rest say, must
  // never land on another card.
  const [keyed, setKeyed] = createSignal<string>()
  const held = createMemo(() => cards().find((q) => q.id === keyed()))
  // The chat's own card in the prompt's place: the one with the keys. Until it has them the prompt stays, so what it
  // holds can be read as the card takes its place.
  const question = createMemo(() => {
    const h = held()
    return h && own().some((q) => q.id === h.id) ? h : undefined
  })
  // A card on the chat (an approval, a question), which takes what room it needs and scrolls in the rest.
  const card = createMemo(() => !codex() && question() !== undefined)
  const permission = usePermission()
  // Whether the chat's mode can be switched here. Never while one of its own cards is open, in its place or waiting:
  // the card hides the prompt and its mode label, and a switch to dontAsk would answer an approval card. A Codex
  // session's card in the chat does neither: the prompt stays under it, and dontAsk leaves it open.
  const switchable = () => permission.mode(props.sessionID) !== null && own().length === 0
  // Whether a stacked card can have the keys: not while one of the chat's own cards holds the prompt's place.
  const stackOpen = createMemo(() => stacked().length > 0 && !question() && (!harnessed() || codex()))
  // The stacked card with the keys, shown whole; every other card shows as a line.
  const active = createMemo(() => {
    const h = held()
    return h && stackOpen() && stacked().some((q) => q.id === h.id) ? h : undefined
  })
  // The chat's own card ctrl+t gives the keys to from the stacked card that has them, which it waits behind.
  const ownNext = createMemo(() => (active() ? own()[0] : undefined))
  // Whether one of the chat's own cards has the keys, and who had them before it took the prompt's place, to get them
  // back once it closes: the stacked card that had them (`backTo`) while it is still open; else the prompt
  // (`promptBack`) when it had them over folded cards or held a draft; else the next card, as any card opening does.
  // The prompt is unmounted while the card shows, so its draft is read as the card takes its place.
  let ownHasKeys = false
  let backTo: string | undefined
  let promptBack = false
  /** Gives the keys to card `next`, or to the prompt. */
  function give(next: string | undefined) {
    const toOwn = !!next && own().some((q) => q.id === next)
    if (toOwn && !ownHasKeys) {
      const k = keyed()
      backTo = k && cards().some((q) => q.id === k) ? k : undefined
      promptBack = (k === undefined && stacked().length > 0) || !!promptRef.current?.current.input
    }
    ownHasKeys = toOwn
    setKeyed(next)
  }
  // Once the card with the keys closes, or while the prompt has them, the usual rules pick who has them next: the
  // chat's own first card takes the prompt's place; once the last closes, whoever had them before it does; else the
  // next stacked card, or, when none were open, the first unless this side's prompt holds a draft. Keys typed for the
  // prompt must never land on a card, where a digit or Enter picks an option.
  let stackWasOpen = false
  createEffect(() => {
    const k = keyed()
    const list = cards()
    const open = stackOpen()
    const opened = open && !stackWasOpen
    stackWasOpen = open
    if (k && list.some((q) => q.id === k)) return
    untrack(() => {
      const first = own()[0]
      if (first) return give(first.id)
      if (ownHasKeys) {
        const to = backTo
        backTo = undefined
        if (to && stacked().some((q) => q.id === to)) return give(to)
        return give(promptBack ? undefined : stacked()[0]?.id)
      }
      if (k || (opened && !promptRef.current?.current.input)) give(stacked()[0]?.id)
    })
  })
  // The lines above the prompt, or above the chat's own card in its place: the stacked card with the keys first, then
  // every other card, the chat's own included, as a line; while no stacked card has the keys, the stacked cards.
  const lines = createMemo(() => {
    const a = active()
    return a ? [a, ...cards().filter((q) => q.id !== a.id)] : stacked()
  })
  // The card whose side chat is showing; the view shows the side session in place of the chat.
  const [sideOf, setSideOf] = createSignal<string>()
  const sideQuestion = createMemo(() => {
    const q = question()
    return q && q.id === sideOf() ? q : undefined
  })
  const sideSession = createMemo(() => office.state.sessions.find((s) => s.id === sideQuestion()?.side_session_id))
  // Until its first message the side session doesn't exist, so the side view starts empty.
  const viewID = createMemo(() => (sideOf() ? sideQuestion()?.side_session_id : props.sessionID))
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
  const [turnStart, setTurnStart] = createSignal<Record<string, true>>()
  createEffect(
    on(
      viewID,
      () => {
        setFrozen(undefined)
        setTurnStart(undefined)
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
        if ((prev[1] && !live) || turns > prev[2]) setTurnStart(assistantIds(messages()))
      },
      { defer: true },
    ),
  )
  /** Esc: freezes the view; the turn after the stopped one starts from what it shows now. */
  function interrupt() {
    // A harness steer joins the live turn, so the next message after it can still be the stopped turn's.
    setFrozen(freeze(messages(), frozen(), harnessed() ? undefined : turnStart()))
    setTurnStart(assistantIds(messages()))
  }
  /**
   * Ends the freeze as the user sends, before the office answers, so the new reply's first
   * message shows even if it streams in first; returns an undo for a send that fails.
   */
  function lift() {
    const start = turnStart()
    // A message to a session between turns starts one.
    if (!interruptible(viewStatus())) setTurnStart(assistantIds(messages()))
    const started = turnStart()
    const f = frozen()
    const lifted = f?.active ? unfreeze(f, messages()) : undefined
    const view = viewID()
    if (lifted) setFrozen(lifted)
    // A newer Esc, or a switch to or from the side view, has since replaced the lifted freeze.
    return () => {
      if (viewID() !== view) return
      if (turnStart() === started) setTurnStart(start)
      if (lifted && frozen() === lifted) setFrozen(f)
    }
  }
  // The side chat closes with its question.
  createEffect(() => {
    if (sideOf() && !sideQuestion()) setSideOf(undefined)
  })
  const person = createMemo(() => personLabel(office.state.people, session()?.person ?? ""))

  if (!props.pane) {
    createEffect(() => {
      const current = session()
      setEpilogue(sessionEpilogue({ title: current ? `${person()} · ${current.cwd}` : "", sessionID: current?.id }))
    })
    onCleanup(() => setEpilogue())
  }

  const dimensions = useTerminalDimensions()
  const [conceal, setConceal] = createSignal(true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)
  const [verbositySetting, setVerbosity] = kv.signal<Verbosity>("session_verbosity", defaultVerbosity)
  const [grouping, setGrouping] = kv.signal<"none" | "auto">("session_grouping", "auto")
  const verbosity = createMemo(() =>
    verbosities.includes(verbositySetting()) ? verbositySetting() : defaultVerbosity,
  )
  const groupExploration = createMemo(() => grouping() !== "none")
  const groups = groupMemory(useRenderer())
  // High opens the reads' and searches' groups by default; everything else starts collapsed.
  const groupExpanded = (groupID: string, kind: GroupKind) =>
    groups.groupExpanded(props.sessionID, groupID) ?? (verbosity() === "high" && kind === "exploration")
  const groupedKind = (kind: GroupKind) => (kind === "exploration" ? groupExploration() : true)

  const instruments = () => props.shells ?? []
  // In a child session (a Codex or Claude Code session an employee's chat drives), the chat that drives it.
  const parentID = createMemo(() => session()?.instrument_of ?? undefined)
  // A child whose session ended takes no message: in its prompt's place the picker, as the upstream TUI shows a
  // subagent's. A live or idle child keeps its prompt, where the owner writes to the harness.
  const readOnly = createMemo(() => !!parentID() && childState(session(), undefined) === "ended")
  // The picker in the prompt's place: opened with ↓, or always in a child that ended. A card takes its place while one
  // is open, a Codex session's in its chat too, as the upstream TUI's permission prompts (its descendants' too) do.
  const [composer, setComposer] = createStore({ open: false, tab: undefined as string | undefined })
  const composerVisible = createMemo(() => readOnly() || (composer.open && cards().length === 0))
  const openingTab = () =>
    busyTab(
      busyCounts({
        family: harnessFamily(office.state, props.sessionID),
        shells: office.state.instruments[props.sessionID] ?? [],
        sessionID: props.sessionID,
      }),
    )
  // The pane's key that goes back to the picker opens it here, as the upstream TUI's opens its Terminals tab.
  props.onPicker?.(() => setComposer({ open: true, tab: openingTab() }))
  onCleanup(() => props.onPicker?.(undefined))
  // A child's picker lists its chat's Codex and Claude Code sessions, which the chat's list names: the chat is loaded
  // too when the child opened first.
  createEffect(
    on(parentID, (parent) => {
      if (parent) office.syncSession(parent).catch(() => {})
    }),
  )
  // A chat shows its Codex sessions' cards. Events bring those they open while the office's stream is up; each live
  // session's open cards are read once more each time the office comes online, for the cards it opened before this
  // view did or while the stream was down, since the office has no replay. Only the cards: not the transcripts.
  const cardsRead = new Set<string>()
  createEffect(() => {
    if (office.status() !== "online") return cardsRead.clear()
    if (parentID()) return
    for (const entry of harnessFamily(office.state, props.sessionID)) {
      if (entry.state === "ended" || cardsRead.has(entry.sessionID)) continue
      cardsRead.add(entry.sessionID)
      office.client.questions
        .list({ session: entry.sessionID, status: "open" })
        .then((open) => Promise.all(open.map((q) => office.putQuestion(q))))
        .catch(() => {})
    }
  })
  // In a child, its name in the chat's list, who drives it and the tokens its harness reported.
  const childInfo = createMemo(() => {
    const current = session()
    const chat = parentID()
    if (!current || !chat) return undefined
    const listed = office.state.instruments[chat]?.find((i) => i.id === current.id)
    const said = current.harness === "claude" ? "Claude Code" : "Codex"
    const used = current.harness_usage
    const tokens = used ? used.input_tokens + used.output_tokens : 0
    return {
      said,
      label: listed ? display(listed.name) : `${said} session`,
      tokens: tokens > 0 ? `${Locale.number(tokens)} tokens` : undefined,
    }
  })
  // A card of one of the chat's Codex or Claude Code sessions says which asks, by its name in the chat's list.
  const askerName = (sessionID: string) =>
    sessionID === props.sessionID
      ? undefined
      : harnessFamily(office.state, props.sessionID).find((entry) => entry.sessionID === sessionID)?.name
  // The session's approver, whose word wins in it (`sessionOwner`).
  const approver = () => sessionOwner(session(), office.state.people)
  // In a Codex or Claude Code session an employee's chat drives, both the owner and the employee write to the
  // harness: each message is labelled with who sent it.
  const speaker = (message: Message) =>
    session()?.instrument_of ? speakerLabel(message.author, approver(), office.state.people) : undefined
  // Its left border takes the speaker's colour, as the upstream TUI's takes a subagent's: the employee's for theirs,
  // the owner's for a message with no other author.
  const speakerColor = (message: Message) => {
    if (!session()?.instrument_of) return undefined
    const owner = approver()
    return local.person.color(message.author && message.author !== owner ? message.author : owner)
  }
  const showTimestamps = createMemo(() => timestamps() === "show")
  // In the pane, the chat's sides take one column each, not two.
  const gutter = () => (props.pane ? 1 : 2)
  const contentWidth = createMemo(() => (props.width ?? dimensions().width) - gutter() * 2)

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const costCap = useCostCap()

  // Whether the session's first read has settled, loaded or not.
  const [settled, setSettled] = createSignal(false)
  createEffect(
    on(
      () => props.sessionID,
      (sessionID) => {
        office
          .syncSession(sessionID)
          .then(() => {
            if (props.sessionID !== sessionID) return
            setSettled(true)
            // A turn may have started before this view opened (the first message is sent from home): it
            // began at the last user message, or begins after what is here now.
            if (turnStart() || viewID() !== sessionID) return
            const list = messages()
            const last = Math.max(list.findLastIndex((m) => m.role === "user"), 0)
            setTurnStart(assistantIds(interruptible(viewStatus()) ? list.slice(0, last) : list))
          })
          .catch((error) => {
            if (props.sessionID !== sessionID) return
            setSettled(true)
            // An office that is down loads the session when it comes back.
            if (error instanceof OfficeUnavailable) return
            const missing = error instanceof OfficeError && error.code === "not_found"
            toast.show({
              message: missing ? `Session not found: ${sessionID}` : errorMessage(error),
              variant: "error",
              duration: 5000,
            })
            // The pane closes on its own once the chat's list drops the session.
            if (!props.pane) navigate({ type: "home" })
          })
      },
    ),
  )

  let seeded = false
  let restored = false
  let scroll: ScrollBoxRenderable
  const [scrollbox, setScrollbox] = createSignal<ScrollBoxRenderable>()
  // Each side has its own prompt ref: the pane's session sits in a provider of its own.
  const bind = (r: PromptRef | undefined) => {
    promptRef.set(r)
    if (seeded || props.pane || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const dialog = useDialog()
  const renderer = useRenderer()
  const anchors = createTimelineAnchors()
  const memory = scrollMemory(renderer)

  let awayTimer: ReturnType<typeof setTimeout> | undefined
  // Whether the reader has left the newest message, which shows "Jump to latest" under the transcript.
  const [awayFromBottom, setAwayFromBottom] = createSignal(false)
  const [latestHovered, setLatestHovered] = createSignal(false)
  createEffect(() => {
    if (!awayFromBottom()) setLatestHovered(false)
  })
  onCleanup(() => {
    if (awayTimer) clearTimeout(awayTimer)
    props.scrollRef?.(undefined)
    if (!scroll || scroll.isDestroyed) return
    scroll.verticalScrollBar.off("change", updateAwayFromBottom)
    saveScrollAnchor(true)
  })

  /** Runs after the next frame's layout and before it paints, unless the transcript was torn down. */
  const afterLayout = (continuation: () => void) => {
    if (!scroll || scroll.isDestroyed) return
    scroll.afterLayout(() => {
      if (!scroll.isDestroyed) continuation()
    })
  }

  // Pin an existing row before publication. Total height also counts streamed output below the
  // reader, which must not move their viewport when it arrives alongside the older rows.
  const pinAbove = () => {
    if (!scroll || scroll.isDestroyed) return
    if (scroll.stickyScroll && scroll.scrollTop >= scroll.scrollHeight - scroll.viewport.height) return
    const node = scroll.getChildren().find((node) => node.height > 0 && node.y + node.height > scroll.viewport.y)
    if (node) afterLayout(scroll.anchor(node))
  }

  // A mounted entry is a message, as upstream's is a row. Its rows, as the budget and the scroll anchor read them: a
  // reply's as it folds them, or a user message or a note whole, as one entry. A message costs what it renders: a
  // reply the weight of its rows, where a folded group costs one. Each is kept per message, so a streamed delta
  // weighs only its own message again.
  const messageViews = mapArray(shown, (message) => {
    const reply =
      message.role === "assistant"
        ? replyRows(() => message, verbosity, (id) => permission.waiting(props.sessionID, id))
        : undefined
    const rows = createMemo((): SessionRow[] => reply?.() ?? [{ type: "part", ref: messageRef(message.id) }])
    const weight = createMemo(() =>
      rows().reduce((total, row) => total + rowWeight(row, { expanded: groupExpanded, grouped: groupedKind }), 0),
    )
    return { rows, weight }
  })
  // Tail-first transcript mounting: only the newest messages mount when the session opens. Older ones mount on demand
  // near the top. While the reader stays at the bottom the hidden span follows appends; leaving the bottom pins it to
  // preserve the viewport.
  const [hiddenRows, setHiddenRows] = createSignal<number>()
  const [visibleRowsEnd, setVisibleRowsEnd] = createSignal<number>()
  const weights = createMemo(() => messageViews().map((view) => view.weight()))
  const hidden = createMemo(() =>
    Math.min(hiddenRows() ?? Infinity, rowsBefore(weights(), shown().length, TRANSCRIPT_TAIL_ROWS)),
  )
  const visibleEnd = createMemo(() => Math.max(hidden(), Math.min(visibleRowsEnd() ?? shown().length, shown().length)))
  const visibleRows = createMemo(() => shown().slice(hidden(), visibleEnd()))
  // Another transcript takes the view (the side chat's, or the chat's again): it opens on its tail.
  createEffect(
    on(
      viewID,
      () =>
        batch(() => {
          setHiddenRows(undefined)
          setVisibleRowsEnd(undefined)
        }),
      { defer: true },
    ),
  )
  /**
   * What a load of older messages into transcript `id` runs as they go in: what the reader sees stays in place, and the
   * mount window keeps its messages, `added` places on. With `mount`, a window that starts at the first message held
   * starts at the first loaded, so the page mounts, as upstream's history prepend mounts it.
   */
  const keepView = (id: string, mount: boolean) => (added: number) => {
    if (viewID() !== id) return
    pinAbove()
    batch(() => {
      setHiddenRows((h) => (h === undefined || (mount && h === 0) ? h : h + added))
      setVisibleRowsEnd((end) => (end === undefined ? end : end + added))
    })
  }
  // The office sends a transcript a page at a time: above the first message held, the page before it loads.
  const prependHistory = createHistoryPrepend({
    sessionID: () => viewID() ?? "",
    more: (id) => id !== "" && office.hasOlder(id),
    loadMore: (id) => office.loadOlder(id, { beforePublish: keepView(id, true) }),
    afterLayout,
    active: (id) => viewID() === id && !!scroll && !scroll.isDestroyed,
    scrollBy: (amount) => {
      scroll.scrollBy(amount)
      updateAwayFromBottom()
    },
  })
  /** Loads every older message of the transcript in view, leaving what the reader sees and what is mounted. */
  const loadAll = async () => {
    const id = viewID()
    if (id && office.hasOlder(id)) await office.loadOlder(id, { all: true, beforePublish: keepView(id, false) })
  }
  let revealingOlderRows = false
  const revealOlderRows = (scrollBy = 0) => {
    const current = hidden()
    if (revealingOlderRows || !scroll || scroll.isDestroyed || scroll.scrollTop > scroll.viewport.height) return false
    if (current === 0) return prependHistory(scrollBy)
    revealingOlderRows = true
    scroll.stickyScroll = false
    pinAbove()
    setHiddenRows(rowsBefore(weights(), current, TRANSCRIPT_BACKFILL_CHUNK))
    afterLayout(() => {
      scroll.scrollBy(scrollBy)
      scroll.stickyScroll = true
      revealingOlderRows = false
    })
    return true
  }
  let revealingNewerRows = false
  const revealNewerRows = (scrollBy = 0) => {
    const current = visibleEnd()
    if (
      revealingNewerRows ||
      current === shown().length ||
      !scroll ||
      scroll.isDestroyed ||
      scroll.scrollTop + scroll.viewport.height < scroll.scrollHeight - scroll.viewport.height
    )
      return false
    revealingNewerRows = true
    const next = rowsAfter(weights(), current, TRANSCRIPT_BACKFILL_CHUNK)
    setVisibleRowsEnd(next === shown().length ? undefined : next)
    afterLayout(() => {
      revealingNewerRows = false
      scroll.scrollBy(scrollBy)
      updateAwayFromBottom()
    })
    return true
  }
  let ensureAllRowsPending: (() => void)[] | undefined
  /** Message navigation needs the full transcript mounted before walking or jumping. */
  const ensureAllRows = (continuation: () => void) => {
    if (!ensureAllRowsPending && hidden() === 0 && visibleEnd() === shown().length) return continuation()
    if (ensureAllRowsPending) {
      ensureAllRowsPending.push(continuation)
      return
    }
    const pending = [continuation]
    ensureAllRowsPending = pending
    // Ours walks from what the reader sees, which the older messages must not move as they mount.
    pinAbove()
    batch(() => {
      setHiddenRows(0)
      setVisibleRowsEnd(undefined)
    })
    afterLayout(() => {
      if (ensureAllRowsPending === pending) ensureAllRowsPending = undefined
      pending.forEach((continuation) => continuation())
      updateAwayFromBottom()
    })
  }

  function isAwayFromBottom() {
    if (revealingOlderRows || revealingNewerRows || ensureAllRowsPending) return true
    if (visibleEnd() < shown().length) return true
    return scroll.scrollTop < Math.max(0, scroll.scrollHeight - scroll.viewport.height)
  }
  function updateAwayFromBottom() {
    const preserveWindow = revealingOlderRows || revealingNewerRows || !!ensureAllRowsPending
    if (isAwayFromBottom()) setHiddenRows((current) => current ?? hidden())
    if (awayTimer) clearTimeout(awayTimer)
    awayTimer = setTimeout(() => {
      awayTimer = undefined
      if (!scroll || scroll.isDestroyed) return
      const away = preserveWindow || isAwayFromBottom()
      setAwayFromBottom(away)
      if (!away) {
        if (!renderer.getSelection()) setHiddenRows(undefined)
        scroll.stickyScroll = true
      }
      saveScrollAnchor()
    })
  }
  function saveScrollAnchor(unmounting = false) {
    // Initial layout must not overwrite the saved position before synchronization restores it. The side chat's
    // transcript is not the session's.
    if (!restored || viewID() !== props.sessionID) return
    const mounted = anchors.list()
    // Solid disposes child registrations before the route's cleanup. Keep the
    // last scroll-event anchor once those children have gone away.
    if (unmounting && !mounted.length) return
    if (!isAwayFromBottom()) {
      memory.setScrollAnchor(props.sessionID, undefined)
      return
    }
    let first: ScrollAnchor | undefined
    let anchor: ScrollAnchor | undefined
    for (const child of mounted) {
      const item = {
        target: child.target,
        screenY: child.node.y - scroll.viewport.y,
      }
      first ??= item
      const inset = item.target.type === "group" || !isMessageRef(item.target.ref) ? 1 : 0
      if (item.screenY <= inset && (!anchor || item.screenY > anchor.screenY)) anchor = item
    }
    anchor ??= first
    memory.setScrollAnchor(props.sessionID, anchor)
  }
  function restoreScrollPosition() {
    const anchor = memory.scrollAnchor(props.sessionID)
    const index = anchor
      ? messageViews().findIndex((view) => view.rows().some((row) => containsAnchor(row, anchor.target)))
      : -1
    if (!anchor || index === -1) {
      scroll.scrollTo(scroll.scrollHeight)
      setAwayFromBottom(false)
      return
    }
    setHiddenRows(rowsBefore(weights(), index, TRANSCRIPT_BACKFILL_CHUNK))
    const end = rowsAfter(weights(), index, TRANSCRIPT_BACKFILL_CHUNK)
    setVisibleRowsEnd(end === shown().length ? undefined : end)
    scroll.stickyScroll = false
    const restore = () =>
      afterLayout(() => {
        const boundary = anchors.get(anchor.target)
        if (!boundary) {
          memory.setScrollAnchor(props.sessionID, undefined)
          scroll.stickyScroll = true
          scroll.scrollTo(scroll.scrollHeight)
          setAwayFromBottom(false)
          return
        }
        const contentY = scroll.scrollTop + boundary.node.y - scroll.viewport.y
        const target = contentY - anchor.screenY
        const maximum = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
        if (target > maximum && visibleEnd() < shown().length) {
          const next = rowsAfter(weights(), visibleEnd(), TRANSCRIPT_BACKFILL_CHUNK)
          setVisibleRowsEnd(next === shown().length ? undefined : next)
          restore()
          return
        }
        scroll.scrollTo(target)
        updateAwayFromBottom()
      })
    restore()
  }
  // Once the session's first read settles, loaded or not, the transcript opens where the reader left it, and from
  // then on where they are is saved.
  createEffect(() => {
    const box = scrollbox()
    if (restored || !settled() || !box || box.isDestroyed) return
    restored = true
    untrack(() => {
      // Initial synchronization can finish after the reader has already navigated.
      if (!isAwayFromBottom()) restoreScrollPosition()
    })
  })

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

  // Scrolls to the next message in `direction`, or by a page when there is none; above the first message held, the
  // page before it loads first.
  const scrollToMessage = (direction: "next" | "prev"): void =>
    ensureAllRows(() => {
      const targetID = findNextVisibleMessage(direction)
      const child = targetID && scroll.getChildren().find((c) => c.id === targetID)
      if (!child && direction === "prev" && prependHistory(0, () => scrollToMessage(direction))) return
      if (child) scroll.scrollBy(child.y - scroll.y - 1)
      else scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      updateAwayFromBottom()
      dialog.clear()
    })

  function toBottom() {
    ensureAllRowsPending?.splice(0)
    ensureAllRowsPending = undefined
    if (awayTimer) clearTimeout(awayTimer)
    awayTimer = undefined
    setAwayFromBottom(false)
    memory.setScrollAnchor(props.sessionID, undefined)
    batch(() => {
      setHiddenRows(undefined)
      setVisibleRowsEnd(undefined)
    })
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.stickyScroll = true
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  /** The first message: every older page loads, the head mounts in the tail's place, and the view goes to the top. */
  function toTop(loaded = false) {
    const id = viewID()
    if (!loaded && id && office.hasOlder(id)) {
      loadAll().then(
        () => viewID() === id && scroll && !scroll.isDestroyed && toTop(true),
        (error) => toast.show({ message: errorMessage(error), variant: "error", duration: 5000 }),
      )
      return
    }
    scroll.stickyScroll = false
    batch(() => {
      setHiddenRows(0)
      const end = rowsAfter(weights(), 0, TRANSCRIPT_BACKFILL_CHUNK)
      setVisibleRowsEnd(end === shown().length ? undefined : end)
    })
    scroll.scrollTo(0)
    afterLayout(() => {
      scroll.scrollTo(0)
      updateAwayFromBottom()
    })
  }

  function moveTranscript(delta: number) {
    if (delta < 0 && revealOlderRows(delta)) return
    if (delta > 0 && revealNewerRows(delta)) return
    scroll.scrollBy(delta)
    updateAwayFromBottom()
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
          .end(props.sessionID)
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
      run: () => costCap.ask(props.sessionID),
    },
    {
      title: "Switch the chat's mode…",
      value: "session.mode",
      category: "Session",
      enabled: switchable(),
      run: () => dialog.replace(() => <DialogMode sessionID={props.sessionID} />),
    },
    {
      // The upstream TUI's "Toggle subagent picker". A click on the line under the prompt names the tab to open on.
      title: "Open an instrument…",
      value: "session.child.first",
      category: "Session",
      enabled: cards().length === 0,
      run: (ctx?: { payload?: unknown }) => {
        const tab = ctx?.payload
        if (tab === "subagents" || tab === "shell") setComposer({ open: true, tab })
        else if (composer.open || readOnly()) setComposer("open", false)
        else setComposer({ open: true, tab: openingTab() })
        dialog.clear()
      },
    },
    {
      title: "Go back to the chat that drives this Codex or Claude Code session",
      value: "session.parent",
      category: "Session",
      enabled: !!parentID(),
      run: () => {
        dialog.clear()
        // In the pane the chat is beside it.
        if (props.pane) return props.pane.leave()
        const parent = parentID()
        if (parent) navigate({ type: "session", sessionID: parent })
      },
    },
    {
      title: "List the chat's rules",
      value: "session.rules",
      category: "Session",
      slash: { name: "rules" },
      run: () => dialog.replace(() => <DialogRules sessionID={props.sessionID} />),
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
      title: groupExploration() ? "Show tool calls individually" : "Group related tool calls",
      value: "session.toggle.exploration_grouping",
      category: "Session",
      run: () => {
        const next = groupExploration() ? "none" : "auto"
        setGrouping(() => next)
        dialog.clear()
      },
    },
    {
      title: `Verbosity: ${Locale.titlecase(verbosity())}`,
      value: "session.verbosity.cycle",
      category: "Session",
      run: () => {
        const next = verbosities[(verbosities.indexOf(verbosity()) + 1) % verbosities.length]
        setVerbosity(() => next)
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
    ...(
      [
        ["Page up", "session.page.up", () => moveTranscript(-scroll.height / 2)],
        ["Page down", "session.page.down", () => moveTranscript(scroll.height / 2)],
        ["Line up", "session.line.up", () => moveTranscript(-1)],
        ["Line down", "session.line.down", () => moveTranscript(1)],
        ["Half page up", "session.half.page.up", () => moveTranscript(-scroll.height / 4)],
        ["Half page down", "session.half.page.down", () => moveTranscript(scroll.height / 4)],
        ["First message", "session.first", () => toTop()],
        ["Last message", "session.last", toBottom],
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
        const last = () => messages().findLast((m) => m.role === "user" && !isInstrumentNote(m) && hasText(m))
        const jump = () =>
          ensureAllRows(() => {
            const message = last()
            const child = message && scroll.getChildren().find((child) => child.id === message.id)
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            updateAwayFromBottom()
          })
        // Past the pages held, it may be in an older one.
        if (last()) jump()
        else loadAll().then(jump, () => {})
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
          await loadAll()
          const text = transcript(true)
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
            true,
            false,
          )
          if (options === null) return
          await loadAll()
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
        enabled: stackOpen() && dialog.stack.length === 0,
        run: () => give(active() ? ownNext()?.id : stacked()[0]?.id),
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
        enabled: switchable() && dialog.stack.length === 0,
        run: () =>
          void permission
            .cycle(props.sessionID)
            .catch((e) => toast.show({ message: errorMessage(e), variant: "error" })),
      },
    ],
    bindings: tuiConfig.keybinds.gather("session.mode", ["session.mode.cycle"]),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("session.global", sessionGlobalBindingCommands),
  }))

  useBindings(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCORP_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  const lastAssistant = createMemo(() => shown().findLast((x) => x.role === "assistant"))
  /** Whether the last reply can still grow: the transcript ends with it, it is the current turn's (a stopped or
   *  finished turn's never grows again), the run is on and Esc hasn't frozen the view. */
  const streaming = () => {
    const last = shown().at(-1)
    return last?.role === "assistant" && !turnStart()?.[last.id] && interruptible(viewStatus()) && !frozen()?.active
  }

  return (
    <context.Provider
      value={{
        anchors,
        get width() {
          return contentWidth()
        },
        sessionID: props.sessionID,
        conceal,
        streaming,
        showTimestamps,
        showGenericToolOutput,
        diffWrapMode,
        verbosity,
        groupExploration,
        groupExpanded,
        setGroupExpanded: (id, expanded, anchor) => {
          // A group that ends the transcript would open off screen while the reader follows the bottom.
          const last = messageViews().at(-1)?.rows().at(-1)
          const ending = last?.type === "group" && groupID(last, 0) === id
          // Keeps the toggled disclosure's header on its viewport row through the next layout.
          if (anchor && !(ending && !isAwayFromBottom())) afterLayout(scroll.anchor(anchor))
          groups.setGroupExpanded(props.sessionID, id, expanded)
          afterLayout(saveScrollAnchor)
        },
        tui: tuiConfig,
        get onOpen() {
          return props.onOpen
        },
      }}
    >
      <box
        flexGrow={1}
        minWidth={0}
        minHeight={0}
        paddingBottom={1}
        paddingLeft={gutter()}
        paddingRight={gutter()}
        gap={1}
      >
        <Show when={session()}>
          {(current) => (
            <>
              <Show when={sideQuestion()}>{(q) => <SideHeader question={q()} session={sideSession()} />}</Show>
              {/* In the pane, the pane's header names it. */}
              <box flexShrink={0} paddingTop={1} visible={!sideOf() && !props.pane}>
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
                {/* A child session: which of the chat's sessions it is, who drives it and its harness's tokens. */}
                <Show when={childInfo()}>
                  {(child) => (
                    <text fg={theme.textMuted} wrapMode="none">
                      <span style={{ fg: theme.text }}>
                        <b>{child().label}</b>
                      </span>
                      {" · "}driven by @{display(current().person)}
                      <Show when={child().tokens}>{(tokens) => <> · {tokens()}</>}</Show>
                    </text>
                  )}
                </Show>
                <Show when={current().model_note}>
                  {(note) => (
                    <text fg={theme.warning} wrapMode="word">
                      {display(note())}
                    </text>
                  )}
                </Show>
              </box>
              <scrollbox
                ref={(r) => {
                  scroll = r
                  setScrollbox(r)
                  props.scrollRef?.(r)
                  scroll.verticalScrollBar.on("change", updateAwayFromBottom)
                }}
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
                onMouseScroll={(event) => {
                  if (event.scroll?.direction === "up" && revealOlderRows()) return
                  if (event.scroll?.direction === "down" && revealNewerRows()) return
                  updateAwayFromBottom()
                }}
              >
                {/* Its index in the whole transcript, so a message keeps its spacing as older ones mount above it. */}
                <For each={visibleRows()}>
                  {(message, index) => (
                    <Switch>
                      <Match when={isInstrumentNote(message)}>
                        <NoteLine message={message} index={index() + hidden()} />
                      </Match>
                      <Match when={message.role === "user"}>
                        <UserMessage
                          index={index() + hidden()}
                          speaker={speaker(message)}
                          speakerColor={speakerColor(message)}
                          onMouseUp={() => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            dialog.replace(() => <DialogMessage messageID={message.id} sessionID={props.sessionID} />)
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
              {/* Upstream's line under the transcript, here in the row the gap leaves above what follows it, so the
                  transcript keeps its height. */}
              <box
                height={1}
                marginTop={-1}
                marginBottom={-1}
                flexShrink={0}
                flexDirection="row"
                justifyContent="flex-end"
              >
                <Show when={awayFromBottom()}>
                  <box
                    id="session-jump-to-latest"
                    paddingLeft={1}
                    onMouseOver={() => setLatestHovered(true)}
                    onMouseOut={() => setLatestHovered(false)}
                    onMouseUp={toBottom}
                  >
                    <text fg={latestHovered() ? theme.text : theme.textMuted}>Jump to latest ↓</text>
                  </box>
                </Show>
              </box>
              <Show when={props.paneNote}>
                {(note) => (
                  <text fg={theme.warning} flexShrink={0} wrapMode="word">
                    {note()}
                  </text>
                )}
              </Show>
              <Show when={props.keysDropped}>
                <text fg={theme.warning} flexShrink={0} wrapMode="word">
                  The {props.keysDropped} closed: keys are dropped until Enter
                </text>
              </Show>
              {/* A card may shrink to what the chat leaves it: its body scrolls in what remains. */}
              <box flexShrink={card() && !composerVisible() ? 1 : 0}>
                <Show when={readOnly() ? childInfo() : undefined}>
                  {(child) => (
                    <text fg={theme.textMuted} wrapMode="word" paddingBottom={1}>
                      This {child().said} session ended. It takes no more messages.
                    </text>
                  )}
                </Show>
                <Composer
                  sessionID={props.sessionID}
                  open={composerVisible()}
                  defaultTab={composer.tab ?? (readOnly() ? "subagents" : undefined)}
                  onClose={() => {
                    // A child that ended has no prompt to go back to: its picker closes to the chat, or closes the
                    // pane it shows in.
                    const parent = parentID()
                    if (readOnly() && props.pane) return props.pane.close()
                    if (readOnly() && parent) return navigate({ type: "session", sessionID: parent })
                    setComposer("open", false)
                  }}
                  shells={instruments()}
                  visibleID={props.visibleID}
                  onOpen={(id) => props.onOpen?.(id)}
                />
                <Show when={!composerVisible()}>
                  {/* Keyed by id, so a card whose question is re-read (a reconnect) keeps its state. */}
                  <For each={lines().map((q) => q.id)}>
                    {(id, i) => (
                      <Show when={office.state.questions[id]}>
                        {(q) =>
                          own().some((o) => o.id === id) ? (
                            <WaitingCard question={q()} next={id === ownNext()?.id} />
                          ) : (
                            <HarnessCard
                              question={q()}
                              asker={askerName(q().session_id)}
                              active={id === active()?.id}
                              waiting={i() > 0 || !stackOpen()}
                              focusLabel={ownNext() && `answer ${personLabel(office.state.people, ownNext()!.asker)}`}
                              onLost={props.onCardLost}
                              // Esc on a Codex session's card in its chat stops that session's turn, not the chat's.
                              onInterrupt={q().session_id === props.sessionID ? interrupt : undefined}
                            />
                          )
                        }
                      </Show>
                    )}
                  </For>
                  <Show
                    when={harnessed()}
                    fallback={
                      <Show
                        when={question()?.id}
                        keyed
                        fallback={
                          <Prompt
                            visible={true}
                            inactive={active() !== undefined}
                            ref={bind}
                            onSend={lift}
                            onSubmit={() => toBottom()}
                            onInterrupt={interrupt}
                            sessionID={props.sessionID}
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
                                onLost={props.onCardLost}
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
                    <Prompt
                      visible={true}
                      inactive={active() !== undefined}
                      ref={bind}
                      onSend={lift}
                      onSubmit={() => toBottom()}
                      onInterrupt={interrupt}
                      sessionID={props.sessionID}
                    />
                  </Show>
                </Show>
              </box>
            </>
          )}
        </Show>
      </box>
    </context.Provider>
  )
}

/** One of the chat's own cards while a card of its Codex sessions has the keys: one line, which takes no keys. The
 *  `next`, which ctrl+t gives the keys to, says so. */
function WaitingCard(props: { question: OfficeQuestion; next: boolean }) {
  const office = useOffice()
  const { theme } = useTheme()
  const focusKey = useCommandShortcut("session.card.focus")
  const title = () => {
    const q = props.question
    if (q.source === "approval") return display(q.title ?? "Permission required")
    return `${personLabel(office.state.people, q.asker)} asks: ${display(q.title ?? q.question)}`
  }
  return (
    <box paddingLeft={2}>
      <text fg={theme.textMuted} wrapMode="none">
        {props.next ? `${title()} · ${focusKey()} to answer` : `${title()} (waiting)`}
      </text>
    </box>
  )
}

function UserMessage(props: {
  message: Message
  onMouseUp: () => void
  index: number
  speaker?: string
  speakerColor?: RGBA
}) {
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
  const [node, setNode] = createSignal<BoxRenderable>()
  useAnchor({ target: () => ({ type: "part", ref: messageRef(props.message.id) }), node })

  return (
    <Show when={text() || files().length}>
      <box
        id={props.message.id}
        ref={(el: BoxRenderable) => {
          alwaysSeparate.add(el)
          setNode(el)
        }}
        border={["left"]}
        // An unread message, which the run's inbox still holds, is grey, as upstream's pending delivery.
        borderColor={props.message.unread ? theme.border : (props.speakerColor ?? theme.secondary)}
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
          <Show when={props.speaker}>
            {(speaker) => <text fg={theme.textMuted}>{display(speaker())}</text>}
          </Show>
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

/**
 * A reply's parts: each run of tool calls grouped as the verbosity says (one folded line at Low), its other parts as
 * they are. The rows are reconciled by key, so a row keeps its view as parts come in.
 */
function AssistantMessage(props: { message: Message; last: boolean }) {
  const ctx = use()
  const office = useOffice()
  const permission = usePermission()
  const [rows, setRows] = createStore<(SessionRow & { key: string })[]>([])
  const next = replyRows(() => props.message, ctx.verbosity, (id) => permission.waiting(ctx.sessionID, id))
  createComputed(() => {
    setRows(reconcile(next().map((row) => ({ ...row, key: rowKey(row) })), { key: "key" }))
  })
  const part = (id: string) => props.message.parts.find((p) => p.id === id)
  // A harness call runs while its session does, as upstream's subagent call runs while its subagent works.
  const item = (ref: PartRef) => {
    const found = part(ref.partID)
    if (found?.type !== "tool") return undefined
    const harness = HARNESS_CALL.test(found.tool)
      ? toolView(found.tool, found.input ?? {}, outputText(found.output)).input
      : undefined
    const busy = harness !== undefined && childRunning(office.state, harnessChild(office.state, ctx.sessionID, harness))
    return { name: toolName(found), state: busy ? ("running" as const) : found.state }
  }
  // Keyed by the part, which the office replaces whole when it changes.
  const entry = (entry: SessionEntry) => (
    <EntryAnchor entry={entry}>
      <Show when={part(entry.ref.partID)} keyed>
        {(found) => <PartView part={found} last={props.last && props.message.parts.at(-1)?.id === found.id} />}
      </Show>
    </EntryAnchor>
  )
  return (
    <For each={rows}>
      {(row) => (
        <Switch>
          <Match when={row.type === "group" ? row : undefined}>
            {(group) => <SessionGroupView row={group()} item={item} entry={entry} />}
          </Match>
          <Match when={row.type === "part" ? row : undefined}>{(row) => entry(row())}</Match>
        </Switch>
      )}
    </For>
  )
}

/** A row's key: a part's id, or a group's. */
function rowKey(row: SessionRow) {
  return row.type === "group" ? (groupID(row, 0) ?? "") : JSON.stringify([row.type, row.ref.messageID, row.ref.partID])
}

function PartView(props: { part: Part; last: boolean }) {
  const component = createMemo(() => PART_MAPPING[props.part.type as keyof typeof PART_MAPPING])
  return (
    <Show when={component()}>
      <Dynamic last={props.last} component={component()} part={props.part as any} />
    </Show>
  )
}

function TextPartView(props: { last: boolean; part: TextPart }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} marginTop={1} flexShrink={0}>
        <markdown
          ref={useSessionLinks(ctx)}
          syntaxStyle={syntax()}
          streaming={props.last && ctx.streaming()}
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
  | "harness"
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

/** An employee's call to a Codex or Claude Code session: the harness's tool group, then the tool. */
const HARNESS_CALL = /^(codex|claude)_(start|send|interrupt|stop|history)$/

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
    case "claude.Bash":
      return { view: "shell", input }
    case "claude.Read":
      return { view: "read", input: pick(input, { filePath: "file_path", offset: "offset", limit: "limit" }) }
    case "claude.Write":
      return { view: "write", input: pick(input, { filePath: "file_path", content: "content" }) }
    case "claude.Edit":
      return {
        view: "edit",
        input: pick(input, {
          filePath: "file_path",
          oldString: "old_string",
          newString: "new_string",
          replaceAll: "replace_all",
        }),
      }
    case "claude.Glob":
    case "claude.Grep":
      return { view: "search", input: pick(input, { pattern: "pattern", path: "path", include: "glob" }) }
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
  const harness = HARNESS_CALL.exec(tool)
  if (harness) {
    // A start names its session only in its reply; the other calls name it in their input.
    const kind = harness[1]!
    const reply = terminalReply(output)
    const session = stringValue(input[kind]) ?? stringValue(reply?.[kind])
    const message = stringValue(input.message)
    const { refused, status, error } = reply ?? {}
    return { view: "harness", input: { harness: kind, call: harness[2], session, message, refused, status, error } }
  }
  return { view: "generic", input }
}

/**
 * The upstream tool a call stands for, by its view, which decides how a run of calls groups and how its summary counts
 * it: `shell` for a command, typed line or shell call; a harness call by its harness (`Codex`), as upstream's subagent
 * call; any other tool by its title or name.
 */
export function toolName(part: ToolPart): string {
  const view = toolView(part.tool, part.input ?? {})
  switch (view.view) {
    case "shell":
    case "typed":
    case "terminal":
      return "shell"
    case "harness":
      return HARNESS_TITLE[view.input.harness as "codex" | "claude"]
    case "generic":
      return view.title ?? part.tool
    default:
      return view.view
  }
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
  const view = createMemo(() => toolView(props.part.tool, props.part.input ?? {}, outputText(props.part.output)))

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
      <Match when={view().view === "harness"}>
        <HarnessCall {...toolprops} />
      </Match>
      <Match when={true}>
        <GenericTool {...toolprops} />
      </Match>
    </Switch>
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
  /** Whether what the call started still runs: its error waits until it stops. */
  running?: boolean
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
  const error = createMemo(() =>
    !props.running && props.part.state === "error" ? (props.part.error ?? "failed") : undefined,
  )
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
              <text fg={theme.textMuted}>
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

/** What a terminal or harness tool's reply says the owner should read: why nothing was done, or why the shell
 *  failed. */
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

/** The chat's session that a harness call's view names, if the chat lists it. */
function harnessChild(state: OfficeState, sessionID: string, input: Record<string, unknown>) {
  const named = stringValue(input.session)
  if (named === undefined) return undefined
  return state.instruments[sessionID]?.find((i) => i.kind === input.harness && i.name === named)
}

/** Whether a listed Codex or Claude Code session runs a turn. */
function childRunning(state: OfficeState, listed: Instrument | undefined) {
  return !!listed && childState(state.sessions.find((s) => s.id === listed.id), listed) === "running"
}

/**
 * An employee's call to a Codex or Claude Code session, as upstream's subagent row: the session by the picker's name
 * (`Codex: codex 1`) and the message, or the call (`interrupt`), then why it was refused or the session failed, as a
 * terminal call says; `✓` once a start is done and `↳` for a call to a session already started, or a spinner while
 * the call or the session runs. A click opens the session in the right pane; a call to a session the chat doesn't list
 * (a start that hasn't replied, or one its host removed) opens nothing.
 */
function HarnessCall(props: ToolProps) {
  const ctx = use()
  const office = useOffice()
  const harness = () => props.input.harness as "codex" | "claude"
  const call = () => stringValue(props.input.call)
  const name = () => stringValue(props.input.session)
  const message = createMemo(() => display(stringValue(props.input.message)?.replace(/\s+/g, " ").trim() ?? ""))
  const child = createMemo(() => harnessChild(office.state, ctx.sessionID, props.input))
  const continuation = () => call() !== "start"
  const isRunning = createMemo(() => running(props.part) || childRunning(office.state, child()))
  const what = () => (call() === "start" || call() === "send" ? message() : call())
  const label = () => {
    const named = name()
    const who = named === undefined ? HARNESS_TITLE[harness()] : `${HARNESS_TITLE[harness()]}: ${display(named)}`
    return what() ? `${who} — ${what()}` : who
  }
  const note = createMemo(() => shellNote(props.input))
  const open = createMemo(() => {
    const id = child()?.id
    const onOpen = ctx.onOpen
    return id && onOpen ? () => onOpen(id) : undefined
  })

  return (
    <InlineTool
      icon={isRunning() ? "│" : continuation() ? "↳" : props.part.state === "completed" ? "✓" : "│"}
      spinner={isRunning()}
      running={isRunning()}
      complete={what()}
      pending="Delegating…"
      part={props.part}
      onClick={open()}
    >
      {label()}
      {note() ? ` · ${note()}` : ""}
    </InlineTool>
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

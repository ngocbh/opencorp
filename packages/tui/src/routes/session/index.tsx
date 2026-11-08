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
  useContext,
} from "solid-js"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import type { ErrorPart, FilePart, Message, Part, TextPart, ToolPart } from "@opencorp/protocol"
import { createTwoFilesPatch } from "diff"
import { useRoute, useRouteData } from "../../context/route"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths } from "../../context/runtime"
import { Spinner } from "../../component/spinner"
import { useTheme } from "../../context/theme"
import { BoxRenderable, ScrollBoxRenderable, TextAttributes, RGBA } from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import { Locale } from "../../util/locale"
import { Dynamic, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogMessage } from "./dialog-message"
import { costLabel, Sidebar } from "./sidebar"
import { filetype } from "../../util/filetype"
import { errorMessage } from "../../util/error"
import { interruptible } from "../../util/status"
import { Toast, useToast } from "../../ui/toast"
import { useCostCap } from "../../component/cost-cap"
import { useKV } from "../../context/kv.tsx"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useEpilogue } from "../../context/epilogue"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript, outputText, personLabel } from "../../util/transcript"
import { sessionEpilogue } from "../../util/presentation"
import { setPreLayoutSiblingMargin } from "../../util/layout"
import { useTuiConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { OPENCORP_BASE_MODE, useBindings } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { useOffice } from "../../context/office"
import { modelLabel, OfficeError, OfficeUnavailable, isNotImplemented, openQuestions, statusLabel } from "@opencorp/client"
import { answerShown } from "../chat/answer"
import { QuestionCard } from "../chat/card"
import { HarnessCard } from "../chat/harness-card"
import { SideChat, SideHeader } from "../chat/side"
import { freeze, frozenList, unfreeze, type Freeze } from "../chat/freeze"
import { display } from "../../util/printable"

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

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)

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
        enabled: codex() && cards().length > 0 && dialog.stack.length === 0,
        run: () => setFocus((f) => (f === "card" ? "prompt" : "card")),
      },
    ],
    bindings: tuiConfig.keybinds.gather("session.card", ["session.card.focus"]),
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
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
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
                <box flexShrink={0}>
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
                        {(_id) => (
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
                        )}
                      </Show>
                    }
                  >
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
          <Toast />
        </box>
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
      </box>
    </context.Provider>
  )
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

export type ToolView = "shell" | "read" | "write" | "edit" | "patch" | "list" | "search" | "question" | "generic"

const pick = (input: Record<string, unknown>, map: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(map).flatMap(([to, from]) => (input[from] === undefined ? [] : [[to, input[from]]])),
  )

/** The renderer for an office tool, by the name the model called it (a workspace tool as `workspace_<tool>`), and
 *  its input renamed to the fields that renderer reads. */
export function toolView(
  tool: string,
  input: Record<string, unknown> = {},
): { view: ToolView; input: Record<string, unknown>; title?: string } {
  switch (tool) {
    case "workspace_read_file":
      return { view: "read", input: pick(input, { filePath: "path", offset: "offset", limit: "limit" }) }
    case "workspace_write_file":
      return { view: "write", input: pick(input, { filePath: "path", content: "content" }) }
    case "workspace_edit_file":
      return {
        view: "edit",
        input: pick(input, { filePath: "path", oldString: "old", newString: "new", replaceAll: "replace_all" }),
      }
    case "workspace_list":
      return { view: "list", input: pick(input, { path: "path" }) }
    case "workspace_search":
      return { view: "search", input: pick(input, { pattern: "pattern", path: "path", include: "glob" }) }
    case "workspace_shell":
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
  const view = createMemo(() => toolView(props.part.tool, props.part.input ?? {}))

  // Completed tools fold away when tool details are hidden.
  const shouldHide = createMemo(() => !ctx.showDetails() && props.part.state === "completed")

  const toolprops = {
    get input() {
      return view().input
    },
    get output() {
      return outputText(props.part.output) || undefined
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
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)

  const error = createMemo(() => (props.part.state === "error" ? (props.part.error ?? "failed") : undefined))
  const note = createMemo(() => approvalNote(props.part.input ?? {}))
  const interrupted = createMemo(() => props.part.state === "interrupted")
  const failed = createMemo(() => Boolean(error()))
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const fg = createMemo(() => {
    if (props.color) return props.color
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

function Shell(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  return (
    <Switch>
      <Match when={output()}>
        <BlockTool part={props.part} onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}>
          <box gap={1}>
            <Show
              when={running(props.part)}
              fallback={
                <text fg={theme.text}>
                  $ {stringValue(props.input.command)}
                  {exitNote(props.input)}
                </text>
              }
            >
              <Spinner color={theme.text}>{stringValue(props.input.command)}</Spinner>
            </Show>
            <text fg={theme.text}>{limited()}</text>
            <Show when={collapsed().overflow}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="$"
          pending="Writing command…"
          complete={stringValue(props.input.command)}
          spinner={running(props.part) && !!stringValue(props.input.command)}
          part={props.part}
        >
          {stringValue(props.input.command)}
          {exitNote(props.input)}
        </InlineTool>
      </Match>
    </Switch>
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

import { createStore } from "solid-js/store"
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { Portal, useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import type { AnswerRequest, Question } from "@opencorp/protocol"
import { OfficeError, isNotImplemented } from "@opencorp/client"
import { useTheme, selectedForeground } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { useOffice } from "../../context/office"
import { usePermission } from "../../context/permission"
import { filetype } from "../../util/filetype"
import { getScrollAcceleration } from "../../util/scroll"
import { useTuiConfig } from "../../config"
import { useBindings, useCommandShortcut, useOpenCorpModeStack } from "../../keymap"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { createReadThrough, wrap } from "../../ui/read-through"
import { errorMessage } from "../../util/error"
import { display } from "../../util/printable"
import { personLabel } from "../../util/transcript"
import { permissionAlwaysLines, permissionOptions, permissionPresentation } from "../../util/permission"
import { leaveBindings } from "../chat/leave"
import { QUESTION_MODE } from "../chat/question-view"

type PermissionStage = "permission" | "always" | "reject"

type Tone = "text" | "muted" | "warning"
/** A line of the prompt, before it is wrapped: its colour, and a leading mark of `len` characters (an icon) drawn in
 *  a colour of its own. */
type Line = { text: string; tone: Tone; mark?: { len: number; tone: Tone } }
/** A line wrapped to the prompt's width: what one row on screen draws. */
type Row = Line

/** Shown in place of the choices until the card's last row has been on screen. */
const READ_ON = "Read to the end (PageDown, Space, arrows) to see the choices"
/** The columns the bar and the padding take on each row, beside the box's own width. */
const TEXT_INSET = 6
/** The rows the prompt itself takes beside its header, body and footer: the box's padding, the gap under the
 *  header, and the footer's padding. */
const CHROME = 5
/** The rows of the chat the prompt leaves: its header, gaps and padding, and a few rows of transcript. */
const CHAT_RESERVE = 8
/** The rows full screen leaves above and below the box. */
const FULL_MARGIN = 2

/** `lines` wrapped to `width`, one row each as the screen draws it: a line break starts a row, and a line wider than
 *  the box wraps whole, never cut. */
function wrapLines(lines: readonly Line[], width: number): Row[] {
  return lines.flatMap((line) =>
    line.text.split("\n").flatMap((part, p) =>
      wrap(part.replace(/\t/g, "  "), width).map((text, i) => ({
        text,
        tone: line.tone,
        ...(line.mark && p === 0 && i === 0 && { mark: line.mark }),
      })),
    ),
  )
}

/** A file change's diff in a scroll box, split above 120 columns. No approval card edits a file yet. */
export function EditBody(props: { file: string; diff: string }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()

  const view = createMemo(() => {
    const diffStyle = config.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.file))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={props.diff}>
        <scrollbox
          height="100%"
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <diff
            diff={props.diff}
            view={view()}
            filetype={ft()}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
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
        </scrollbox>
      </Show>
      <Show when={!props.diff}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>No diff provided</text>
        </box>
      </Show>
    </box>
  )
}

/**
 * The open approval card `question`: what the agent wants to run, why, and why policy asks, then Yes, "don't ask
 * again this session" and "always" when the card offers them, and No with what to do instead. Its choices appear only
 * once the card's last row has been on screen; the selection starts on No, a digit only selects, and Enter confirms.
 * "Don't ask again" and "always" show the exact rules on a page of their own first. Esc asks to stop the agent, and
 * Ctrl+C leaves as on any card. `width` is the chat's width, which the prompt draws in.
 */
export function PermissionPrompt(props: { question: Question | undefined; width: number }) {
  const office = useOffice()
  const permission = usePermission()
  const toast = useToast()
  const dialog = useDialog()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpenCorpModeStack()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
    always: "session" as "session" | "always",
  })
  const [confirming, setConfirming] = createSignal(false)

  // The prompt stays mounted while its question is replaced by a newer copy (a reconnect re-reads it); keep the last
  // copy for the moment the question goes before the prompt does.
  const question = createMemo<Question>((prev) => props.question ?? prev, props.question!)
  const asker = createMemo(() => personLabel(office.state.people, question().asker))
  const choices = createMemo(() => permissionOptions(question().options ?? []))
  const presentation = createMemo(() =>
    permissionPresentation(question().approval ?? { tool: "?" }, display(question().question)),
  )
  // Its place among the session's open approval cards, oldest first.
  const count = createMemo(() => {
    const open = permission.cards(question().session_id)
    const at = open.findIndex((q) => q.id === question().id)
    return open.length > 1 && at >= 0 ? ` · ${at + 1} of ${open.length}` : ""
  })

  // Base-mode keys (the prompt's, Shift+Tab's mode switch) are off while the card shows.
  onMount(() => {
    const popMode = modeStack.push(QUESTION_MODE)
    onCleanup(popMode)
  })

  const header = createMemo((): Line[] => {
    const p = presentation()
    const title = display(question().title ?? "Permission required")
    return [
      { text: `△ ${title}${count()}`, tone: "text", mark: { len: 1, tone: "warning" } },
      { text: `  ${p.icon} ${p.title}`, tone: "text", mark: { len: 2 + p.icon.length, tone: "muted" } },
    ]
  })
  const body = createMemo((): Line[] => {
    const approval = question().approval
    const why = display(approval?.why ?? "").trim()
    const reason = display(approval?.reason ?? "").trim()
    const notes: Line[] = [
      ...(why ? [{ text: `Why: ${why}`, tone: "muted" as const }] : []),
      ...(reason ? [{ text: `Asking because: ${reason}`, tone: "muted" as const }] : []),
    ]
    return [
      ...presentation().lines.map((text): Line => ({ text, tone: "text" })),
      ...(notes.length > 0 ? [{ text: "", tone: "text" as const }, ...notes] : []),
    ]
  })
  const alwaysHeader = createMemo((): Line[] => [
    {
      text: `△ ${store.always === "session" ? "Don't ask again this session" : "Always allow"}`,
      tone: "text",
      mark: { len: 1, tone: "warning" },
    },
  ])
  const alwaysBody = createMemo((): Line[] =>
    permissionAlwaysLines(store.always, question().approval?.rules ?? [], question().asker).map((text, i) => ({
      text,
      tone: i === 0 ? "muted" : "text",
    })),
  )
  // In the order the office offers them, then No.
  const options = createMemo(
    (): Record<string, string> => ({
      ...(choices().yes ? { yes: "Yes" } : {}),
      ...(choices().session ? { session: "Don't ask again this session" } : {}),
      ...(choices().always ? { always: "Always allow" } : {}),
      no: "No",
    }),
  )

  // One office call at a time: a second answer or stop while one is in flight would race it.
  let sending = false
  function call(run: () => Promise<unknown>) {
    if (sending) return toast.show({ message: "Busy: the last action is still sending", variant: "info" })
    sending = true
    run().finally(() => (sending = false))
  }

  function send(req: AnswerRequest) {
    const id = question().id
    call(() =>
      office.client.questions
        .answer(id, req)
        .then((q) => office.putQuestion(q))
        .catch((error) => {
          if (error instanceof OfficeError && error.status === 409) {
            toast.show({ message: "This question was already answered", variant: "warning" })
            return office.refreshQuestion(id).catch(() => {})
          }
          toast.show({ title: "Answering failed", message: errorMessage(error), variant: "error" })
        }),
    )
  }

  /** The card's stop: the office interrupts the agent, which answers its open cards. */
  function stop() {
    setConfirming(false)
    call(() =>
      office.client.questions
        .stop(question().id)
        .then((q) => office.putQuestion(q))
        .catch((error) => {
          if (isNotImplemented(error))
            return toast.show({ message: "Stopping a question is not available yet", variant: "warning" })
          toast.show({ title: "Stopping failed", message: errorMessage(error), variant: "error" })
        }),
    )
  }

  onCleanup(() => {
    // The prompt closes when its question does; say so when that was the run restarting.
    const q = office.state.questions[question().id]
    if (q?.status === "stale")
      toast.show({
        message: `${asker()}'s approval card expired: the run restarted`,
        variant: "warning",
        duration: 5000,
      })
  })

  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: confirming() && dialog.stack.length === 0,
    bindings: [
      { key: "y", desc: "Stop the agent", group: "Permission", cmd: () => stop() },
      ...["n", "escape", "return"].map((key) => ({
        key,
        desc: "Keep the card",
        group: "Permission",
        // Returns nothing: the keymap takes a false return as unhandled and passes the key on.
        cmd: () => {
          setConfirming(false)
        },
      })),
      ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
    ],
  }))

  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <Prompt
          header={alwaysHeader()}
          body={alwaysBody()}
          options={{ confirm: "Confirm", cancel: "Cancel" }}
          start="cancel"
          width={props.width}
          fullscreen
          hints={[{ key: "esc", label: "back" }]}
          enabled={true}
          onEscape={() => setStore("stage", "permission")}
          onSelect={(option) => {
            if (option === "cancel") return setStore("stage", "permission")
            const answer = store.always === "session" ? choices().session : choices().always
            if (answer) send({ answer, answer_kind: "option" })
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          asker={asker()}
          onConfirm={(message) => {
            // A blank No isn't an answer the office takes; the box stays open.
            const text = message.trim()
            if (text) send({ answer: text, answer_kind: "text" })
          }}
          onCancel={() => setStore("stage", "permission")}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        <Prompt
          header={header()}
          body={body()}
          options={options()}
          start="no"
          width={props.width}
          fullscreen
          hints={[{ key: "esc", label: `stop ${asker()}` }]}
          notice={confirming() ? `Stop ${asker()}? y/N` : undefined}
          enabled={!confirming()}
          onEscape={() => setConfirming(true)}
          onSelect={(option) => {
            if (option === "yes") return send({ answer: choices().yes!, answer_kind: "option" })
            if (option === "session" || option === "always") return setStore({ stage: "always", always: option })
            setStore("stage", "reject")
          }}
        />
      </Match>
    </Switch>
  )
}

function RejectPrompt(props: { asker: string; onConfirm: (message: string) => void; onCancel: () => void }) {
  let input: TextareaRenderable
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)

  /** Empties the box; false when it is already empty, so the key goes on to leave. */
  function clear() {
    if (!input || input.isDestroyed || !input.plainText) return false
    input.setText("")
    return true
  }

  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "escape", desc: "Back to the choices", group: "Permission", cmd: () => props.onCancel() },
      {
        key: "return",
        desc: "Say no, with these words",
        group: "Permission",
        cmd: () => props.onConfirm(input.plainText),
      },
      // Ctrl+C in a box with text clears it; on an empty box it leaves, as on any card.
      ...tuiConfig.keybinds
        .get("prompt.clear")
        .map((b) => ({ ...b, desc: "Clear the box", group: "Input", cmd: clear })),
      ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
    ],
  }))

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.error}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.error}>{"△"}</text>
          <text fg={theme.text}>No</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>{`Tell ${props.asker} what to do instead`}</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          ref={(val: TextareaRenderable) => {
            input = val
            val.traits = { status: "REJECT" }
          }}
          focused
          flexGrow={1}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.primary}
          cursorStyle={tuiConfig.cursor}
        />
        <box flexDirection="row" gap={2} flexShrink={0}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>send</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>back</span>
          </text>
        </box>
      </box>
    </box>
  )
}

/**
 * A page of the prompt: a header, a body read in a viewport the prompt scrolls, and a row of options under it. The
 * body's lines are wrapped to the box's width and each row is drawn unwrapped, so the rows counted are the rows on
 * screen. The options, their keys, clicks and Enter wait until the body's last row has been on screen; until then the
 * footer says to read on. A resize or full screen re-wraps the body and starts it again at the top. The selection
 * starts on `start`; left/right and h/l move it, a digit only selects, and Enter confirms.
 */
function Prompt<const T extends Record<string, string>>(props: {
  header: Line[]
  body: Line[]
  options: T
  start: keyof T
  width: number
  fullscreen?: boolean
  hints?: { key: string; label: string }[]
  /** Replaces the footer, such as a confirmation. */
  notice?: string
  /** Whether its keys work; off while a caller's confirmation has them. */
  enabled: boolean
  onEscape: () => void
  onSelect: (option: keyof T) => void
}) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const keys = createMemo(() => Object.keys(props.options) as (keyof T)[])
  const [store, setStore] = createStore({
    selected: props.start,
    expanded: false,
  })
  const fullscreenHint = useCommandShortcut("permission.prompt.fullscreen")

  // The box is the chat's width, or full screen the screen's less its margins; text gets what the bar and padding
  // leave.
  const width = createMemo(() => Math.max(1, (store.expanded ? dimensions().width - 4 : props.width) - TEXT_INSET))
  const headerRows = createMemo(() => wrapLines(props.header, width()))
  // Wrapped anew when the width changes or full screen toggles; either starts the count again.
  const rows = createMemo(() => {
    void store.expanded
    return wrapLines(props.body, width())
  })

  const hints = createMemo(() => [
    ...(props.fullscreen ? [{ key: fullscreenHint(), label: store.expanded ? "minimize" : "fullscreen" }] : []),
    { key: "⇆", label: "select" },
    { key: "enter", label: "confirm" },
    ...(props.hints ?? []),
  ])
  const hintText = createMemo(() =>
    hints()
      .map((h) => `${h.key} ${h.label}`)
      .join("  "),
  )
  const hintsFit = createMemo(() => Bun.stringWidth(hintText()) <= width())
  const hintRows = createMemo(() => (hintsFit() ? 1 : wrap(hintText(), width()).length))
  // The options in a row with the hints beside them, in a row above the hints, or one per row when even they don't fit.
  const optionsWidth = createMemo(() =>
    keys().reduce((n, k, i) => n + Bun.stringWidth(props.options[k]!) + 2 + (i > 0 ? 1 : 0), 0),
  )
  const layout = createMemo((): "row" | "column" | "stacked" => {
    if (optionsWidth() + 2 + Bun.stringWidth(hintText()) <= width()) return "row"
    return optionsWidth() <= width() ? "column" : "stacked"
  })
  const readOn = createMemo(() => wrap(READ_ON, width()))
  const noticeRows = createMemo(() => (props.notice ? wrap(props.notice, width()) : []))
  // The footer holds whichever is tallest of the read-on line, the choices and a notice, so the body's viewport keeps
  // its height when one replaces another.
  const footerRows = createMemo(() => {
    const choices = layout() === "row" ? 1 : (layout() === "column" ? 1 : keys().length) + hintRows()
    return Math.max(readOn().length, choices, noticeRows().length)
  })

  // The body's viewport: every row when they fit in what the screen leaves, else that less the position line.
  const room = createMemo(
    () =>
      dimensions().height -
      (store.expanded ? FULL_MARGIN : CHAT_RESERVE) -
      CHROME -
      headerRows().length -
      footerRows(),
  )
  const fits = createMemo(() => rows().length <= room())
  const view = createMemo(() => (fits() ? rows().length : Math.max(1, room() - 1)))
  const maxTop = createMemo(() => Math.max(0, rows().length - view()))
  // The scroll position, for the rows it was set on: rows wrapped anew start at the top.
  const [scroll, setScroll] = createSignal<{ rows?: Row[]; top: number }>({ top: 0 })
  const top = () => {
    const s = scroll()
    return s.rows === rows() ? Math.min(s.top, maxTop()) : 0
  }
  const scrollTo = (t: number) => setScroll({ rows: rows(), top: Math.max(0, Math.min(maxTop(), t)) })
  const read = createReadThrough({ rows, top, view, ready: () => true })
  const visible = createMemo(() => rows().slice(top(), top() + view()))
  const position = createMemo(() => {
    const total = rows().length
    return `lines ${Math.min(top() + 1, total)}–${Math.min(top() + view(), total)} of ${total}`
  })

  const move = (by: number) => {
    const list = keys()
    const idx = list.indexOf(store.selected)
    setStore("selected", list[(idx + by + list.length) % list.length]!)
  }
  const page = () => Math.max(1, view() - 1)

  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: props.enabled && dialog.stack.length === 0,
    commands: [
      {
        name: "permission.prompt.fullscreen",
        title: "Show the approval full screen, or back",
        category: "Permission",
        hidden: true,
        run() {
          if (props.fullscreen) setStore("expanded", (v) => !v)
        },
      },
    ],
    bindings: [
      // The body scrolls whether or not it has been read.
      ...(
        [
          ["pageup", () => scrollTo(top() - page())],
          ["pagedown", () => scrollTo(top() + page())],
          ["space", () => scrollTo(top() + page())],
          ["home", () => scrollTo(0)],
          ["end", () => scrollTo(maxTop())],
          ["up", () => scrollTo(top() - 1)],
          ["k", () => scrollTo(top() - 1)],
          ["down", () => scrollTo(top() + 1)],
          ["j", () => scrollTo(top() + 1)],
        ] as const
      ).map(([key, run]) => ({
        key,
        desc: "Scroll the card",
        group: "Permission",
        cmd: () => {
          run()
        },
      })),
      // The choices' keys only once the card has been read.
      ...(read()
        ? [
            ...["left", "h"].map((key) => ({ key, desc: "Previous option", group: "Permission", cmd: () => move(-1) })),
            ...["right", "l"].map((key) => ({ key, desc: "Next option", group: "Permission", cmd: () => move(1) })),
            // A digit only selects: choosing is deliberate, with Enter on the selected option.
            ...keys().map((option, i) => ({
              key: String(i + 1),
              desc: `Select option ${i + 1}`,
              group: "Permission",
              cmd: () => {
                setStore("selected", option)
              },
            })),
            {
              key: "return",
              desc: "Confirm the selected option",
              group: "Permission",
              cmd: () => props.onSelect(store.selected),
            },
          ]
        : []),
      { key: "escape", desc: "Stop, or back", group: "Permission", cmd: () => props.onEscape() },
      ...(props.fullscreen ? tuiConfig.keybinds.get("permission.prompt.fullscreen") : []),
      ...leaveBindings(tuiConfig.keybinds.get("app.exit")),
    ],
  }))

  useRenderer()

  const color = (tone: Tone) => (tone === "muted" ? theme.textMuted : tone === "warning" ? theme.warning : theme.text)
  /** Rows drawn as they are, each no wider than the box: a row's mark in its own colour. */
  const plain = (list: readonly Row[]) => (
    <For each={list}>
      {(row) => (
        <Show
          when={row.mark}
          fallback={
            <text fg={color(row.tone)} wrapMode="none">
              {row.text === "" ? " " : row.text}
            </text>
          }
        >
          {(mark) => (
            <text fg={color(row.tone)} wrapMode="none">
              <span style={{ fg: color(mark().tone) }}>{row.text.slice(0, mark().len)}</span>
              {row.text.slice(mark().len)}
            </text>
          )}
        </Show>
      )}
    </For>
  )
  const muted = (list: readonly string[], tone: Tone) => plain(list.map((text) => ({ text, tone })))

  const content = () => (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : { position: "relative" })}
    >
      <box paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <box paddingLeft={1} flexShrink={0}>
          {plain(headerRows())}
        </box>
        <box paddingLeft={1} marginTop={1} height={view()} flexShrink={0}>
          {plain(visible())}
        </box>
        <Show when={!fits()}>
          <box paddingLeft={1} flexShrink={0}>
            <text fg={theme.textMuted} wrapMode="none">
              {position()}
            </text>
          </box>
        </Show>
      </box>
      <box
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
      >
        <box
          height={footerRows()}
          flexShrink={0}
          flexDirection={read() && !props.notice && layout() === "row" ? "row" : "column"}
          justifyContent={read() && !props.notice && layout() === "row" ? "space-between" : "flex-start"}
        >
          <Switch>
            <Match when={props.notice}>{muted(noticeRows(), "warning")}</Match>
            <Match when={!read()}>
              <For each={readOn()}>
                {(row) => (
                  <text fg={theme.accent} wrapMode="none">
                    {row}
                  </text>
                )}
              </For>
            </Match>
            <Match when={true}>
              <box
                flexDirection={layout() === "stacked" ? "column" : "row"}
                gap={layout() === "stacked" ? 0 : 1}
                flexShrink={0}
              >
                <For each={keys()}>
                  {(option) => (
                    <box
                      paddingLeft={1}
                      paddingRight={1}
                      flexShrink={0}
                      backgroundColor={option === store.selected ? theme.warning : theme.backgroundMenu}
                      onMouseOver={() => setStore("selected", option)}
                      onMouseUp={() => {
                        setStore("selected", option)
                        props.onSelect(option)
                      }}
                    >
                      <text
                        fg={option === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}
                        wrapMode="none"
                      >
                        {props.options[option]}
                      </text>
                    </box>
                  )}
                </For>
              </box>
              <Show when={hintsFit()} fallback={muted(wrap(hintText(), width()), "muted")}>
                <box flexDirection="row" gap={2} flexShrink={0}>
                  <For each={hints()}>
                    {(hint) => (
                      <text fg={theme.text} wrapMode="none">
                        {hint.key} <span style={{ fg: theme.textMuted }}>{hint.label}</span>
                      </text>
                    )}
                  </For>
                </box>
              </Show>
            </Match>
          </Switch>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}

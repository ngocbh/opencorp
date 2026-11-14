import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, type ParentProps } from "solid-js"
import type { SetupAsk, SetupChoose, SetupSecret } from "@opencorp/protocol"
import { Spinner } from "../component/spinner"
import { useTuiConfig } from "../config"
import { useTheme } from "../context/theme"
import { clearFirst, useBindings } from "../keymap"
import { QuestionView } from "../routes/chat/question-view"
import { SplitBorder } from "../ui/border"
import type { SetupChild } from "./child"
import { SecretInput } from "./secret"

type File = { name: string; lines: string[] }
type Entry =
  | { kind: "step"; counter: string; title: string; why: string }
  | { kind: "say"; text: string }
  | { kind: "answer"; question: string; shown: string }
  | { kind: "result"; title: string; ok: boolean; lines: string[] }
  | { kind: "away"; why: string }

/** A command or the files to save, shown whole in a pager the owner reads before they can approve it. */
type Card =
  | { kind: "command"; title: string; warning: string; lines: string[] }
  | { kind: "review"; title: string; files: File[]; risks: string[]; warning: string }

/** The approval the pager gates, once its card has been read: the question and the two options. */
type Gate = { question: string; options: string[]; default: string }

/** `text` with the user and password taken out of any URL in it, as the install's `redact` does. */
function redact(text: string) {
  return text.replace(/(?<=:\/\/)[^/@\s]+@/g, "***@")
}

/** A model's question as it's shown, by the rule the office's `shownCode` follows for commands: indentation of up to
 *  16 spaces as is, deeper indentation and any later run of four or more spaces as `<N spaces>`, and every tab as
 *  `<TAB>`, so padding can't push the answer box or the rest off the screen. */
function oneLine(text: string) {
  const indent = /^ */.exec(text)![0]
  const rest = text
    .slice(indent.length)
    .replace(/\t/g, "<TAB>")
    .replace(/ {4,}/g, (run) => `<${run.length} spaces>`)
  return (indent.length <= 16 ? indent : `<${indent.length} spaces>`) + rest
}

/** How long input is drained when the screen comes back, as the visit drains before a reconnect. */
const DRAIN_MS = 50

/** The heading above a review's risks. */
const BEFORE_SAVING = "Before you save it:"
/** Shown while a card is still taller than the pager: the owner reads to the end before the choices appear. */
const READ_ON = "Read to the end before you choose — PageDown, or End to jump there."
/** Shown once the whole card has been read, above the choices. */
const CHOOSE = "↑↓ choose · Enter"

/** A row of a card as the pager draws it, with the colour its source line asks for. */
type Row = { text: string; tone: "title" | "warn" | "code" | "text" }

/** `line` broken into pieces no wider than `width`, so a line wider than the screen wraps whole and never clips; an
 *  empty line stays one row. */
function wrap(line: string, width: number): string[] {
  if (line === "") return [""]
  const rows: string[] = []
  let row = ""
  let cells = 0
  // By grapheme and by the cells each takes, so a wide character counts as two and a surrogate pair is never split.
  for (const { segment } of graphemes.segment(line)) {
    const w = Bun.stringWidth(segment)
    if (cells + w > width && row !== "") {
      rows.push(row)
      row = ""
      cells = 0
    }
    row += segment
    cells += w
  }
  rows.push(row)
  return rows
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** How many rows `text` takes word-wrapped to `width` cells (a word wider than a row breaks across rows). */
function wordWrapRows(text: string, width: number): number {
  let total = 0
  for (const paragraph of text.split("\n")) {
    let rows = 1
    let used = 0
    for (const word of paragraph.split(" ")) {
      const w = Bun.stringWidth(word)
      if (used > 0 && used + 1 + w <= width) {
        used += 1 + w
        continue
      }
      if (used === 0 && w <= width) {
        used = w
        continue
      }
      if (used > 0) rows++
      const extra = Math.max(0, Math.ceil(w / width) - 1)
      rows += extra
      used = w - extra * width
    }
    total += rows
  }
  return total
}

/** The screen's and the pager's side padding: the pager wraps its rows to what is left of the width once both are
 *  taken, the same width it draws them in. */
const SCREEN_PAD = 2
const PAGER_PAD = 2

/** The card as rows: its lines, tagged with a tone and wrapped to `width`, so the pager shows every character. */
function cardRows(card: Card, width: number): Row[] {
  const w = Math.max(1, width)
  const out: Row[] = []
  const push = (tone: Row["tone"], text: string) => {
    for (const piece of wrap(text, w)) out.push({ text: piece, tone })
  }
  push("title", card.title)
  if (card.kind === "command") {
    if (card.warning) push("warn", card.warning)
    for (const line of card.lines) push("code", line)
  } else {
    for (const file of card.files) {
      push("text", `${file.name}:`)
      for (const line of file.lines) push("code", line)
    }
    if (card.risks.length > 0) {
      push("text", BEFORE_SAVING)
      for (const risk of card.risks) push("text", `  - ${risk}`)
    }
    if (card.warning) push("warn", card.warning)
  }
  return out
}

/**
 * The install's steps and answers, its pending question in a panel, and a spinner while it works; Ctrl-C asks it to
 * stop. A command and the files to save are shown in a pager, whose choices appear only once the owner has read to
 * the card's last line, so what they approve is what runs. When the child hands the terminal over, the screen steps
 * aside, `notice` says why on the plain terminal, and the child is told it has it, until it takes the terminal back.
 * The header reads `title` (default "Setting up OpenCorp") and `command`. The transcript scrolls with
 * PageUp/PageDown, the arrows and Home/End.
 */
export function SetupScreen(props: {
  child: SetupChild
  lines: string[]
  command?: string
  title?: string
  notice?: (text: string) => void
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [entries, setEntries] = createSignal<Entry[]>([])
  const [pending, setPending] = createSignal<SetupAsk | SetupChoose | SetupSecret>()
  const [card, setCard] = createSignal<Card>()
  const [stopping, setStopping] = createSignal(false)
  const [transcriptPos, setTranscriptPos] = createSignal("")
  let scroll: ScrollBoxRenderable | undefined
  // Whether opentui's SIGWINCH listener was taken off for a hand-over, so take_back puts it back.
  let resizeDetached = false

  /** Shows `entry` now; `printed` are its lines in the transcript printed once the screen is gone. */
  const add = (entry: Entry, ...printed: string[]) => {
    props.lines.push(...printed)
    setEntries((all) => [...all, entry])
  }

  /** A command or the files to save show in the pager, not the transcript; the printed transcript keeps them. */
  const printCard = (...printed: string[]) => props.lines.push(...printed)

  props.child.onPrompt((prompt) => {
    if (prompt.type === "step") {
      const counter = `Step ${prompt.number} of ${prompt.total}`
      add({ kind: "step", counter, title: prompt.title, why: prompt.why }, `${counter}: ${prompt.title}`, prompt.why)
    } else if (prompt.type === "say") add({ kind: "say", text: prompt.text }, prompt.text)
    else if (prompt.type === "command") {
      const warning = prompt.warning ?? ""
      setCard({ kind: "command", title: prompt.title, warning, lines: prompt.lines })
      printCard(prompt.title, ...(warning ? [warning] : []), ...prompt.lines)
    } else if (prompt.type === "result")
      // Its output reached the terminal as it came, so the transcript keeps only how it ended.
      add({ kind: "result", title: prompt.title, ok: prompt.ok, lines: prompt.lines ?? [] }, prompt.title)
    else if (prompt.type === "review") {
      const risks = prompt.risks ?? []
      const warning = prompt.warning ?? ""
      setCard({ kind: "review", title: prompt.title, files: prompt.files, risks, warning })
      printCard(
        prompt.title,
        ...prompt.files.flatMap((f) => [`${f.name}:`, ...f.lines]),
        ...(risks.length > 0 ? [BEFORE_SAVING, ...risks.map((r) => `  - ${r}`)] : []),
        ...(warning ? [warning] : []),
      )
    } else if (prompt.type === "hand_over") {
      // As `$EDITOR` gets it: the screen's keys, raw mode and drawing stop until take_back. The line goes on the
      // plain terminal, above ssh's prompts.
      add({ kind: "away", why: prompt.why })
      if (!renderer.isDestroyed) {
        // Nothing is written to the terminal while ssh may be reading it: opentui's resize handler would answer a
        // window change with a size query (ESC[14t), which would land in ssh's password read.
        resizeDetached = detachResize(renderer)
        renderer.suspend()
        renderer.currentRenderBuffer.clear()
      }
      props.notice?.(`\n${prompt.why}\n`)
      props.child.answer("")
    } else if (prompt.type === "take_back") {
      if (renderer.isDestroyed) return
      renderer.currentRenderBuffer.clear()
      const stdin = (renderer as unknown as { stdin: NodeJS.ReadStream }).stdin
      // On a real terminal, discard what the kernel buffered while the child held it (ssh's menu, a stray Enter)
      // before the screen listens again, as the visit's `drain` does; stdin has no screen listener and is paused
      // here. A test renderer's stdin isn't the process's and holds nothing, so it just comes back.
      if (stdin === process.stdin && stdin.isTTY) void drainThenResume(stdin)
      else resumeScreen()
    } else setPending(prompt)
  })

  /** Brings the screen back: redraws, and puts the resize handler back, taking the new size now, when a query is
   *  safe again. */
  const resumeScreen = () => {
    if (renderer.isDestroyed) return
    renderer.resume()
    if (resizeDetached) attachResize(renderer)
    resizeDetached = false
    renderer.requestRender()
  }

  /** Reads and throws away what `stdin` buffered while the child held the terminal, for `DRAIN_MS`, then brings the
   *  screen back. */
  const drainThenResume = async (stdin: NodeJS.ReadStream) => {
    const discard = () => {}
    try {
      stdin.on("data", discard)
      stdin.resume()
      await new Promise((r) => setTimeout(r, DRAIN_MS))
      stdin.off("data", discard)
      stdin.pause()
    } catch {}
    resumeScreen()
  }

  /** Sends `text` as the answer, shows the question answered with `shown`, clears any card, waits for the next. */
  const answer = (question: string, text: string, shown: string) => {
    props.child.answer(text)
    add({ kind: "answer", question, shown }, `${question}: ${shown}`)
    setPending(undefined)
    setCard(undefined)
  }

  /** The viewport's height, scroll offset and content height, for the position line; shown only when the transcript
   *  overflows. Read after a render, when the layout is current. */
  const measure = () => {
    if (!scroll || card()) return setTranscriptPos("")
    const view = scroll.viewport?.height ?? 0
    const total = scroll.scrollHeight
    if (view <= 0 || total <= view) return setTranscriptPos("")
    const top = Math.round(scroll.scrollTop)
    setTranscriptPos(`lines ${top + 1}–${Math.min(top + view, total)} of ${total}`)
  }
  // After every render the scrollbox's measurements are current; the signal only changes when the position does.
  renderer.on("frame", measure)
  onCleanup(() => renderer.off("frame", measure))

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      props.child.interrupt()
      setStopping(true)
      return
    }
    // The pager handles its own keys; the transcript is hidden then.
    if (card() || !scroll) return
    const view = scroll.viewport?.height ?? 10
    const page = Math.max(1, view - 1)
    switch (key.name) {
      case "pageup":
        scroll.scrollBy(-page)
        break
      case "pagedown":
        scroll.scrollBy(page)
        break
      case "home":
        scroll.scrollTo(0)
        break
      case "end":
        scroll.scrollTo(scroll.scrollHeight)
        break
      // The arrows scroll only when no question is open, so they still move a choice or the cursor.
      case "up":
        if (pending()) return
        scroll.scrollBy(-1)
        break
      case "down":
        if (pending()) return
        scroll.scrollBy(1)
        break
      default:
        return
    }
    measure()
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      paddingLeft={SCREEN_PAD}
      paddingRight={SCREEN_PAD}
      paddingBottom={1}
      gap={1}
    >
      <box flexShrink={0} paddingTop={1}>
        <text fg={theme.text} wrapMode="none">
          <b>{props.title ?? "Setting up OpenCorp"}</b>
          <span style={{ fg: theme.textMuted }}>{props.command ? ` · ${props.command}` : ""}</span>
        </text>
      </box>
      <Show
        when={card()}
        fallback={
          <>
            <scrollbox ref={(r) => (scroll = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
              <For each={entries()}>
                {(entry, i) => (
                  <Switch>
                    <Match when={entry.kind === "step" && entry}>
                      {(step) => (
                        <box marginTop={i() === 0 ? 0 : 1}>
                          <box flexDirection="row">
                            <text fg={theme.textMuted}>{`${step().counter} · `}</text>
                            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                              {step().title}
                            </text>
                          </box>
                          <text fg={theme.textMuted} wrapMode="word">
                            {step().why}
                          </text>
                        </box>
                      )}
                    </Match>
                    <Match when={entry.kind === "say" && entry}>
                      {(say) => (
                        <box paddingLeft={2}>
                          <text fg={theme.text} wrapMode="word">
                            {say().text}
                          </text>
                        </box>
                      )}
                    </Match>
                    <Match when={entry.kind === "answer" && entry}>
                      {(done) => (
                        <box paddingLeft={2}>
                          {/* One text, so a long question and its answer wrap as one paragraph. */}
                          <text fg={theme.textMuted} wrapMode="word">
                            {`${done().question} → `}
                            <span style={{ fg: theme.secondary }}>{done().shown}</span>
                          </text>
                        </box>
                      )}
                    </Match>
                    <Match when={entry.kind === "result" && entry}>
                      {(result) => (
                        <box paddingLeft={2}>
                          <text fg={result().ok ? theme.success : theme.error} wrapMode="word">
                            {result().title}
                          </text>
                          <For each={result().lines}>
                            {(line) => (
                              <text fg={theme.textMuted} wrapMode="char">
                                {line}
                              </text>
                            )}
                          </For>
                        </box>
                      )}
                    </Match>
                    <Match when={entry.kind === "away" && entry}>
                      {(away) => (
                        <box paddingLeft={2}>
                          <text fg={theme.textMuted} wrapMode="word">
                            {away().why}
                          </text>
                        </box>
                      )}
                    </Match>
                  </Switch>
                )}
              </For>
            </scrollbox>
            <Show when={transcriptPos()}>
              <box flexShrink={0} paddingLeft={2}>
                <text fg={theme.textMuted}>{transcriptPos()}</text>
              </box>
            </Show>
            <box flexShrink={0}>
              <Show
                when={!stopping() && pending()}
                keyed
                fallback={<Spinner>{stopping() ? "Stopping…" : "Working…"}</Spinner>}
              >
                {(question) => (
                  <Switch>
                    <Match when={question.type === "ask" && question}>
                      {(ask) => (
                        <Ask
                          question={oneLine(ask().question)}
                          default={ask().default ?? ""}
                          // The install strips the answer and takes the default; the line shown agrees.
                          onSubmit={(text) => answer(ask().question, text, redact(text.trim() || (ask().default ?? "")))}
                        />
                      )}
                    </Match>
                    <Match when={question.type === "choose" && question}>
                      {(choose) => {
                        const options = choose().options
                        const fallback = choose().default ?? ""
                        const typed = choose().typed === true
                        const at = options.indexOf(fallback)
                        // A typed default that isn't an option starts in the box, so Enter alone still takes it.
                        const draft = typed && at < 0 ? fallback : ""
                        const shown = oneLine(choose().question)
                        // A question too long for its share of the screen is drawn above the options in a bounded,
                        // scrolling box, so it can't push them off; a short one stays where the card puts it.
                        const size = questionSize(shown, dimensions())
                        const long = size.rows > size.cap
                        const pages = [
                          {
                            header: shown,
                            question: long ? "" : shown,
                            options: options.map((o) => ({ label: o, value: o })),
                            multi: false,
                            typed,
                          },
                        ]
                        return (
                          <QuestionView
                            pages={pages}
                            selected={at >= 0 ? at : draft ? options.length : 0}
                            draft={draft}
                            singleLine
                            // Leaves the transcript about half the screen.
                            maxOptions={Math.max(3, Math.floor(dimensions().height / 2) - 4)}
                            onSubmit={([a]) => {
                              const text = a.text.trim() || options[a.picked[0]]
                              answer(choose().question, text, redact(text))
                            }}
                          >
                            <Show when={long}>
                              <box paddingLeft={1}>
                                <BoundedQuestion text={shown} />
                              </box>
                            </Show>
                          </QuestionView>
                        )
                      }}
                    </Match>
                    <Match when={question.type === "secret" && question}>
                      {(secret) => (
                        <Panel>
                          <text fg={theme.text}>{secret().question}</text>
                          <SecretInput
                            placeholder="Paste or type it here; it isn't shown"
                            fg={theme.text}
                            placeholderFg={theme.textMuted}
                            onSubmit={(text) => answer(secret().question, text, "(hidden)")}
                          />
                        </Panel>
                      )}
                    </Match>
                  </Switch>
                )}
              </Show>
            </box>
          </>
        }
      >
        {(c) => {
          const choose = () => (pending()?.type === "choose" ? (pending() as SetupChoose) : undefined)
          const gate = (): Gate | undefined => {
            const q = choose()
            return q ? { question: q.question, options: q.options, default: q.default ?? "" } : undefined
          }
          return (
            <CardPager
              card={c()}
              gate={gate()}
              stopping={stopping()}
              onSubmit={(value) => {
                const q = gate()!
                answer(q.question, value, redact(value))
              }}
            />
          )
        }}
      </Show>
    </box>
  )
}

/**
 * A card shown whole: its rows in a scrolling viewport, a position line, and, once the owner has read to the last
 * row, the approval's choices (default "Don't …", and a single digit never submits). Until then it says to read on,
 * and PageDown/Space/the arrows/Home/End move through it.
 */
function CardPager(props: { card: Card; gate?: Gate; stopping: boolean; onSubmit: (value: string) => void }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [rawTop, setTop] = createSignal(0)
  // How many of the card's rows have been on screen in the final layout (the question's footer drawn): rows shown
  // before the question came, in a taller viewport, don't count.
  const [readThrough, setReadThrough] = createSignal(0)
  const [sel, setSel] = createSignal(0)

  // The width the rows are wrapped to and drawn in: what the screen's and the pager's padding leave.
  const width = () => Math.max(1, dimensions().width - 2 * SCREEN_PAD - 2 * PAGER_PAD)
  const rows = createMemo(() => cardRows(props.card, width()))
  // The footer, wrapped to the same width, so its height is known exactly. With a question it holds whichever is
  // taller of the read-on hint and the choices, so the viewport doesn't change size when the choices appear.
  const readOn = createMemo(() => wrap(READ_ON, width()))
  const choices = createMemo(() => {
    const g = props.gate
    if (!g) return undefined
    return {
      question: wrap(g.question, width()),
      options: g.options.map((option, i) => ({ i, rows: wrap(`${"  "}${option}`, width()) })),
      hint: wrap(CHOOSE, width()),
    }
  })
  const footerRows = createMemo(() => {
    const c = choices()
    if (!c) return 1
    const chosen = c.question.length + c.options.reduce((n, o) => n + o.rows.length, 0) + c.hint.length
    return Math.max(readOn().length, chosen)
  })
  // The header (its padding, title and gap) and the screen's bottom padding take 4 rows; the position line 1.
  const view = createMemo(() => Math.max(3, dimensions().height - 4 - 1 - footerRows()))
  const maxTop = createMemo(() => Math.max(0, rows().length - view()))
  const clamp = (t: number) => Math.max(0, Math.min(maxTop(), t))
  const top = () => clamp(rawTop())

  // The default is the question's (the office sends "Don't …" second), so a plain Enter never approves.
  createEffect(() => {
    const g = props.gate
    if (!g) return
    const at = g.options.indexOf(g.default)
    setSel(at >= 0 ? at : g.options.length - 1)
  })
  // Recomputed on every layout change. Before the question there's no final layout, so nothing counts; when the
  // rows are wrapped anew (a resize), only what is on screen now counts, so a card made longer is read again.
  let counted: Row[] | undefined
  createEffect(() => {
    const r = rows()
    const now = Math.min(top() + view(), r.length)
    if (!props.gate) {
      counted = undefined
      return void setReadThrough(0)
    }
    if (r !== counted) {
      counted = r
      return void setReadThrough(now)
    }
    setReadThrough((s) => Math.max(s, now))
  })
  const seen = () => props.gate !== undefined && readThrough() >= rows().length

  const visible = createMemo(() => rows().slice(top(), top() + view()))
  const positionLine = createMemo(() => {
    const total = rows().length
    const from = Math.min(top() + 1, total)
    return `lines ${from}–${Math.min(top() + view(), total)} of ${total}`
  })

  useKeyboard((key) => {
    if (key.ctrl || key.meta) return // Ctrl-C is the screen's.
    if (props.stopping) return
    const page = Math.max(1, view() - 1)
    const g = props.gate
    const choosing = seen() && g !== undefined
    switch (key.name) {
      case "pageup":
        return void setTop(clamp(top() - page))
      case "pagedown":
        return void setTop(clamp(top() + page))
      case "home":
        return void setTop(0)
      case "end":
        return void setTop(maxTop())
    }
    if (!choosing) {
      switch (key.name) {
        case "up":
        case "k":
          return void setTop(clamp(top() - 1))
        case "down":
        case "j":
        case "space":
        case "return":
        case "enter":
          return void setTop(clamp(top() + page))
      }
      return
    }
    switch (key.name) {
      case "up":
      case "k":
        return void setSel((s) => Math.max(0, s - 1))
      case "down":
      case "j":
        return void setSel((s) => Math.min(g!.options.length - 1, s + 1))
      case "return":
      case "enter":
        return void props.onSubmit(g!.options[sel()]!)
      // A digit never submits: approving is a deliberate choice on a selected option.
    }
  })

  const tone = (t: Row["tone"]) => (t === "warn" ? theme.warning : theme.text)

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={PAGER_PAD} paddingRight={PAGER_PAD}>
      <box height={view()} flexShrink={0} flexDirection="column">
        <For each={visible()}>
          {(row) => (
            <text fg={tone(row.tone)} attributes={row.tone === "title" ? TextAttributes.BOLD : undefined} wrapMode="none">
              {row.text === "" ? " " : row.text}
            </text>
          )}
        </For>
      </box>
      <box flexShrink={0}>
        <text fg={theme.textMuted} wrapMode="none">
          {positionLine()}
        </text>
      </box>
      <box flexShrink={0} height={footerRows()}>
        <Show when={!props.stopping} fallback={<Spinner>Stopping…</Spinner>}>
          <Show when={choices()} fallback={<Spinner>Working…</Spinner>}>
            {(c) => (
              <Show
                when={seen()}
                fallback={
                  <For each={readOn()}>
                    {(row) => (
                      <text fg={theme.accent} wrapMode="none">
                        {row}
                      </text>
                    )}
                  </For>
                }
              >
                <For each={c().question}>
                  {(row) => (
                    <text fg={theme.text} wrapMode="none">
                      {row}
                    </text>
                  )}
                </For>
                <For each={c().options}>
                  {(option) => (
                    <For each={option.rows}>
                      {(row, r) => (
                        <text
                          fg={option.i === sel() ? theme.text : theme.textMuted}
                          attributes={option.i === sel() ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                        >
                          {r() === 0 && option.i === sel() ? `❯ ${row.slice(2)}` : row}
                        </text>
                      )}
                    </For>
                  )}
                </For>
                <For each={c().hint}>
                  {(row) => (
                    <text fg={theme.textMuted} wrapMode="none">
                      {row}
                    </text>
                  )}
                </For>
              </Show>
            )}
          </Show>
        </Show>
      </box>
    </box>
  )
}

/** opentui's own SIGWINCH listener (set in the renderer's constructor when it drives the real stdout). */
function sigwinch(renderer: unknown): (() => void) | undefined {
  const h = (renderer as { sigwinchHandler?: () => void }).sigwinchHandler
  return typeof h === "function" ? h : undefined
}

/** Takes opentui's SIGWINCH listener off, so a window change while the terminal is handed over writes no size query
 *  into ssh's read; returns whether one was taken off. */
export function detachResize(renderer: unknown): boolean {
  const h = sigwinch(renderer)
  if (!h || !process.listeners("SIGWINCH").includes(h)) return false
  process.off("SIGWINCH", h)
  return true
}

/** Puts opentui's SIGWINCH listener back after a hand-over and takes the terminal's new size now. */
export function attachResize(renderer: unknown): void {
  const h = sigwinch(renderer)
  if (!h) return
  process.on("SIGWINCH", h)
  h()
}

/** The columns a question panel's own chrome takes beside the screen's padding: its bar, its padding, and a column
 *  for a scrollbar. */
const QUESTION_INSET = 7

/** How many rows `text` takes in a question panel on a screen of `size`, and the most a question may take there. */
function questionSize(text: string, size: { width: number; height: number }) {
  const width = Math.max(1, size.width - 2 * SCREEN_PAD - QUESTION_INSET)
  return { rows: wordWrapRows(text, width), cap: Math.max(3, Math.floor(size.height / 3)) }
}

/** A question in a box only as tall as it needs, but at most a third of the screen; a longer one scrolls inside it,
 *  so the answer box or the choices below it, and the transcript above, stay on screen. */
function BoundedQuestion(props: { text: string }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const height = () => {
    const { rows, cap } = questionSize(props.text, dimensions())
    return Math.max(1, Math.min(rows, cap))
  }
  return (
    <scrollbox scrollY={true} stickyScroll={true} stickyStart="top" height={height()} flexShrink={0}>
      <text fg={theme.text} wrapMode="word">
        {props.text}
      </text>
    </scrollbox>
  )
}

/** The question card's look: a panel with an accent bar on its left. */
function Panel(props: ParentProps) {
  const { theme } = useTheme()
  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box paddingLeft={2} paddingRight={3} paddingTop={1} paddingBottom={1} gap={1}>
        {props.children}
      </box>
    </box>
  )
}

/**
 * `question` in a panel above a line to type the answer on; Enter hands the text to `onSubmit`; Ctrl+C or Esc
 * clears it. A long question scrolls inside a bounded box, so the answer line is always on screen.
 */
function Ask(props: { question: string; default: string; onSubmit: (text: string) => void }) {
  const { theme } = useTheme()
  let input: InputRenderable | undefined
  const tuiConfig = useTuiConfig()
  useBindings(() => ({
    bindings: clearFirst(tuiConfig.keybinds.get("prompt.clear"), () => {
      if (!input || input.isDestroyed || !input.value) return false
      input.value = ""
      return true
    }),
  }))
  return (
    <Panel>
      <BoundedQuestion text={props.question} />
      <input
        focused
        ref={(r) => (input = r)}
        placeholder={
          props.default ? `Type your answer here (Enter for ${redact(props.default)})` : "Type your answer here"
        }
        placeholderColor={theme.textMuted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        backgroundColor={theme.backgroundPanel}
        focusedBackgroundColor={theme.backgroundPanel}
        cursorColor={theme.primary}
        onSubmit={() => props.onSubmit(input?.value ?? "")}
      />
    </Panel>
  )
}

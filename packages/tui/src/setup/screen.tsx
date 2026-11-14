import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch, type ParentProps } from "solid-js"
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
  | { kind: "command"; title: string; warning: string; lines: string[] }
  | { kind: "result"; title: string; ok: boolean; lines: string[] }
  | { kind: "review"; title: string; files: File[]; risks: string[]; warning: string }
  | { kind: "away"; why: string }

/** `text` with the user and password taken out of any URL in it, as the install's `redact` does. */
function redact(text: string) {
  return text.replace(/(?<=:\/\/)[^/@\s]+@/g, "***@")
}

/** The heading above a review's risks. */
const BEFORE_SAVING = "Before you save it:"

/**
 * The install's steps and answers, its pending question in a panel (choices on the question card), and a spinner
 * while it works; Ctrl-C asks it to stop. A command, its result and files to review show as blocks; when the child
 * hands the terminal over, the screen steps aside, `notice` says why on the plain terminal, and the child is told
 * it has it, until it takes the terminal back. The header reads `title` (default "Setting up OpenCorp") and
 * `command`.
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
  const [stopping, setStopping] = createSignal(false)

  /** Shows `entry` now; `printed` are its lines in the transcript printed once the screen is gone. */
  const add = (entry: Entry, ...printed: string[]) => {
    props.lines.push(...printed)
    setEntries((all) => [...all, entry])
  }

  props.child.onPrompt((prompt) => {
    if (prompt.type === "step") {
      const counter = `Step ${prompt.number} of ${prompt.total}`
      add({ kind: "step", counter, title: prompt.title, why: prompt.why }, `${counter}: ${prompt.title}`, prompt.why)
    } else if (prompt.type === "say") add({ kind: "say", text: prompt.text }, prompt.text)
    else if (prompt.type === "command") {
      const warning = prompt.warning ?? ""
      add({ kind: "command", title: prompt.title, warning, lines: prompt.lines }, prompt.title, ...(warning ? [warning] : []), ...prompt.lines)
    } else if (prompt.type === "result")
      // Its output reached the terminal as it came, so the transcript keeps only how it ended.
      add({ kind: "result", title: prompt.title, ok: prompt.ok, lines: prompt.lines ?? [] }, prompt.title)
    else if (prompt.type === "review") {
      const risks = prompt.risks ?? []
      const warning = prompt.warning ?? ""
      add(
        { kind: "review", title: prompt.title, files: prompt.files, risks, warning },
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
        renderer.suspend()
        renderer.currentRenderBuffer.clear()
      }
      props.notice?.(`\n${prompt.why}\n`)
      props.child.answer("")
    } else if (prompt.type === "take_back") {
      if (renderer.isDestroyed) return
      renderer.currentRenderBuffer.clear()
      renderer.resume()
      renderer.requestRender()
    } else setPending(prompt)
  })

  /** Sends `text` as the answer, shows the question answered with `shown`, and waits for the next prompt. */
  const answer = (question: string, text: string, shown: string) => {
    props.child.answer(text)
    add({ kind: "answer", question, shown }, `${question}: ${shown}`)
    setPending(undefined)
  }

  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "c") return
    props.child.interrupt()
    setStopping(true)
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
    >
      <box flexShrink={0} paddingTop={1}>
        <text fg={theme.text} wrapMode="none">
          <b>{props.title ?? "Setting up OpenCorp"}</b>
          <span style={{ fg: theme.textMuted }}>{props.command ? ` · ${props.command}` : ""}</span>
        </text>
      </box>
      <scrollbox stickyScroll={true} stickyStart="bottom" flexGrow={1}>
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
              <Match when={entry.kind === "command" && entry}>
                {(command) => (
                  <box marginTop={1} paddingLeft={2} gap={0}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
                      {command().title}
                    </text>
                    <Show when={command().warning}>
                      <text fg={theme.warning} wrapMode="word">
                        {command().warning}
                      </text>
                    </Show>
                    <Code lines={command().lines} />
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
              <Match when={entry.kind === "review" && entry}>
                {(review) => (
                  <box marginTop={1} paddingLeft={2}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="word">
                      {review().title}
                    </text>
                    <For each={review().files}>
                      {(file) => (
                        <box marginTop={1}>
                          <text fg={theme.textMuted} wrapMode="char">
                            {file.name}
                          </text>
                          <Code lines={file.lines} />
                        </box>
                      )}
                    </For>
                    <Show when={review().risks.length > 0}>
                      <box marginTop={1}>
                        <text fg={theme.text}>{BEFORE_SAVING}</text>
                        <For each={review().risks}>
                          {(risk) => (
                            <text fg={theme.text} wrapMode="word">
                              {`  - ${risk}`}
                            </text>
                          )}
                        </For>
                      </box>
                    </Show>
                    <Show when={review().warning}>
                      <text fg={theme.warning} wrapMode="word">
                        {review().warning}
                      </text>
                    </Show>
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
                    question={ask().question}
                    default={ask().default ?? ""}
                    // The install strips the answer and takes the default for an empty one; the line shown agrees.
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
                  const pages = [
                    {
                      header: choose().question,
                      question: choose().question,
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
                    />
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
    </box>
  )
}

/** Lines to check closely, such as a command to approve, on the panel's colour; a long line wraps rather than being
 *  cut, so all of what runs shows. */
function Code(props: { lines: string[] }) {
  const { theme } = useTheme()
  return (
    <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
      <For each={props.lines}>
        {(line) => (
          <text fg={theme.text} wrapMode="char">
            {line}
          </text>
        )}
      </For>
    </box>
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
 * clears it.
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
      <text fg={theme.text} wrapMode="word">
        {props.question}
      </text>
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

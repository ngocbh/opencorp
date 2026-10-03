import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Match, Show, Switch, type ParentProps } from "solid-js"
import type { SetupAsk, SetupChoose, SetupSecret } from "@agent-corp/protocol"
import { Spinner } from "../component/spinner"
import { useTheme } from "../context/theme"
import { QuestionView } from "../routes/chat/question-view"
import { SplitBorder } from "../ui/border"
import type { SetupChild } from "./child"
import { SecretInput } from "./secret"

type Entry =
  | { kind: "step"; counter: string; title: string; why: string }
  | { kind: "say"; text: string }
  | { kind: "answer"; question: string; shown: string }

/** `text` with the user and password taken out of any URL in it, as the install's `redact` does. */
function redact(text: string) {
  return text.replace(/(?<=:\/\/)[^/@\s]+@/g, "***@")
}

/**
 * The install's steps and answers, its pending question in a panel (choices on the question card), and a spinner
 * while it works; Ctrl-C asks it to stop.
 */
export function SetupScreen(props: { child: SetupChild; lines: string[]; command?: string }) {
  const { theme } = useTheme()
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
    else setPending(prompt)
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
          <b>Setting up AgentCorp</b>
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
                  return (
                    <QuestionView
                      pages={[
                        {
                          header: choose().question,
                          question: choose().question,
                          options: options.map((o) => ({ label: o, value: o })),
                          multi: false,
                          typed,
                        },
                      ]}
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

/** `question` in a panel above a line to type the answer on; Enter hands the text to `onSubmit`. */
function Ask(props: { question: string; default: string; onSubmit: (text: string) => void }) {
  const { theme } = useTheme()
  let input: InputRenderable | undefined
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

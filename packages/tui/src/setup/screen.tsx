import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import type { SetupAsk, SetupChoose, SetupSecret } from "@agent-corp/protocol"
import { Spinner } from "../component/spinner"
import { useTheme } from "../context/theme"
import type { SetupChild } from "./child"
import { SecretInput } from "./secret"

type Line = { kind: "step" | "why" | "say"; text: string }

/** `text` with the user and password taken out of any URL in it, as the install's `redact` does. */
function redact(text: string) {
  return text.replace(/(?<=:\/\/)[^/@\s]+@/g, "***@")
}

/** The install's transcript, its pending question, and a spinner while it works; Ctrl-C asks it to stop. */
export function SetupScreen(props: { child: SetupChild; lines: string[] }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [lines, setLines] = createSignal<Line[]>([])
  const [pending, setPending] = createSignal<SetupAsk | SetupChoose | SetupSecret>()
  const [stopping, setStopping] = createSignal(false)

  /** Adds a line to the transcript shown now and to the one printed once the screen is gone. */
  const add = (kind: Line["kind"], text: string) => {
    props.lines.push(text)
    setLines((all) => [...all, { kind, text }])
  }

  props.child.onPrompt((prompt) => {
    if (prompt.type === "step") {
      add("step", `Step ${prompt.number} of ${prompt.total}: ${prompt.title}`)
      add("why", prompt.why)
    } else if (prompt.type === "say") add("say", prompt.text)
    else setPending(prompt)
  })

  /** Sends `text` as the answer, shows the question answered with `shown`, and waits for the next prompt. */
  const answer = (question: string, text: string, shown: string) => {
    props.child.answer(text)
    add("say", `${question}: ${shown}`)
    setPending(undefined)
  }
  // The question line and the gap above it take two rows; a choice gets the rest under the transcript.
  const rows = () => Math.max(3, dimensions().height - lines().length - 2)

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
      paddingLeft={1}
      paddingRight={1}
    >
      <scrollbox stickyScroll={true} stickyStart="bottom" flexGrow={1}>
        <For each={lines()}>
          {(line) => (
            <text
              fg={line.kind === "step" ? theme.accent : line.kind === "why" ? theme.textMuted : theme.text}
              attributes={line.kind === "step" ? TextAttributes.BOLD : undefined}
            >
              {line.text}
            </text>
          )}
        </For>
      </scrollbox>
      <box flexShrink={0} paddingTop={1}>
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
                {(choose) => (
                  <Choice
                    question={choose().question}
                    options={choose().options}
                    default={choose().default}
                    rows={rows()}
                    onSubmit={(option) => answer(choose().question, option, option)}
                  />
                )}
              </Match>
              <Match when={question.type === "secret" && question}>
                {(secret) => (
                  <SecretInput
                    question={secret().question}
                    onSubmit={(text) => answer(secret().question, text, "(hidden)")}
                  />
                )}
              </Match>
            </Switch>
          )}
        </Show>
      </box>
    </box>
  )
}

/** `question: ` and a line to type the answer on, starting at `default`; Enter hands the text to `onSubmit`. */
function Ask(props: { question: string; default: string; onSubmit: (text: string) => void }) {
  const { theme } = useTheme()
  let input: InputRenderable | undefined
  return (
    <box flexDirection="row">
      <text fg={theme.text}>{`${props.question}: `}</text>
      <input
        flexGrow={1}
        focused
        ref={(r) => (input = r)}
        value={props.default}
        cursorColor={theme.primary}
        focusedBackgroundColor={theme.backgroundPanel}
        onSubmit={() => props.onSubmit(input?.value ?? "")}
      />
    </box>
  )
}

/** `options` under `question`, at most `rows` at a time, picked with Up, Down and Enter. */
function Choice(props: {
  question: string
  options: string[]
  default?: string
  rows: number
  onSubmit: (option: string) => void
}) {
  const { theme } = useTheme()
  const [cursor, setCursor] = createSignal(Math.max(0, props.options.indexOf(props.default ?? "")))
  // The first option shown: moved only as far as keeps the cursor in view, so the list doesn't jump.
  let top = 0
  const shown = createMemo(() => {
    top = Math.min(Math.max(top, cursor() - props.rows + 1), cursor())
    return props.options.slice(top, top + props.rows).map((option, i) => ({ option, index: top + i }))
  })

  useKeyboard((key) => {
    if (key.name === "up") setCursor((i) => Math.max(0, i - 1))
    else if (key.name === "down") setCursor((i) => Math.min(props.options.length - 1, i + 1))
    else if (key.name === "return" || key.name === "enter") props.onSubmit(props.options[cursor()])
  })

  return (
    <box>
      <text fg={theme.text}>{props.question}</text>
      <For each={shown()}>
        {(item) => (
          <text fg={item.index === cursor() ? theme.accent : theme.text}>
            {(item.index === cursor() ? "> " : "  ") + item.option}
          </text>
        )}
      </For>
    </box>
  )
}

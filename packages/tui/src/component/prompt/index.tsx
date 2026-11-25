import {
  BoxRenderable,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
  type Renderable,
} from "@opentui/core"
import type { CommandContext } from "@opentui/keymap"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show } from "solid-js"
import { registerOpenCorpSpinner } from "../register-spinner"
import path from "path"
import { fileURLToPath } from "url"
import { useLocal } from "../../context/local"
import { tint, useTheme } from "../../context/theme"
import { EmptyBorder, SplitBorder } from "../../ui/border"
import { useTuiTerminalEnvironment } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import { useRoute } from "../../context/route"
import { useOffice } from "../../context/office"
import { usePermission } from "../../context/permission"
import { HARNESS_NAMES, sessionModel } from "@opencorp/client"
import { MessageText } from "@opencorp/protocol"
import { usePromptRef } from "../../context/prompt"
import { normalizePromptContent, openEditor } from "../../editor"
import { useExit } from "../../context/exit"
import { useEpilogue } from "../../context/epilogue"
import { sessionEpilogue } from "../../util/presentation"
import { personLabel } from "../../util/transcript"
import { promptOffsetWidth } from "../../prompt/display"
import { createStore, produce, unwrap } from "solid-js/store"
import { usePromptHistory, type PromptInfo } from "../../prompt/history"
import { computePromptTraits } from "../../prompt/traits"
import { expandPastedTextPlaceholders, expandTrackedPastedText } from "../../prompt/part"
import { usePromptStash } from "../../prompt/stash"
import { DialogStash } from "../dialog-stash"
import { costCapArgument, dollars, useCostCap } from "../cost-cap"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { PromptWhoRow, type PromptWho } from "./metadata"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { errorMessage } from "../../util/error"
import { interruptible, working } from "../../util/status"
import { createColors, createFrames } from "../../ui/spinner"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { createFadeIn } from "../../util/signal"
import { OPENCORP_BASE_MODE, useBindings, useCommandShortcut, useLeaderActive, useOpenCorpKeymap } from "../../keymap"
import { useTuiConfig } from "../../config"
import { readLocalAttachment } from "./local-attachment"
import { display } from "../../util/printable"
import { InstrumentLine, InstrumentWarning, waitingInstrument } from "../../routes/session/instrument-line"
import { sessionOwner } from "../../routes/session/speakers"
import { useInteractivity } from "../../context/interactivity"

registerOpenCorpSpinner()

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  /** While true the prompt stays visible but gives up the keys, even to a click, as a card above it has them. */
  inactive?: boolean
  onSubmit?: () => void
  /** Called just before the text goes to the office; returns an undo for a send that fails. */
  onSend?: () => (() => void) | void
  /** Called when Esc interrupts the session, before the office is asked to. */
  onInterrupt?: () => void
  /** Enter on an empty prompt, as upstream's: steers the first queued message; true when it did. */
  onEmptySubmit?: () => Promise<boolean>
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: string[]
}

function pastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {}
  }
  if (platform === "win32") return raw
  return raw.replace(/\\(.)/g, "$1")
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const DRAFT_RETENTION_MIN_CHARS = 20

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()
  // A disabled interactivity provider above it, as while an open instrument has the keys, mutes it as `inactive` does.
  const interactive = useInteractivity()
  const inactive = () => props.inactive || !interactive()

  const leader = useLeaderActive()
  const local = useLocal()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const office = useOffice()
  const promptRef = usePromptRef()
  const route = useRoute()
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const toast = useToast()
  const costCap = useCostCap()
  const session = createMemo(() => office.state.sessions.find((s) => s.id === props.sessionID))
  const canInterrupt = createMemo(() => interruptible(session()?.status))
  const busy = createMemo(() => working(session()?.status))
  // The instrument waiting on the owner, which the line names in place of the shortcuts.
  const waiting = createMemo(() =>
    props.sessionID ? waitingInstrument(office.state.instruments[props.sessionID]) : undefined,
  )
  /** An ended Codex session, which a message continues in a new session on the same thread; not one an employee's
   *  chat drove, which only its employee starts again. */
  const continues = createMemo(() => {
    const s = session()
    return s?.harness === "codex" && !s.instrument_of && ["ended", "failed", "debriefing"].includes(s.status)
  })
  const history = usePromptHistory(() => unwrap(store.prompt))
  const stash = usePromptStash()
  const keymap = useOpenCorpKeymap()
  const peopleShortcut = useCommandShortcut("person.list")
  const modeShortcut = useCommandShortcut("session.mode.cycle")
  const permission = usePermission()
  // Null on home, for a Codex or Claude Code session and once the run has ended: no label or hint where Shift+Tab
  // can't switch.
  const mode = createMemo(() => (props.sessionID ? permission.mode(props.sessionID) : null))
  const paletteShortcut = useCommandShortcut("command.palette.show")
  const renderer = useRenderer()
  const exit = useExit()
  const setEpilogue = useEpilogue()
  const dimensions = useTerminalDimensions()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const animationsEnabled = createMemo(() => kv.get("animations_enabled", true))
  const list = createMemo(() => props.placeholders ?? [])
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const hasRightContent = createMemo(() => Boolean(props.right))

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
    if (tuiConfig.cursor) input.cursorStyle = tuiConfig.cursor
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    extmarkToPartIndex: Map<number, number>
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    extmarkToPartIndex: new Map(),
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        hidden: true,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        hidden: true,
        run: async () => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Queue prompt",
        name: "prompt.queue",
        category: "Prompt",
        hidden: true,
        run: async () => {
          if (!input.focused) return
          const handled = await submit("queue")
          if (!handled) return
          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        hidden: true,
        run: async (ctx: CommandContext<Renderable, KeyEvent>) => {
          ctx.event.preventDefault()
          ctx.event.stopPropagation()
          const content = await clipboard.read?.()
          if (content?.mime.startsWith("image/")) return attachmentsUnsupported()
          if (content?.mime === "text/plain") {
            await pasteInputText(content.data)
          }
        },
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        hidden: true,
        enabled: canInterrupt(),
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          const sessionID = props.sessionID
          if (!sessionID) return
          props.onInterrupt?.()
          office.client.sessions.interrupt(sessionID).catch(showError("Interrupting failed"))
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slashName: "editor",
        run: async () => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await openEditor({
            renderer,
            value,
            cwd: office.cwd,
          })
          if (!content) return
          const normalized = normalizePromptContent(content)

          input.setText(normalized)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) virtualText = part.source.text.value

              if (!virtualText) return part

              const newStart = normalized.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: normalized,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(normalized)
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: promptCommands(),
  }))

  useBindings(() => ({
    mode: OPENCORP_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("prompt.palette", [
      "prompt.submit",
      "prompt.queue",
      "prompt.editor",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "session.interrupt",
    ]),
  }))

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      history.reset()
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      history.reset()
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
  }

  // Captured once: the session route is keyed by sessionID, so this Prompt belongs to exactly one session (home's is
  // undefined). Reading props.sessionID lazily could see the next route during onCleanup and stash under the wrong one.
  const stashSessionID = props.sessionID

  onMount(() => {
    const saved = promptRef.takeDraft(stashSessionID)
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  // The text of the send in flight, until the office has it or refused it.
  let sending: string | undefined
  let disposed = false
  /** Whether this prompt was torn down: by a quit, a switch to another view, or a card taking its place. */
  const gone = () => disposed || !input || input.isDestroyed

  onCleanup(() => {
    disposed = true
    // Text that is going out isn't a draft: the next prompt would offer it again after it was sent.
    if (store.prompt.input && store.prompt.input !== sending) {
      promptRef.saveDraft(stashSessionID, { prompt: unwrap(store.prompt), cursor: input.cursorOffset })
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || inactive() || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }

    // The background prompt can remount while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  const stashCommands = createMemo(() =>
    [
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.input,
        run: () => {
          if (!store.prompt.input) return
          stash.push({
            input: store.prompt.input,
            parts: store.prompt.parts,
          })
          input.extmarks.clear()
          input.clear()
          setStore("prompt", { input: "", parts: [] })
          setStore("extmarkToPartIndex", new Map())
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.input)
            setStore("prompt", { input: entry.input, parts: entry.parts })
            restoreExtmarksFromParts(entry.parts)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.input)
                setStore("prompt", { input: entry.input, parts: entry.parts })
                restoreExtmarksFromParts(entry.parts)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: stashCommands(),
  }))

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled,
      bindings: tuiConfig.keybinds.get("prompt.paste"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled && store.prompt.input !== "",
      bindings: tuiConfig.keybinds.get("prompt.clear"),
    }
  })

  // Esc with a draft clears it ahead of the interrupt; base mode only, so an open menu keeps Esc. Text being sent is
  // no draft, so Esc interrupts then. The priority holds that order however the layers are registered.
  useBindings(() => ({
    target: inputTarget,
    mode: OPENCORP_BASE_MODE,
    priority: 1,
    enabled: inputTarget() !== undefined && !props.disabled,
    bindings: [
      {
        key: "escape",
        desc: "Clear the prompt",
        group: "Prompt",
        cmd: () => {
          if (submitting || !store.prompt.input) return false
          clearPrompt()
          return true
        },
      },
    ],
  }))

  // ↑ and ↓ move the cursor, then step through the history; past its ends they fall through (false) to the session's
  // ↑ (the parent) and ↓ (the picker). Above those, as the upstream TUI's.
  useBindings(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.previous",
          title: "Previous prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) {
                input.cursorOffset = 0
                return
              }
              input.moveCursorUp()
              return
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            showHistory(item)
            input.cursorOffset = 0
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.previous"),
    }
  })

  useBindings(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.next",
          title: "Next prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              ) {
                input.cursorOffset = input.plainText.length
                return
              }
              input.moveCursorDown()
              return
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            showHistory(item)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.next"),
    }
  })

  let submitting = false
  /** Sends the prompt: to steer the running reply (`steer`, Enter), else as the next turn, or with `queue`
   *  (`<leader>return`) for the next turn only, as upstream's queued prompt. */
  async function submit(delivery: "steer" | "queue" = "steer") {
    // Prevent overlapping invocations (e.g. a double-pressed Enter, or the
    // input's native onSubmit racing another dispatch). Without this guard,
    // a second call slips past the empty-input check before the first call
    // clears `store.prompt.input`, then awaits its own `session.create` and
    // ultimately reads the now-empty store — sending a phantom empty prompt
    // to a freshly created session.
    if (submitting) return false
    submitting = true
    try {
      return await submitInner(delivery)
    } finally {
      submitting = false
    }
  }

  function showError(title: string) {
    return (error: unknown) => toast.show({ title, message: errorMessage(error), variant: "error" })
  }

  function attachmentsUnsupported() {
    toast.show({ message: "Image and PDF attachments are not supported yet", variant: "warning" })
  }

  /** Shows a text from the history, or the draft it was left from, with its parts. */
  function showHistory(prompt: PromptInfo) {
    input.setText(prompt.input)
    setStore("prompt", prompt)
    restoreExtmarksFromParts(prompt.parts)
  }

  /** The prompt's text with pasted-text placeholders expanded; `@file` mentions stay as text. */
  function promptText() {
    return expandTrackedPastedText(
      store.prompt.input,
      input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
        const partIndex = store.extmarkToPartIndex.get(extmark.id)
        const part = partIndex === undefined ? undefined : store.prompt.parts[partIndex]
        if (part?.type !== "text") return []
        return [{ start: extmark.start, end: extmark.end, text: part.text }]
      }),
    )
  }

  async function submitInner(delivery: "steer" | "queue") {
    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (auto()?.visible) return false
    if (!store.prompt.input.trim() && delivery === "steer" && props.sessionID) {
      return (await props.onEmptySubmit?.()) === true
    }
    if (!store.prompt.input) return false
    const trimmed = store.prompt.input.trim()
    const exitWord = trimmed === "exit" || trimmed === "quit" || trimmed === ":q"
    // What isn't a message to the employee (a word that quits, `/cost-cap`, the chat's `/exit`), and a session that
    // keeps no queue (Codex, Claude Code, a local one).
    const command = exitWord || trimmed === "/exit" || costCapArgument(store.prompt.input) !== undefined
    const yian = !session() || session()!.harness === "yian"
    if (delivery === "queue" && (command || !yian || office.local)) {
      toast.show({ message: "This prompt cannot be queued", variant: "warning" })
      return false
    }
    if (exitWord) {
      void exit()
      return true
    }
    // A command, not a message, even with an amount after it: it must never reach the model.
    const cap = costCapArgument(store.prompt.input)
    if (cap !== undefined) {
      if (!props.sessionID) {
        toast.show({ message: "Open a session to raise its cost cap", variant: "warning" })
        return false
      }
      const usd = dollars(cap)
      if (usd === undefined) costCap.ask(props.sessionID, cap)
      else costCap.raise(props.sessionID, usd)
      clearSent(trimmed)
      return true
    }
    const person = local.person.current()
    if (!props.sessionID && !person) return false
    const text = promptText()
    // The office refuses a message that doesn't show; checked here so it starts no session either.
    if (!MessageText.safeParse(text).success) return false

    let sessionID = props.sessionID
    let undo: (() => void) | void = undefined
    let continuing = false
    // Once Enter is pressed the message goes out even if the prompt is torn down meanwhile; after
    // each wait below, a gone prompt (or a quit app) is left alone and only the history keeps the text.
    sending = store.prompt.input
    try {
      if (!sessionID) {
        // A Codex chat runs on Codex's own model, so it takes no model pick; yian is the office's default.
        const codex = local.harness.current() === "codex"
        const pick = !codex && kv.get("start_on_last_pick", false) ? local.model.last() : undefined
        const created = await office.client.sessions.create({
          person: person!.handle,
          cwd: office.cwd,
          ...(codex ? { harness: "codex" as const } : pick),
        })
        sessionID = created.id
        if (!gone()) {
          // A quit before the session view opens still names the chat that now exists.
          const title = `${personLabel(office.state.people, person!.handle)} · ${office.cwd}`
          setEpilogue(sessionEpilogue({ title, sessionID }))
          await office.syncSession(sessionID)
        }
      } else if (continues()) {
        // An ended Codex session takes no message; its thread goes on in a new session, which gets it instead.
        continuing = true
        const next = await office.client.sessions.continue(sessionID)
        continuing = false
        sessionID = next.id
        if (!gone()) await office.syncSession(sessionID)
      }
      if (!gone()) undo = props.onSend?.()
      if (delivery === "queue") await office.client.sessions.queue(sessionID, { text })
      else await office.client.sessions.prompt(sessionID, { text })
      sending = undefined
      // A capped session holds the message until someone raises the cap.
      if (!renderer.isDestroyed && office.state.sessions.find((s) => s.id === sessionID)?.capped)
        toast.show({ message: "This message waits until the cost cap is raised (/cost-cap)", variant: "warning" })
    } catch (error) {
      // The text stays unsent, so a draft saved from here on keeps it.
      sending = undefined
      undo?.()
      const title = continuing
        ? "Couldn't continue this session"
        : sessionID
          ? delivery === "queue"
            ? "Failed to queue prompt"
            : "Failed to send prompt"
          : "Creating a session failed"
      if (!renderer.isDestroyed) showError(title)(error)
      if (gone()) {
        history.append(text)
        return true
      }
      // A new session opens even if its prompt failed; the unsent text follows it there, stashed under its id and
      // cleared here so this prompt's cleanup doesn't stash it under its own.
      if (sessionID && sessionID !== props.sessionID) {
        // Copy before clearing: unwrap returns the live store target, which the reset writes into.
        promptRef.saveDraft(sessionID, { prompt: { ...unwrap(store.prompt) }, cursor: input.cursorOffset })
        ref.reset()
        route.navigate({ type: "session", sessionID })
      }
      return true
    }

    if (gone()) {
      history.append(text)
      return true
    }
    clearSent(text)
    props.onSubmit?.()
    if (sessionID !== props.sessionID) route.navigate({ type: "session", sessionID })
    return true
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteInputText(text: string) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    const filepath = pastedFilepath(pastedContent, terminalEnvironment.platform)
    const isUrl = /^(https?):\/\//.test(filepath)
    if (!isUrl) {
      const attachment = await readLocalAttachment(filepath)
      const filename = path.basename(filepath)
      if (attachment?.type === "text") {
        pasteText(attachment.content, `[SVG: ${filename ?? "image"}]`)
        return
      }
      if (attachment?.type === "binary") return attachmentsUnsupported()
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if ((lineCount >= 3 || pastedContent.length > 150) && kv.get("paste_summary_enabled", true)) {
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)
  }

  /** Empties the prompt once `text`, its content, has gone out, keeping `text` in the history. */
  function clearSent(text: string) {
    history.append(text)
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    input.clear()
  }

  function clearPrompt() {
    if (store.prompt.input.trim().length >= DRAFT_RETENTION_MIN_CHARS) history.append(promptText())
    else history.reset()
    input.clear()
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
  }

  const highlight = createMemo(() => {
    if (leader()) return theme.border
    const person = local.person.current()
    if (!person) return theme.border
    return local.person.color(person.handle)
  })

  const agentMetaAlpha = createFadeIn(() => !!local.person.current(), animationsEnabled)
  const titleMetaAlpha = createFadeIn(() => !!local.person.current(), animationsEnabled)
  const borderHighlight = createMemo(() => tint(theme.border, highlight(), agentMetaAlpha()))

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (!list().length) return undefined
    return `Ask anything… "${list()[store.placeholder % list().length]}"`
  })

  const spinnerDef = createMemo(() => {
    const person = local.person.current()
    const color = person ? local.person.color(person.handle) : theme.border
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })
  // The open session's model, or Codex for a new chat that will run on it.
  const footerModel = createMemo(() => {
    const s = session()
    // A Codex or Claude Code session runs on its harness's own model, never the office connection's.
    const harness = HARNESS_NAMES[s?.harness ?? ""]
    if (s && harness !== undefined) return display(s.harness_model ?? harness)
    if (s) return sessionModel(s, office.connections()).model
    return local.harness.current() === "codex" ? "Codex" : undefined
  })
  // Who answers what is written here: the person the chat is with; or, in a Codex or Claude Code session an employee's
  // chat drives, the session itself, on its harness's model, which the owner writes to as themselves.
  const who = createMemo<PromptWho | undefined>(() => {
    const s = session()
    if (s?.instrument_of) {
      const harness = HARNESS_NAMES[s.harness] ?? s.harness
      const listed = office.state.instruments[s.instrument_of]?.find((i) => i.id === s.id)
      const owner = office.person ?? sessionOwner(s, office.state.people)
      return {
        name: listed ? display(listed.name) : harness,
        harness: listed ? harness : undefined,
        model: s.harness_model ? display(s.harness_model) : undefined,
        as: owner ? `as @${owner}` : undefined,
      }
    }
    const person = local.person.current()
    if (!person) return undefined
    return { name: `@${person.handle}`, mode: mode() ?? undefined, title: person.title, model: footerModel() }
  })
  const maxHeight = createMemo(() => tuiConfig.prompt?.max_height ?? Math.max(6, Math.floor(dimensions().height / 3)))

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false} width="100%">
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
            width="100%"
          >
            <textarea
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={leader() ? theme.textMuted : theme.text}
              focusedTextColor={leader() ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={maxHeight()}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => setCursorVersion((value) => value + 1)}
              onKeyDown={(e: KeyEvent) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
                // OpenTUI's cursor can't get past text that takes no columns at the start of the box, so what is
                // typed after a draft that shows nothing (a zero-width space) would split around it: it goes after.
                const typed = e.name === "space" ? " " : e.sequence
                const plain = !e.ctrl && !e.meta && !e.super && !e.hyper && !/[\x00-\x1f\x7f-\x9f]/.test(typed)
                if (plain && typed && input.plainText !== "" && promptOffsetWidth(input.plainText) === 0) {
                  e.preventDefault()
                  input.setText(input.plainText + typed)
                  input.gotoBufferEnd()
                }
              }}
              onSubmit={() => {
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!pastedContent) {
                  keymap.dispatchCommand("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                await pasteInputText(normalizedText)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                Object.assign(r, {
                  getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.parts),
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
              }}
              onMouseDown={(r: MouseEvent) => !inactive() && r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={props.disabled ? theme.backgroundElement : theme.text}
              cursorStyle={tuiConfig.cursor}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <PromptWhoRow
                who={who()}
                highlight={highlight()}
                muted={leader()}
                nameAlpha={agentMetaAlpha()}
                metaAlpha={titleMetaAlpha()}
              />
              <Show when={hasRightContent()}>
                <box flexDirection="row" gap={1} alignItems="center">
                  {props.right}
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between">
          <Show
            when={canInterrupt()}
            fallback={
              props.hint ?? (
                <Show when={props.sessionID} fallback={<text />}>
                  <box marginLeft={1}>
                    <text fg={theme.textMuted}>{display(session()?.cwd ?? office.cwd)}</text>
                  </box>
                </Show>
              )
            }
          >
            <box flexDirection="row" gap={1}>
              {/* A waiting session can be interrupted but isn't working, so it has no spinner. */}
              <Show when={busy()}>
                <box marginLeft={1}>
                  <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                    <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                  </Show>
                </box>
              </Show>
              <text fg={theme.text} marginLeft={busy() ? 0 : 1}>
                esc <span style={{ fg: theme.textMuted }}>interrupt</span>
              </text>
            </box>
          </Show>
          <Show when={props.sessionID}>{(id) => <InstrumentLine sessionID={id()} />}</Show>
          <Show
            when={waiting()}
            fallback={
              <box gap={2} flexDirection="row">
                <Show when={mode() && modeShortcut()}>
                  <text fg={theme.text}>
                    {modeShortcut()} <span style={{ fg: theme.textMuted }}>mode</span>
                  </text>
                </Show>
                <Show when={peopleShortcut()}>
                  <text fg={theme.text}>
                    {peopleShortcut()} <span style={{ fg: theme.textMuted }}>people</span>
                  </text>
                </Show>
                <text fg={theme.text}>
                  {paletteShortcut()} <span style={{ fg: theme.textMuted }}>commands</span>
                </text>
              </box>
            }
          >
            {(instrument) => <InstrumentWarning instrument={instrument()} />}
          </Show>
        </box>
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        inactive={inactive()}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}

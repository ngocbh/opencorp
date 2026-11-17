import { EmbeddedTerminalRenderable, type RGBA } from "@opentui/core"
import { extend, useRenderer } from "@opentui/solid"
import type { Instrument, InstrumentOutput } from "@opencorp/protocol"
import { asInstrument, OfficeError } from "@opencorp/client"
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { useTuiConfig } from "../../config"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { leaderKey, useOpenCorpKeymap } from "../../keymap"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { keyBatch, routeShellKeys } from "./keys"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    embeddedTerminal: typeof EmbeddedTerminalRenderable
  }
}

extend({ embeddedTerminal: EmbeddedTerminalRenderable })

type TerminalSize = { cols: number; rows: number }
type StreamItem =
  | { type: "output"; data: Uint8Array }
  | { type: "resize"; size: TerminalSize }
  | { type: "screen"; data: Uint8Array }

/** The size a shell with none listed is drawn at. */
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 }
/** The statuses in which a shell takes keys and a size; the office refuses them before it starts and after it ends. */
export const LIVE: readonly Instrument["status"][] = ["idle", "running", "waiting"]
/** Starts a terminal over (RIS), before it draws a screen read again. */
const RESET = Buffer.from("\x1bc")

/** The most events a view holds back while its screen loads; past it, it drops them and reads the screen again. */
const HELD_LIMIT = 1000
/** How long a view waits before it reads a screen the office failed to serve again: doubling, up to the most. */
const RETRY_MS = 250
const RETRY_MAX_MS = 5000

/** What comes while a screen loads, kept in order: an `instrument.output` event, or the instrument's new size. */
type Held = { type: "output"; event: InstrumentOutput } | { type: "resize"; size: TerminalSize }

/**
 * Follows instrument `instrumentID`'s raw output as the office serves it: `screen` gets the bytes it still holds,
 * with the offset they start at, on open and again after a gap; then `output` gets each `instrument.output` event's
 * bytes past what was had, so each byte arrives once however events were coalesced. With `resize`, each new size
 * comes in order with the output, so the bytes after it are drawn at it. `failed` says why a screen couldn't be read;
 * it is read again, one read at a time, waiting longer after each failure.
 */
export function followOutput(opts: {
  sessionID: string
  instrumentID: string
  screen: (data: Uint8Array, offset: number) => void
  output: (data: Uint8Array) => void
  resize?: (size: TerminalSize) => void
  failed: (message: string | undefined) => void
}) {
  const office = useOffice()
  // The offset of the first byte this view doesn't have.
  let have = 0
  // While a screen read is wanted, events wait in `held`; a read is in flight, or waits out a failure.
  let loading = true
  let reading = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  // Whether `held` overflowed while a read was in flight, which may not hold what was dropped.
  let dropped = false
  let disposed = false
  const held: Held[] = []

  const apply = (item: Held) => {
    if (item.type === "resize") return opts.resize?.(item.size)
    const event = item.event
    // An event past what this view has is a gap: the office dropped output it couldn't send in time.
    if (event.offset > have) return load()
    const data = Buffer.from(event.data, "base64")
    const start = have - event.offset
    if (start >= data.length) return
    have = event.offset + data.length
    opts.output(data.subarray(start))
  }

  const take = (item: Held) => {
    if (!loading) return apply(item)
    if (held.length >= HELD_LIMIT) {
      // The screen read holds the output dropped here; only the newest size is kept.
      const size = held.findLast((h) => h.type === "resize")
      held.length = 0
      if (size) held.push(size)
      dropped = true
    }
    held.push(item)
  }

  function load() {
    loading = true
    if (reading || retry) return
    reading = true
    dropped = false
    office.client.sessions.instrumentScreen(opts.sessionID, opts.instrumentID).then(
      (screen) => {
        reading = false
        if (disposed) return
        failures = 0
        // Output dropped after the read went out may be missing from it.
        if (dropped) return load()
        have = screen.end
        opts.screen(Buffer.from(screen.data, "base64"), screen.offset)
        opts.failed(undefined)
        loading = false
        while (!disposed && !loading && held.length > 0) apply(held.shift()!)
      },
      (error) => {
        reading = false
        if (disposed) return
        opts.failed(errorMessage(error))
        retry = setTimeout(
          () => {
            retry = undefined
            load()
          },
          Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** failures++),
        )
      },
    )
  }

  const offOutput = office.on("instrument.output", (e) => {
    const event = e.data as Partial<InstrumentOutput>
    if (e.session_id !== opts.sessionID || event.instrument_id !== opts.instrumentID) return
    if (typeof event.offset !== "number" || typeof event.data !== "string") return
    take({ type: "output", event: event as InstrumentOutput })
  })
  const offSize = office.on("instrument.updated", (e) => {
    const next = asInstrument(e.data)
    if (opts.resize && next?.id === opts.instrumentID && next.size) take({ type: "resize", size: next.size })
  })
  onMount(load)
  onCleanup(() => {
    disposed = true
    clearTimeout(retry)
    offOutput()
    offSize()
  })
}

/**
 * A PTY shell's screen, drawn by OpenTUI's embedded terminal from the office's screen and the output past it, at the
 * instrument's size. The session's approver's view sends its own size, on open and whenever it changes, and the PTY
 * takes it; any other view only follows the instrument's.
 *
 * While `focused`, the terminal has the keys: every key but the leader goes to the live shell, encoded as a terminal
 * sends it, gathered a frame at a time and sent as typed. They are kept no longer than that, never logged and never
 * drawn: the screen shows what the program echoes. `onFocusRequest` gets what gives the terminal the keys again.
 */
export function TerminalPane(props: {
  sessionID: string
  instrument: Instrument
  focused: boolean
  onFocusRequest?: (focus: (() => void) | undefined) => void
}) {
  const office = useOffice()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const keymap = useOpenCorpKeymap()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const [failure, setFailure] = createSignal<string>()
  const stream: StreamItem[] = []
  let terminal: EmbeddedTerminalRenderable | undefined
  let disposed = false
  // The room this view has; the size the office last took, and one it refused, not asked again until the shell's
  // status changes; whether a request is in flight; and whether this view may ask at all: the office refuses anyone
  // but the session's approver, and then this view only follows.
  let size: TerminalSize | undefined
  let given: TerminalSize | undefined
  let refused: TerminalSize | undefined
  let asking = false
  let sizing = true
  // The instrument's size, which the terminal draws at, and the size the terminal is at now.
  let canonicalSize: TerminalSize = props.instrument.size ?? DEFAULT_SIZE
  let queuedSize = canonicalSize
  let terminalSize: TerminalSize | undefined
  let lastIntermediateRender = 0
  let colors = terminalColors(theme.text, theme.backgroundPanel)

  // The size the terminal is laid out at, which follows the instrument's.
  const [drawn, setDrawn] = createSignal(canonicalSize)
  const setCanonicalSize = (value: TerminalSize) => {
    canonicalSize = value
    setDrawn(value)
  }

  // Bytes are written only once the terminal is at the size they were meant for.
  const processStream = () => {
    if (disposed || !terminal || !sameSize(canonicalSize, terminalSize)) return
    while (stream.length > 0) {
      const item = stream[0]!
      if (item.type === "output") {
        stream.shift()
        const output = [item.data]
        while (true) {
          const next = stream[0]
          if (!next || next.type !== "output") break
          output.push(next.data)
          stream.shift()
        }
        terminal.write(output.length === 1 ? output[0]! : Buffer.concat(output))
        continue
      }
      if (item.type === "resize") {
        setCanonicalSize(item.size)
        if (!sameSize(canonicalSize, terminalSize)) return
        stream.shift()
        continue
      }
      // A screen read starts the terminal over, in the theme's colours.
      stream.shift()
      terminal.write(Buffer.concat([RESET, colors, item.data]))
    }
  }

  const enqueue = (item: StreamItem) => {
    stream.push(item)
    processStream()
  }

  followOutput({
    sessionID: props.sessionID,
    instrumentID: props.instrument.id,
    screen: (data) => enqueue({ type: "screen", data }),
    output: (data) => {
      enqueue({ type: "output", data })
      const now = performance.now()
      if (now - lastIntermediateRender >= 16) {
        lastIntermediateRender = now
        renderer.intermediateRender()
      }
    },
    resize: (next) => {
      if (sameSize(next, queuedSize)) return
      queuedSize = next
      enqueue({ type: "resize", size: next })
    },
    failed: setFailure,
  })

  /**
   * Asks the office to give the shell this view's size, unless it has it or refused it, or the office has refused
   * this view. One request goes at a time, so the office takes sizes in order; when it answers, the newest size goes.
   */
  const sendSize = () => {
    if (!sizing || asking || !size || !LIVE.includes(props.instrument.status)) return
    // The office takes 10 by 4 at least.
    if (size.cols < 10 || size.rows < 4) return
    const asked = { cols: Math.min(size.cols, 1000), rows: Math.min(size.rows, 500) }
    if (sameSize(asked, given) || sameSize(asked, refused)) return
    asking = true
    office.client.sessions
      .resize(props.sessionID, props.instrument.id, asked)
      .then(
        () => {
          given = asked
          refused = undefined
        },
        (error) => {
          if (error instanceof OfficeError && error.status === 403) sizing = false
          else refused = asked
        },
      )
      .finally(() => {
        asking = false
        if (!disposed) sendSize()
      })
  }
  // A shell still starting takes its size once it opens.
  createEffect(
    on(
      () => props.instrument.status,
      () => {
        refused = undefined
        sendSize()
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    colors = terminalColors(theme.text, theme.backgroundPanel)
    terminal?.write(colors)
  })

  const live = () => LIVE.includes(props.instrument.status)
  // Whether the office takes this view's keys: it refuses anyone but the session's approver, and then this view
  // stops sending them.
  let typing = true
  const keys = keyBatch((data) => {
    office.client.sessions.keys(props.sessionID, props.instrument.id, { data }).catch((error) => {
      if (!typing) return
      if (error instanceof OfficeError && error.status === 403) typing = false
      toast.show({ message: errorMessage(error), variant: "error" })
    })
  })
  onCleanup(
    routeShellKeys(keymap, leaderKey(tuiConfig), {
      focused: () => !!terminal?.focused && live(),
      press: (event) => terminal?.handleKeyPress(event),
    }),
  )
  createEffect(() => {
    if (!terminal) return
    if (props.focused) terminal.focus()
    else if (terminal.focused) terminal.blur()
  })
  props.onFocusRequest?.(() => terminal?.focus())

  onCleanup(() => {
    // Keys typed in the last frame go before the view does.
    keys.flush()
    props.onFocusRequest?.(undefined)
    disposed = true
  })

  const start = drawn()
  return (
    <box
      flexGrow={1}
      minWidth={0}
      minHeight={0}
      overflow="hidden"
      backgroundColor={theme.backgroundPanel}
      onSizeChange={function () {
        // A column of margin either side.
        size = { cols: Math.max(1, this.width - 2), rows: Math.max(1, this.height) }
        sendSize()
      }}
    >
      <embeddedTerminal
        transparentBackground={theme.backgroundPanel.a === 0}
        ref={(value) => {
          terminal = value
          // It starts at the size it is made with; each later size comes with onTerminalResize.
          terminalSize = start
        }}
        cols={start.cols}
        rows={start.rows}
        position="absolute"
        left={1}
        top={0}
        width={drawn().cols}
        height={drawn().rows}
        onTerminalResize={(cols, rows) => {
          terminalSize = { cols, rows }
          processStream()
        }}
        onData={(data, source) => {
          // The terminal's own answers to the program's queries aren't the owner's.
          if (source === "input" && typing && live()) keys.push(data)
        }}
      />
      <Show when={failure()}>
        {(message) => (
          <text position="absolute" left={1} bottom={0} fg={theme.error} wrapMode="word">
            {message()}
          </text>
        )}
      </Show>
    </box>
  )
}

function sameSize(first: TerminalSize | undefined, second: TerminalSize | undefined) {
  return !!first && !!second && first.cols === second.cols && first.rows === second.rows
}

/** The OSC sequences that set a terminal's default text and background colours. */
export function terminalColors(text: RGBA, background: RGBA) {
  return Buffer.from(`\x1b]10;${hex(text)}\x1b\\\x1b]11;${hex(background)}\x1b\\`)
}

function hex(color: RGBA) {
  return `#${color
    .toInts()
    .slice(0, 3)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`
}

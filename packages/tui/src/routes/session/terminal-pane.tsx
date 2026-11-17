import { EmbeddedTerminalRenderable, type RGBA } from "@opentui/core"
import { extend, useRenderer } from "@opentui/solid"
import type { Instrument, InstrumentOutput } from "@opencorp/protocol"
import { asInstrument, OfficeError } from "@opencorp/client"
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { errorMessage } from "../../util/error"

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
/** The statuses in which a shell takes a size; the office refuses one before it starts and after it ends. */
const SIZABLE: readonly Instrument["status"][] = ["idle", "running", "waiting"]
/** Starts a terminal over (RIS), before it draws a screen read again. */
const RESET = Buffer.from("\x1bc")

/**
 * Follows instrument `instrumentID`'s raw output as the office serves it: `screen` gets the bytes it still holds,
 * with the offset they start at, on open and again after a gap; then `output` gets each `instrument.output` event's
 * bytes past what was had, so each byte arrives once however events were coalesced. `failed` says why a screen
 * couldn't be read; the next output past what was had tries again.
 */
export function followOutput(opts: {
  sessionID: string
  instrumentID: string
  screen: (data: Uint8Array, offset: number) => void
  output: (data: Uint8Array) => void
  failed: (message: string | undefined) => void
}) {
  const office = useOffice()
  // The offset of the first byte this view doesn't have.
  let have = 0
  let loading = true
  let disposed = false
  // Events that came while a screen read was in flight, applied after it.
  const held: InstrumentOutput[] = []

  const apply = (event: InstrumentOutput) => {
    // An event past what this view has is a gap: the office dropped output it couldn't send in time.
    if (event.offset > have) return void load()
    const data = Buffer.from(event.data, "base64")
    const start = have - event.offset
    if (start >= data.length) return
    have = event.offset + data.length
    opts.output(data.subarray(start))
  }

  async function load() {
    loading = true
    try {
      const screen = await office.client.sessions.instrumentScreen(opts.sessionID, opts.instrumentID)
      if (disposed) return
      have = screen.end
      opts.screen(Buffer.from(screen.data, "base64"), screen.offset)
      opts.failed(undefined)
    } catch (error) {
      if (!disposed) opts.failed(errorMessage(error))
    } finally {
      loading = false
    }
    while (!disposed && !loading && held.length > 0) apply(held.shift()!)
  }

  const off = office.on("instrument.output", (e) => {
    const event = e.data as Partial<InstrumentOutput>
    if (e.session_id !== opts.sessionID || event.instrument_id !== opts.instrumentID) return
    if (typeof event.offset !== "number" || typeof event.data !== "string") return
    if (loading) held.push(event as InstrumentOutput)
    else apply(event as InstrumentOutput)
  })
  onMount(() => void load())
  onCleanup(() => {
    disposed = true
    off()
  })
}

/**
 * A PTY shell's screen, drawn by OpenTUI's embedded terminal from the office's screen and the output past it, at the
 * instrument's size. The session's approver's view sends its own size, on open and whenever it changes, and the PTY
 * takes it; any other view only follows the instrument's.
 */
export function TerminalPane(props: { sessionID: string; instrument: Instrument }) {
  const office = useOffice()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [failure, setFailure] = createSignal<string>()
  const stream: StreamItem[] = []
  let terminal: EmbeddedTerminalRenderable | undefined
  let disposed = false
  // The room this view has, the size the office was last asked for, and whether it may ask: the office refuses
  // anyone but the session's approver, and then this view only follows.
  let size: TerminalSize | undefined
  let sent: TerminalSize | undefined
  let sizing = true
  // The instrument's size, which the terminal draws at, and the size the terminal is at now.
  let canonicalSize: TerminalSize = props.instrument.size ?? DEFAULT_SIZE
  let queuedSize = canonicalSize
  let terminalSize: TerminalSize | undefined
  let lastIntermediateRender = 0
  let colors = terminalColors(theme.text, theme.backgroundPanel)

  const setCanonicalSize = (value: TerminalSize) => {
    canonicalSize = value
    if (!terminal) return
    terminal.width = value.cols
    terminal.height = value.rows
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
    failed: setFailure,
  })

  // A new size comes in order with the output, so the bytes after it are drawn at it.
  const offSize = office.on("instrument.updated", (e) => {
    const next = asInstrument(e.data)
    if (next?.id !== props.instrument.id || !next.size || sameSize(next.size, queuedSize)) return
    queuedSize = next.size
    enqueue({ type: "resize", size: next.size })
  })

  /** Asks the office to give the shell this view's size, unless it has it, or the office has refused this view. */
  const sendSize = () => {
    if (!sizing || !size || sameSize(size, sent) || !SIZABLE.includes(props.instrument.status)) return
    // The office takes 10 by 4 at least.
    if (size.cols < 10 || size.rows < 4) return
    const asked = { cols: Math.min(size.cols, 1000), rows: Math.min(size.rows, 500) }
    sent = asked
    office.client.sessions.resize(props.sessionID, props.instrument.id, asked).catch((error) => {
      if (error instanceof OfficeError && error.status === 403) sizing = false
      else if (sameSize(sent, asked)) sent = undefined
    })
  }
  // A shell still starting takes its size once it opens.
  createEffect(on(() => props.instrument.status, sendSize, { defer: true }))

  createEffect(() => {
    colors = terminalColors(theme.text, theme.backgroundPanel)
    terminal?.write(colors)
  })

  onCleanup(() => {
    disposed = true
    offSize()
  })

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
          terminalSize = { cols: 80, rows: 24 }
          setCanonicalSize(canonicalSize)
        }}
        position="absolute"
        left={1}
        top={0}
        width={80}
        height={24}
        onTerminalResize={(cols, rows) => {
          terminalSize = { cols, rows }
          processStream()
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

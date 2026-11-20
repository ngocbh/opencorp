/** A terminal's shell as one of its session's live instruments: its state as it is now, the owner's keys and Ctrl-C,
 *  and the size the owner's view draws it at. It declares the registry's `LiveInstrument` by its shape, so the terminal
 *  imports nothing of the sessions. The adapter keeps none of the keys it passes on. */
import { type Instrument, now } from "@opencorp/protocol"
import { PtyShell, type ShellState } from "./shell.ts"
import type { TerminalProfile, TerminalShell } from "./terminal.ts"

/** The owner's Ctrl-C. */
const CTRL_C = "\x03"
/** The size a PTY shell opens at, until the owner's view gives one. */
const OPEN_SIZE = { cols: 80, rows: 24 } as const
const STARTING: ShellState = { status: "starting", waiting: null, command: null, exit: null, error: null }

/** A shell as the registry lists it: `LiveInstrument`, by its shape. */
export interface ShellInstrument {
  readonly id: string
  readonly interactive: boolean
  info(): Instrument
  keys(data: string): void
  interrupt(): void
  resize(cols: number, rows: number): void
}

/** What a shell's listing is made from: the session it is listed in, its id and name, who drives it, the sandbox it
 *  runs in, whether it is a PTY, and the shell itself once it is open (undefined while it starts). */
export interface ShellInstrumentInit {
  readonly sessionId: string
  readonly id: string
  readonly name: string
  readonly driver: string
  readonly profile: TerminalProfile
  readonly interactive: boolean
  shell(): TerminalShell | undefined
}

/** Shell `o.id` as a live instrument: `starting` until it opens, then its state as the shell has it. The owner's keys
 *  and Ctrl-C go to the shell as the owner's (`ownerKeys`), never as the agent's, so the agent's place in its output
 *  stays put; a pipes shell takes only the Ctrl-C. A resize reaches a PTY and the listing's size. */
export function shellInstrument(o: ShellInstrumentInit): ShellInstrument {
  const created = now()
  let size: { cols: number; rows: number } | null = o.interactive ? { ...OPEN_SIZE } : null
  return {
    id: o.id,
    interactive: o.interactive,
    info: () => {
      const { status, waiting, command, error } = o.shell()?.state() ?? STARTING
      return {
        id: o.id,
        session_id: o.sessionId,
        kind: "terminal",
        name: o.name,
        driver: o.driver,
        profile: o.profile,
        interactive: o.interactive,
        size: size && { ...size },
        status,
        waiting,
        command,
        error,
        created_at: created,
        updated_at: now(),
      }
    },
    keys: (data) => o.shell()?.ownerKeys(data),
    interrupt: () => o.shell()?.ownerKeys(CTRL_C),
    resize: (cols, rows) => {
      if (size === null) return
      size = { cols, rows }
      const shell = o.shell()
      if (shell instanceof PtyShell) shell.resize(cols, rows)
    },
  }
}

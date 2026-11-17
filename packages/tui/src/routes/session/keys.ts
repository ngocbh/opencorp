import type { KeyEvent } from "@opentui/core"
import type { KeyLike } from "@opentui/keymap"
import { LEADER_TOKEN, type OpenTuiKeymap } from "../../keymap"

/** How long a shell's keys gather before they go together: a frame. */
export const KEY_BATCH_MS = 16
/** The most characters one keys request carries; the office refuses more. */
const REQUEST_CHARS = 4096

/**
 * While `shell.focused()`, hands every key to `shell.press` ahead of the TUI's own bindings: text, Enter, Esc, Tab,
 * Ctrl-C and every other control key, as the upstream TUI's terminal pane does. The leader and the key after it
 * stay with the keymap, which runs that key's binding; a key after the leader that runs nothing goes nowhere, and
 * the leader twice is the leader key itself, as tmux's prefix sends its own. Returns what stops it.
 */
export function routeShellKeys(
  keymap: OpenTuiKeymap,
  leader: KeyLike | undefined,
  shell: { focused(): boolean; press(event: KeyEvent): void },
) {
  const isLeader = leader ? keymap.createKeyMatcher(leader) : () => false
  const leaderPending = () => keymap.getPendingSequence()[0]?.tokenName === LEADER_TOKEN
  const offKeys = keymap.intercept(
    "key",
    ({ event, consume }) => {
      if (!shell.focused()) return
      if (leaderPending()) {
        if (!isLeader(event)) return
        keymap.clearPendingSequence()
      } else if (isLeader(event)) return
      consume()
      shell.press(event)
    },
    { priority: 100 },
  )
  // Unconsumed, a key that misses after the leader would fall through to the focused terminal.
  const offMiss = keymap.intercept("key:after", ({ reason, consume }) => {
    if (reason === "sequence-miss" && shell.focused()) consume()
  })
  return () => {
    offKeys()
    offMiss()
  }
}

/**
 * Gathers the bytes a shell's keys encode to and hands them to `send` together once every `ms`, as text, in the
 * order typed: a batch longer than one request takes goes in pieces, never splitting a character. Nothing is kept
 * once sent. `flush` sends what is gathered now.
 */
export function keyBatch(send: (data: string) => void, ms = KEY_BATCH_MS) {
  let gathered = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    let data = gathered
    gathered = ""
    while (data.length > 0) {
      let end = Math.min(data.length, REQUEST_CHARS)
      // A high surrogate at the cut goes with its pair.
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--
      send(data.slice(0, end))
      data = data.slice(end)
    }
  }
  return {
    push(bytes: Uint8Array) {
      gathered += new TextDecoder().decode(bytes)
      timer ??= setTimeout(flush, ms)
    },
    flush,
  }
}

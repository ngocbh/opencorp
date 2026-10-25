import type { SetupPrompt } from "@opencorp/protocol"

/** The running install: its prompts, a way to answer, and how it ended. */
export interface SetupChild {
  /** Called with each prompt in order, including those that came before the listener. */
  onPrompt(listener: (prompt: SetupPrompt) => void): void
  /** Sends the answer to the pending question; nothing once the child has exited. */
  answer(text: string): void
  /** Asks it to stop (SIGINT); a second call kills it. */
  interrupt(): void
  /** Ends its stdin and sends SIGINT if it is still running: for when the screen goes away. */
  close(): void
  /** Its exit code, once it has exited and its stdout and stderr have ended. */
  done: Promise<number>
  /** The last 64 KB it wrote on stderr. */
  stderr(): string
}

const STDERR_MAX = 65536

/** `text` without control characters, which could move the cursor or retitle the terminal. */
export function plain(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
}

/** `line` as the prompt it holds, or as a `say` of the raw line when it holds none. */
function parse(line: string): SetupPrompt {
  let value: any
  try {
    value = JSON.parse(line)
  } catch {}
  const str = (x: unknown) => typeof x === "string"
  const opt = (x: unknown) => x === undefined || str(x)
  const int = (x: unknown) => Number.isInteger(x)
  if (value && typeof value === "object") {
    if (value.type === "say" && str(value.text)) return { type: "say", text: plain(value.text) }
    if (value.type === "step" && int(value.number) && int(value.total) && str(value.title) && str(value.why))
      return {
        type: "step",
        number: value.number,
        total: value.total,
        title: plain(value.title),
        why: plain(value.why),
      }
    if (value.type === "ask" && str(value.question) && opt(value.default))
      return { type: "ask", question: plain(value.question), default: plain(value.default ?? "") }
    if (value.type === "secret" && str(value.question)) return { type: "secret", question: plain(value.question) }
    if (
      value.type === "choose" &&
      str(value.question) &&
      opt(value.default) &&
      Array.isArray(value.options) &&
      value.options.length > 0 &&
      value.options.every(str)
    )
      return {
        type: "choose",
        question: plain(value.question),
        options: value.options.map(plain),
        default: plain(value.default ?? ""),
        typed: value.typed === true,
      }
  }
  return { type: "say", text: plain(line) }
}

/** Calls `onText` with the text `reader` reads, chunk by chunk, until its stream ends or is cancelled. */
async function readText(reader: ReadableStreamDefaultReader<Uint8Array>, onText: (text: string) => void) {
  const decoder = new TextDecoder()
  for (let r = await reader.read(); !r.done; r = await reader.read()) onText(decoder.decode(r.value, { stream: true }))
  onText(decoder.decode())
}

/**
 * Spawns `argv` in `cwd` with exactly `env` (the caller picks it) plus GIT_TERMINAL_PROMPT=0, in its own session
 * with piped stdio, and reads its stdout as `SetupPrompt` lines.
 */
export function spawnSetup(argv: string[], cwd: string, env: Record<string, string>): SetupChild {
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Its own session: git and ssh in it find no terminal to prompt on while the screen holds it, so they
    // fail and say so instead of drawing over the screen and fighting it for keys.
    detached: true,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  })

  const stdout = proc.stdout.getReader()
  const stderrReader = proc.stderr.getReader()
  const queued: SetupPrompt[] = []
  let listener: ((prompt: SetupPrompt) => void) | undefined
  let buffer = ""
  const emit = (line: string) => {
    const prompt = parse(line)
    if (listener) listener(prompt)
    else queued.push(prompt)
  }
  const stdoutEnded = readText(stdout, (text) => {
    const lines = (buffer + text).split("\n")
    buffer = lines.pop()!
    for (const line of lines) emit(line)
  })
    .catch(() => {})
    .then(() => {
      // The last line, even without a newline.
      if (buffer) emit(buffer)
    })

  let stderr = ""
  const stderrEnded = readText(stderrReader, (text) => (stderr = (stderr + text).slice(-STDERR_MAX))).catch(() => {})

  // The child leads its own process group, so a signal to the group reaches the git or ssh it started too.
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, sig)
    } catch {}
  }
  let interrupts = 0

  return {
    onPrompt(next) {
      listener = next
      for (const prompt of queued.splice(0)) next(prompt)
    },
    answer(text) {
      // The child may have just died, and the write fail with EPIPE, now or once flushed.
      try {
        proc.stdin.write(JSON.stringify({ answer: text }) + "\n")
        void Promise.resolve(proc.stdin.flush()).catch(() => {})
      } catch {}
    },
    interrupt() {
      signal(interrupts++ === 0 ? "SIGINT" : "SIGKILL")
    },
    close() {
      try {
        void Promise.resolve(proc.stdin.end()).catch(() => {})
      } catch {}
      if (proc.exitCode === null && proc.signalCode === null) signal("SIGINT")
    },
    // The last lines (the error, or "Done.") can still be in the pipes when the child exits; and a grandchild
    // that kept a pipe open must not hang the screen, so the wait for them is bounded.
    done: proc.exited.then(async (code) => {
      await Promise.race([Promise.all([stdoutEnded, stderrEnded]), Bun.sleep(2000)])
      // A grandchild still holding a pipe would otherwise keep its reader waiting for the rest of the process.
      for (const reader of [stdout, stderrReader])
        try {
          void reader.cancel().catch(() => {})
        } catch {}
      return code
    }),
    stderr: () => stderr,
  }
}

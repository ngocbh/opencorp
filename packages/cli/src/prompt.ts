// Asking on the terminal. A secret is read in raw mode, so it is never echoed; tests swap in a
// prompter with set answers.
import readline from "node:readline/promises"

/** How `opencorp` asks the person at the terminal. */
export interface Prompter {
  /** Whether there's a terminal to ask on; without one, nothing is asked. */
  readonly interactive: boolean
  /** An answer, or `fallback` for an empty one. */
  ask(question: string, fallback?: string): Promise<string>
  /** An answer read without echo. */
  secret(question: string): Promise<string>
}

/** Asks on this process's terminal, writing questions to stderr so stdout stays the command's output. */
export const ttyPrompter: Prompter = {
  get interactive() {
    return Boolean(process.stdin.isTTY)
  },
  async ask(question, fallback = "") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    try {
      return (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim() || fallback
    } finally {
      rl.close()
    }
  },
  secret(question) {
    const stdin = process.stdin
    process.stderr.write(`${question}: `)
    stdin.setRawMode(true)
    stdin.resume()
    return new Promise((resolve) => {
      let answer = ""
      const done = () => {
        stdin.off("data", onData)
        stdin.setRawMode(false)
        stdin.pause()
        process.stderr.write("\n")
      }
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") {
            done()
            return resolve(answer)
          }
          if (ch === "\u0003") {
            // Raw mode turns Ctrl-C into a byte; stop as the signal would have.
            done()
            process.exit(130)
          }
          if (ch === "\u007f" || ch === "\b") answer = answer.slice(0, -1)
          else if (ch >= " ") answer += ch
        }
      }
      stdin.on("data", onData)
    })
  },
}

let current: Prompter = ttyPrompter

/** The prompter commands ask with. */
export const prompter = () => current

/** Makes `p` the prompter commands ask with; returns a function that puts back the one before. */
export function usePrompter(p: Prompter) {
  const before = current
  current = p
  return () => void (current = before)
}


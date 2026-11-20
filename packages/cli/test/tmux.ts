// A real terminal for the CLI's tests: a tmux server of the test's own, running one `opencorp` command through the
// checkout's wrapper with exactly the env it is given.
import { onTestFinished } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { WRAPPER } from "./remote"

/** tmux, where the test machines have it; the tests that need it skip without it. */
export const TMUX = Bun.which("tmux", { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" })

/** `s` as one sh word. */
const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** A tmux server of its own (`-L`), killed and its socket removed when the test finishes, running
 *  `opencorp <command>` under `env -i` with `c.env` and `TERM` `term`, in a window `size` big (120x40 unless given);
 *  the command's exit status lands in `<c.root>/exit`. */
export function terminal(
  c: { env: Record<string, string>; root: string },
  command: string[],
  { term = "xterm", size = [120, 40] }: { term?: string; size?: [number, number] } = {},
) {
  const server = `oc-tty-${randomBytes(4).toString("hex")}`
  const tmux = (...args: string[]) =>
    execFileSync(TMUX!, ["-L", server, ...args], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })
  const exitFile = path.join(c.root, "exit")
  const name = `opencorp ${command[0] ?? ""}`.trim()
  // tmux 2.7 has no `new-session -e`: the env goes in the command.
  const env = Object.entries({ ...c.env, TERM: term }).map(([k, v]) => sq(`${k}=${v}`))
  // tmux 2.7 loses the first row's text once a pane dies, so the command starts on the second.
  const line = `echo; env -i ${env.join(" ")} ${sq(WRAPPER)} ${command.map(sq).join(" ")}; echo exit=$? > ${sq(exitFile)}`
  tmux("-f", "/dev/null", "new-session", "-d", "-s", "tty", "-x", String(size[0]), "-y", String(size[1]), line)
  // The window stays once the command ends, so a test can still read it.
  tmux("set-window-option", "-t", "tty", "remain-on-exit", "on")
  onTestFinished(() => {
    try {
      tmux("kill-server")
    } catch {}
    // With no TMUX_TMPDIR in its env, the server's socket is here; tmux 2.7 leaves it once the server has gone.
    fs.rmSync(path.join("/tmp", `tmux-${process.getuid!()}`, server), { force: true })
  })
  const screen = () => {
    try {
      return tmux("capture-pane", "-p", "-t", "tty")
    } catch {
      return ""
    }
  }
  return {
    screen,
    /** Waits until the window shows `text`. */
    async see(text: string, ms = 60_000) {
      const deadline = performance.now() + ms
      while (!screen().includes(text)) {
        if (fs.existsSync(exitFile)) throw new Error(`${name} ended before showing ${text}: ${fs.readFileSync(exitFile, "utf8")}`)
        if (performance.now() > deadline) throw new Error(`no ${text} within ${ms} ms:\n${screen()}`)
        await Bun.sleep(100)
      }
    },
    keys: (...keys: string[]) => void tmux("send-keys", "-t", "tty", ...keys),
    /** Whether the window shows the alternate screen, as the setup screen draws on. */
    alternate: () => tmux("display-message", "-p", "-t", "tty", "#{alternate_on}").trim() === "1",
    /** The `opencorp` process in the pane (the shell's child), or undefined. */
    pid: () => {
      const pane = Number(tmux("display-message", "-p", "-t", "tty", "#{pane_pid}").trim())
      try {
        const kids = fs.readFileSync(`/proc/${pane}/task/${pane}/children`, "utf8").trim().split(/\s+/).filter(Boolean)
        return kids.length > 0 ? Number(kids[0]) : undefined
      } catch {
        return undefined
      }
    },
    /** Changes the pane's window size, which sends SIGWINCH to the program (tmux 2.7 has no resize-window). */
    resize: (cols: number, rows: number) => {
      const tty = tmux("display-message", "-p", "-t", "tty", "#{pane_tty}").trim()
      const stty = ["/bin/stty", "/usr/bin/stty"].find((f) => fs.existsSync(f))
      if (stty) execFileSync(stty, ["-F", tty, "cols", String(cols), "rows", String(rows)], { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 })
    },
    /** Types `text` as is, then Enter. */
    type: (text: string) => {
      tmux("send-keys", "-t", "tty", "-l", text)
      tmux("send-keys", "-t", "tty", "Enter")
    },
    /** Whether the command has ended. */
    ended: () => fs.existsSync(exitFile) && fs.readFileSync(exitFile, "utf8").includes("\n"),
    /** The `exit=N` line, once the command ended. */
    async exit(ms = 30_000) {
      const deadline = performance.now() + ms
      while (!fs.existsSync(exitFile) || !fs.readFileSync(exitFile, "utf8").includes("\n")) {
        if (performance.now() > deadline) throw new Error(`${name} didn't end within ${ms} ms:\n${screen()}`)
        await Bun.sleep(100)
      }
      return fs.readFileSync(exitFile, "utf8").trim()
    },
  }
}

export type Terminal = ReturnType<typeof terminal>

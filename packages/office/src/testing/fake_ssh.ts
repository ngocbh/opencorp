/** A stand-in for ssh in tests, run through a sh shim with this Bun: it logs each argv and acts, on this machine, as a
 *  plain session, a master, a mux client or an `-O` command.
 *
 *  Each host logs in by its mode (`FakeHost`); a session's command runs here under `/bin/sh -c`. From the `-F` file
 *  (and `-o`) it reads only `ControlMaster`, `ControlPath` (`%C` is `fakeControlName`) and `BatchMode`. A master
 *  listens on its control socket and takes one JSON line per connection: `{"op":"check"|"exit"|"session"}` or
 *  `{"op":"forward","port":P,"target":T}`, answering `ok` or `error <why>`. */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** ok; refuse (255, "Permission denied"); hang; tty ("fake password for <host>: " on /dev/tty, the line read appended
 *  to tty.txt). `batch` applies when the -F file holds `BatchMode yes`. */
export interface FakeHost {
  login?: "ok" | "refuse" | "hang" | "tty"
  batch?: "ok" | "refuse"
}
export interface FakeSshBehavior extends FakeHost {
  /** By host name, over the top-level modes. */
  hosts?: Record<string, FakeHost>
  /** `-O forward`: ok; refuse (255); blackhole (0, then closes each connection). */
  forward?: "ok" | "refuse" | "blackhole"
  /** How long an auto master stays after its last connection closes; default 10 s. */
  persistMs?: number
}
export interface FakeSsh {
  /** The folder holding `ssh`, to put first on PATH. */
  readonly bin: string
  readonly ssh: string
  /** behavior.json, log.jsonl, masters/, tty.txt. */
  readonly state: string
  /** Replaces the behavior; each later call reads it. */
  set(b: FakeSshBehavior): void
  /** Each argv the fake was run with, in order. */
  calls(): string[][]
  /** The lines typed at its password prompts. */
  tty(): string[]
  /** The pids of its masters still running. */
  masters(): number[]
}

/** The fake's `%C`: sha1 of the host name (real ssh hashes more). */
export const fakeControlName = (host: string) => createHash("sha1").update(host).digest("hex")
/** Every fake master ends by then, so a forgotten one doesn't linger. */
export const FAKE_MASTER_MAX_MS = 120_000

const SELF = fileURLToPath(import.meta.url)
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]

/** Installs `<dir>/bin/ssh`, state in `<dir>/state` (behavior.json, log.jsonl, masters/, tty.txt). */
export function installFakeSsh(dir: string, behavior: FakeSshBehavior = {}): FakeSsh {
  const bin = path.join(dir, "bin")
  const state = path.join(dir, "state")
  const ssh = path.join(bin, "ssh")
  for (const p of [process.execPath, SELF, state])
    if (p.includes("'")) throw new Error(`the fake ssh's shim can't quote ${p}`)
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(state, "masters"), { recursive: true })
  // Paths baked in: ssh's children get no test variables.
  const shim = `#!/bin/sh\nexec '${process.execPath}' ${BUN_FLAGS.join(" ")} '${SELF}' '${state}' "$@"\n`
  fs.writeFileSync(ssh, shim, { mode: 0o700 })
  const set = (b: FakeSshBehavior) => fs.writeFileSync(path.join(state, "behavior.json"), JSON.stringify(b))
  set(behavior)
  const lines = (file: string) =>
    fs.existsSync(path.join(state, file))
      ? fs.readFileSync(path.join(state, file), "utf8").split("\n").filter((line) => line !== "")
      : []
  return {
    bin,
    ssh,
    state,
    set,
    calls: () => lines("log.jsonl").map((line) => JSON.parse(line) as string[]),
    tty: () => lines("tty.txt"),
    masters: () =>
      (fs.existsSync(path.join(state, "masters")) ? fs.readdirSync(path.join(state, "masters")) : [])
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && alive(pid)),
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const WITH_VALUE = "FSoJpOLliW"

/** An argv as ssh reads it: options, then the destination, then the command's words. */
interface Parsed {
  values: Map<string, string[]>
  flags: Set<string>
  host: string | undefined
  command: string
}

function parse(argv: readonly string[]): Parsed {
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  let i = 0
  for (; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      i++
      break
    }
    if (!arg.startsWith("-") || arg === "-") break
    for (let j = 1; j < arg.length; j++) {
      const c = arg[j]!
      if (WITH_VALUE.includes(c)) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : (argv[++i] ?? "")
        values.set(c, [...(values.get(c) ?? []), value])
        break
      }
      flags.add(c)
    }
  }
  return { values, flags, host: argv[i], command: argv.slice(i + 1).join(" ") }
}

/** The options the fake reads: `-o` first, then the `-F` file; the first value of each wins, as in ssh. */
function options(p: Parsed): { controlMaster: string; controlPath: string | null; batch: boolean } {
  const found = new Map<string, string>()
  const take = (line: string) => {
    const m = /^\s*([A-Za-z]+)\s*(?:=|\s)\s*(.*?)\s*$/.exec(line)
    if (m && !found.has(m[1]!.toLowerCase())) found.set(m[1]!.toLowerCase(), m[2]!)
  }
  for (const o of p.values.get("o") ?? []) take(o)
  const file = p.values.get("F")?.at(-1)
  if (file !== undefined && file !== "/dev/null" && fs.existsSync(file))
    for (const line of fs.readFileSync(file, "utf8").split("\n")) if (!line.trim().startsWith("#")) take(line)
  return {
    controlMaster: (found.get("controlmaster") ?? "no").toLowerCase(),
    controlPath: found.get("controlpath") ?? null,
    batch: (found.get("batchmode") ?? "no").toLowerCase() === "yes",
  }
}

/** `[user@]host[:port]` as ssh names it in messages: without the port. */
const shown = (target: string) => target.replace(/:[0-9]+$/, "")
/** The host name alone, which modes and `%C` go by. */
const hostName = (target: string) => shown(target).replace(/^.*@/, "")

/** One run of the fake. */
class Run {
  readonly behavior: FakeSshBehavior
  constructor(
    readonly state: string,
    readonly argv: readonly string[],
  ) {
    const file = path.join(state, "behavior.json")
    this.behavior = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as FakeSshBehavior) : {}
  }

  /** How `target` logs in now. */
  mode(target: string, batch: boolean): "ok" | "refuse" | "hang" | "tty" {
    const host = this.behavior.hosts?.[hostName(target)] ?? {}
    const login = host.login ?? this.behavior.login ?? "ok"
    if (!batch) return login
    return host.batch ?? this.behavior.batch ?? (login === "tty" ? "refuse" : login)
  }

  /** Logs in to `target`: false (after ssh's words on stderr) when it's refused. */
  async login(target: string, batch: boolean): Promise<boolean> {
    const mode = this.mode(target, batch)
    if (mode === "ok") return true
    if (mode === "hang") return await new Promise<never>(() => setTimeout(() => process.exit(255), FAKE_MASTER_MAX_MS))
    if (mode === "tty" && this.prompt(hostName(target))) return true
    process.stderr.write(`${shown(target)}: Permission denied (publickey,password).\r\n`)
    return false
  }

  /** Asks for a password on /dev/tty, as ssh does, and records the line typed; false without a terminal. */
  prompt(host: string): boolean {
    let fd: number
    try {
      fd = fs.openSync("/dev/tty", "r+")
    } catch {
      return false
    }
    try {
      fs.writeSync(fd, `fake password for ${host}: `)
      spawnSync("stty", ["-echo"], { stdio: [fd, "ignore", "ignore"] })
      const bytes: number[] = []
      const one = Buffer.alloc(1)
      while (fs.readSync(fd, one, 0, 1, null) === 1 && one[0] !== 0x0a) if (one[0] !== 0x0d) bytes.push(one[0]!)
      spawnSync("stty", ["echo"], { stdio: [fd, "ignore", "ignore"] })
      fs.writeSync(fd, "\n")
      fs.appendFileSync(path.join(this.state, "tty.txt"), Buffer.from(bytes).toString("utf8") + "\n")
      return true
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Runs `command` here under `/bin/sh -c`, stdio inherited, and resolves to ssh's exit for it. */
  command(command: string): Promise<number> {
    if (command === "") return Promise.resolve(0)
    return new Promise((resolve) => {
      const child = spawn("/bin/sh", ["-c", command], { stdio: "inherit" })
      child.on("error", () => resolve(255))
      child.on("exit", (code) => resolve(code ?? 255))
    })
  }

  async main(): Promise<number> {
    fs.appendFileSync(path.join(this.state, "log.jsonl"), JSON.stringify(this.argv) + "\n")
    const p = parse(this.argv)
    const { batch } = options(p)
    if (p.host === undefined) {
      process.stderr.write("usage: ssh destination [command]\n")
      return 255
    }
    for (const hop of (p.values.get("J") ?? []).flatMap((j) => j.split(",")))
      if (!(await this.login(hop, batch))) return 255
    if (!(await this.login(p.host, batch))) return 255
    return await this.command(p.command)
  }
}

if (import.meta.main) {
  const [state, ...argv] = process.argv.slice(2)
  process.exit(await new Run(state!, argv).main())
}

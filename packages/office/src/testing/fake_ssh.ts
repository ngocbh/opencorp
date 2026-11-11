/** A stand-in for ssh in tests, run through a sh shim with this Bun: it logs each argv and acts, on this machine, as a
 *  plain session, a master, a mux client or an `-O` command.
 *
 *  Each host logs in by its mode (`FakeHost`); a session's command runs here under `/bin/sh -c`. From the `-F` file
 *  (and `-o`) it reads only `ControlMaster`, `ControlPath` (`%C` is `fakeControlName`) and `BatchMode`; `-G` accepts
 *  every option, as a current ssh would. A master
 *  listens on its control socket and takes one JSON line per connection: `{"op":"check"|"exit"|"session"}` or
 *  `{"op":"forward","port":P,"target":T}`, answering `ok` or `error <why>`. */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { selfCommand } from "../platform.ts"

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
  /** Written to stderr after each login that succeeds, as sshd's Banner or a node's login shell would. */
  banner?: string
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
/** This Bun, as the office runs its own code in a checkout, where every test runs. */
const BUN = selfCommand()[0]
const BUN_FLAGS = ["--no-install", "--no-env-file", "--config=/dev/null"]
const NO_CACHE = "BUN_RUNTIME_TRANSPILER_CACHE_PATH"

/** Installs `<dir>/bin/ssh`, state in `<dir>/state` (behavior.json, log.jsonl, masters/, tty.txt). */
export function installFakeSsh(dir: string, behavior: FakeSshBehavior = {}): FakeSsh {
  const bin = path.join(dir, "bin")
  const state = path.join(dir, "state")
  const ssh = path.join(bin, "ssh")
  for (const p of [BUN, SELF, state])
    if (p.includes("'")) throw new Error(`the fake ssh's shim can't quote ${p}`)
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(state, "masters"), { recursive: true })
  // Paths baked in: ssh's children get no test variables. No transpiler cache, which Bun keeps under HOME: a fake
  // that outlives its test would recreate the test's removed folder.
  const shim = `#!/bin/sh\n${NO_CACHE}=0 exec '${BUN}' ${BUN_FLAGS.join(" ")} '${SELF}' '${state}' "$@"\n`
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

function readBehavior(state: string): FakeSshBehavior {
  const file = path.join(state, "behavior.json")
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as FakeSshBehavior) : {}
}

/** A connection to the master at `sock`, or why there's none, in ssh's words. */
function connect(sock: string): Promise<net.Socket | string> {
  return new Promise((resolve) => {
    const c = net.connect(sock)
    c.once("connect", () => resolve(c))
    // Kept after the connect, so a later reset is absorbed; resolving again does nothing.
    c.on("error", (e: NodeJS.ErrnoException) =>
      resolve(e.code === "ENOENT" ? "No such file or directory" : e.code === "ECONNREFUSED" ? "Connection refused" : String(e.code)),
    )
  })
}

/** Whether a master answers at `sock`. */
async function live(sock: string): Promise<boolean> {
  const c = await connect(sock)
  if (typeof c === "string") return false
  c.destroy()
  return true
}

/** Sends one request to the master on `c` and resolves to its one-line answer ("" when it closed first). */
function ask(c: net.Socket, request: object): Promise<string> {
  return new Promise((resolve) => {
    let got = ""
    const onData = (d: Buffer) => {
      got += d.toString("utf8")
      const end = got.indexOf("\n")
      if (end < 0) return
      c.off("data", onData)
      c.off("close", onClose)
      resolve(got.slice(0, end))
    }
    const onClose = () => resolve("")
    c.on("data", onData)
    c.once("close", onClose)
    c.write(JSON.stringify(request) + "\n")
  })
}

/** A session held over the master at `sock`, or null when no master answers there. */
async function session(sock: string): Promise<net.Socket | null> {
  const c = await connect(sock)
  if (typeof c === "string") return null
  if ((await ask(c, { op: "session" })) === "ok") return c
  c.destroy()
  return null
}

/** One run of the fake. */
class Run {
  readonly behavior: FakeSshBehavior
  constructor(
    readonly state: string,
    readonly argv: readonly string[],
  ) {
    this.behavior = readBehavior(state)
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
    if (mode === "hang") return await new Promise<never>(() => setTimeout(() => process.exit(255), FAKE_MASTER_MAX_MS))
    if (mode === "ok" || (mode === "tty" && this.prompt(hostName(target)))) {
      if (this.behavior.banner !== undefined) process.stderr.write(this.behavior.banner)
      return true
    }
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

  /** The control socket for `target` from the config's ControlPath, or null when there's none. */
  socketFor(controlPath: string | null, target: string): string | null {
    return controlPath === null ? null : controlPath.replaceAll("%C", fakeControlName(hostName(target)))
  }

  /** Reaches the last of `hops`: rides the nearest one with a live master (a session held on it), then logs in to
   *  each after it; with `logIn` false only rides. Null when a login is refused. */
  async hops(hops: readonly string[], controlPath: string | null, batch: boolean, logIn = true): Promise<net.Socket[] | null> {
    const held: net.Socket[] = []
    let from = 0
    for (let i = hops.length - 1; i >= 0; i--) {
      const sock = this.socketFor(controlPath, hops[i]!)
      const c = sock === null ? null : await session(sock)
      if (c !== null) {
        held.push(c)
        from = i + 1
        break
      }
    }
    if (!logIn) return held
    for (const hop of hops.slice(from)) {
      if (!(await this.login(hop, batch))) {
        for (const c of held) c.destroy()
        return null
      }
    }
    return held
  }

  /** Runs `command` here under `/bin/sh -c`, stdio inherited, and resolves to ssh's exit for it: 255 when `over`, the
   *  session it runs in, closes first. */
  command(command: string, over?: net.Socket): Promise<number> {
    if (command === "") return Promise.resolve(0)
    return new Promise((resolve) => {
      const { [NO_CACHE]: _, ...env } = process.env
      const child = spawn("/bin/sh", ["-c", command], { env, stdio: "inherit" })
      const lost = () => {
        child.kill("SIGTERM")
        resolve(255)
      }
      over?.once("close", lost)
      child.on("error", () => resolve(255))
      child.on("exit", (code) => {
        over?.off("close", lost)
        resolve(code ?? 255)
      })
    })
  }

  /** A mux client: runs `command` over the master at `sock`. */
  async mux(sock: string, command: string): Promise<number> {
    const c = await connect(sock)
    if (typeof c === "string") {
      process.stderr.write(`Control socket connect(${sock}): ${c}\r\n`)
      return 255
    }
    if ((await ask(c, { op: "session" })) !== "ok") return 255
    const code = await this.command(command, c)
    c.destroy()
    return code
  }

  /** `-O <op>` on the master at `sock`. */
  async control(sock: string, op: string, forward: string | undefined): Promise<number> {
    const c = await connect(sock)
    if (typeof c === "string") {
      process.stderr.write(`Control socket connect(${sock}): ${c}\r\n`)
      return 255
    }
    let request: object = { op }
    if (op === "forward") {
      const m = /^127\.0\.0\.1:([0-9]+):(\/.*)$/.exec(forward ?? "")
      if (m === null) {
        process.stderr.write(`Bad local forwarding specification '${forward}'\r\n`)
        return 255
      }
      request = { op, port: Number(m[1]), target: m[2] }
    }
    const answer = await ask(c, request)
    c.destroy()
    if (answer === "ok") {
      if (op === "check") process.stderr.write("Master running\r\n")
      if (op === "exit") process.stderr.write("Exit request sent.\r\n")
      return 0
    }
    process.stderr.write(
      op === "forward"
        ? `mux_client_forward: forwarding request failed: ${answer.replace(/^error /, "")}\r\n`
        : `mux_client_request_${op}: master returned error: ${answer.replace(/^error /, "")}\r\n`,
    )
    return 255
  }

  async main(): Promise<number> {
    if (this.argv[0] === "--auto-master") return await this.autoMaster(this.argv[1]!, this.argv.slice(2))
    // `ssh -G` only checks options, as a newer ssh does; it isn't a call worth logging.
    if (this.argv.includes("-G")) return 0
    fs.appendFileSync(path.join(this.state, "log.jsonl"), JSON.stringify(this.argv) + "\n")
    const p = parse(this.argv)
    const { controlMaster, controlPath, batch } = options(p)
    if (p.host === undefined) {
      process.stderr.write("usage: ssh destination [command]\r\n")
      return 255
    }
    const hops = (p.values.get("J") ?? []).flatMap((j) => j.split(","))
    const sock = p.values.get("S")?.at(-1) ?? this.socketFor(controlPath, p.host)
    const op = p.values.get("O")?.at(-1)
    if (op !== undefined) return sock === null ? 255 : await this.control(sock, op, p.values.get("L")?.at(-1))
    if (p.flags.has("M")) {
      if (sock === null) return 255
      const held = await this.hops(hops, controlPath, batch)
      if (held === null || !(await this.login(p.host, batch))) return 255
      return await new Master(this.state, sock, false, held).run()
    }
    if (p.values.has("S")) return await this.mux(sock!, p.command)
    // A plain session: over a live master for its host, else after logging in.
    if (sock !== null && (await live(sock))) return await this.mux(sock, p.command)
    const held = await this.hops(hops, controlPath, batch)
    if (held === null) return 255
    if (!(await this.login(p.host, batch))) return 255
    if (sock !== null && controlMaster === "auto") {
      // As ControlPersist does: a master goes to the background and this session runs over it.
      spawn(BUN, [...BUN_FLAGS, SELF, this.state, "--auto-master", sock, ...this.argv], {
        detached: true,
        stdio: "ignore",
      }).unref()
      const deadline = Date.now() + 2000
      while (!fs.existsSync(sock) && Date.now() < deadline) await sleep(20)
      for (const c of held) c.destroy()
      return await this.mux(sock, p.command)
    }
    const code = await this.command(p.command)
    for (const c of held) c.destroy()
    return code
  }

  /** The detached master a plain session under `ControlMaster auto` leaves: it rides the session's hops' masters (the
   *  session logged in to the rest) and ends `persistMs` after its last connection. */
  async autoMaster(sock: string, argv: readonly string[]): Promise<number> {
    const p = parse(argv)
    const { controlPath, batch } = options(p)
    const held = await this.hops((p.values.get("J") ?? []).flatMap((j) => j.split(",")), controlPath, batch, false)
    return await new Master(this.state, sock, true, held ?? []).run()
  }
}

/** A fake master: its control socket, the sessions and forwarded connections open on it, and its forwards. */
class Master {
  readonly #open = new Set<net.Socket>()
  readonly #others = new Set<net.Socket>()
  readonly #forwards: net.Server[] = []
  readonly #server = net.createServer((c) => this.#serve(c))
  #ino: number | null = null
  #stdinEnded = false
  #persist: ReturnType<typeof setTimeout> | undefined
  #ending = false

  constructor(
    readonly state: string,
    readonly sock: string,
    readonly auto: boolean,
    readonly hops: net.Socket[],
  ) {}

  /** Listens until it ends, then exits the process. */
  async run(): Promise<number> {
    const listening = await new Promise<boolean>((resolve) => {
      this.#server.once("error", () => resolve(false))
      this.#server.listen(this.sock, () => resolve(true))
    })
    if (!listening) {
      process.stderr.write(`ControlSocket ${this.sock} already exists, disabling multiplexing\r\n`)
      for (const c of this.hops) c.destroy()
      return 255
    }
    this.#ino = fs.lstatSync(this.sock).ino
    fs.writeFileSync(path.join(this.state, "masters", String(process.pid)), "")
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => this.end(255))
    setTimeout(() => this.end(255), FAKE_MASTER_MAX_MS).unref()
    // Its transport runs through each hop: losing one loses the connection.
    for (const c of this.hops) c.once("close", () => this.end(255))
    if (!this.auto) {
      process.stdin.on("data", () => {})
      const ended = () => {
        this.#stdinEnded = true
        this.#changed()
      }
      process.stdin.once("end", ended)
      process.stdin.once("close", ended)
      process.stdin.resume()
    }
    this.#changed()
    return await new Promise<never>(() => {})
  }

  #serve(c: net.Socket): void {
    c.on("error", () => {})
    this.#others.add(c)
    c.once("close", () => this.#others.delete(c))
    let got = ""
    const onData = (d: Buffer) => {
      got += d.toString("utf8")
      const end = got.indexOf("\n")
      if (end < 0) return
      c.off("data", onData)
      this.#request(c, JSON.parse(got.slice(0, end)) as { op: string; port?: number; target?: string })
    }
    c.on("data", onData)
  }

  #request(c: net.Socket, request: { op: string; port?: number; target?: string }): void {
    if (request.op === "check") c.end("ok\n")
    else if (request.op === "exit") {
      // The socket goes before the answer, so `-O exit` returning means it's gone.
      this.#unlink()
      c.end("ok\n", () => this.end(0))
    } else if (request.op === "session") {
      c.write("ok\n")
      this.#track(c)
    } else if (request.op === "forward") this.#forward(c, request.port!, request.target!)
    else c.end(`error unknown op ${request.op}\n`)
  }

  #forward(c: net.Socket, port: number, target: string): void {
    const mode = readBehavior(this.state).forward ?? "ok"
    if (mode === "refuse") return void c.end("error Port forwarding failed\n")
    const server = net.createServer((conn) => {
      conn.on("error", () => {})
      if (mode === "blackhole") return void conn.destroy()
      const upstream = net.connect(target)
      upstream.on("error", () => conn.destroy())
      conn.pipe(upstream)
      upstream.pipe(conn)
      conn.once("close", () => upstream.destroy())
      upstream.once("close", () => conn.destroy())
      this.#track(conn)
    })
    server.once("error", () => c.end("error Port forwarding failed\n"))
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      this.#forwards.push(server)
      c.end("ok\n")
    })
  }

  /** Counts `c` as an open channel until it closes. */
  #track(c: net.Socket): void {
    this.#open.add(c)
    this.#changed()
    c.once("close", () => {
      this.#open.delete(c)
      this.#changed()
    })
  }

  #changed(): void {
    clearTimeout(this.#persist)
    if (this.#open.size > 0) return
    if (this.auto) this.#persist = setTimeout(() => this.end(0), readBehavior(this.state).persistMs ?? 10_000)
    else if (this.#stdinEnded) this.end(0)
  }

  /** Removes the control socket if it's still ours. */
  #unlink(): void {
    if (fs.lstatSync(this.sock, { throwIfNoEntry: false })?.ino === this.#ino) fs.rmSync(this.sock, { force: true })
  }

  /** Closes every connection, forward and the socket, and exits with `code`. */
  end(code: number): void {
    if (this.#ending) return
    this.#ending = true
    this.#unlink()
    fs.rmSync(path.join(this.state, "masters", String(process.pid)), { force: true })
    this.#server.close()
    for (const server of this.#forwards) server.close()
    for (const c of [...this.#open, ...this.#others, ...this.hops]) c.destroy()
    process.exit(code)
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  process.exit(await new Run(args[0]!, args.slice(1)).main())
}

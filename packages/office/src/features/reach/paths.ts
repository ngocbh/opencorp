/** The hq folder, `<home>/hq`: a folder per saved destination, `hq/<name>/`, holding its path and its ssh files; the
 *  learning model's sign-in, which every destination shares; each destination's control-socket folder; and the limits
 *  SSH puts on the home's path. */
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { checkFolder, makePrivateFolder } from "../../util/private_files.ts"
import { safePath } from "./spec.ts"

/** A destination's name, as `opencorp hq <name>` takes it. */
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
/** A learning run's temporary folder, before its path is saved under a name. */
const TEMP = /^\.new-[0-9a-f]{6}$/
/** A control-socket folder's id. */
const CM_ID = /^[0-9a-f]{6}$/
/** The words a name can't be: hq's own folders and files (the sessions' records, and what the old single-path layout
 *  left), and words that could read as a command. A control-socket folder's name is reserved too. */
const RESERVED = ["check", "cm", "forget", "help", "here", "json", "list", "local", "lock", "relearn", "rename", "sessions", "ssh"]

/** The name rule, as the usage says it. */
export const NAME_RULE = "a name is 1 to 32 lowercase letters, digits and dashes, starting with a letter or a digit"

/** Why `name` can't name a destination, or null. */
export function nameProblem(name: string): string | null {
  if (!NAME.test(name)) return `${JSON.stringify(name)} isn't a destination's name: ${NAME_RULE}`
  if (RESERVED.includes(name) || /^cm-[0-9a-f]{6}$/.test(name))
    return `${JSON.stringify(name)} is reserved: a name can't be cm-<6 hex digits> or one of ${RESERVED.join(", ")}`
  return null
}

/** A fresh name for a learning run's temporary folder: `.new-<6 random hex>`. */
export const tempName = () => `.new-${randomBytes(3).toString("hex")}`

/** Whether `name` is a learning run's temporary folder's. */
export const isTemp = (name: string) => TEMP.test(name)

/** How many ids `claimCm` draws before it gives up. */
const CLAIM_TRIES = 1000

/** Claims a fresh control-socket folder in `root`, the hq folder: draws a random id that `recorded` (the ids the
 *  destinations' folders record) doesn't hold, and makes `cm-<id>` (0700) with an exclusive mkdir, so no other
 *  folder, link or concurrent claim has it; resolves to the id. `random` is the draw: tests pass their own. Throws
 *  after `CLAIM_TRIES` draws. */
export function claimCm(
  root: string,
  recorded: ReadonlySet<string>,
  random: () => string = () => randomBytes(3).toString("hex"),
): string {
  for (let i = 0; i < CLAIM_TRIES; i++) {
    const id = random()
    if (!CM_ID.test(id) || recorded.has(id)) continue
    const dir = path.join(root, `cm-${id}`)
    try {
      fs.mkdirSync(dir, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      throw error
    }
    fs.chmodSync(dir, 0o700) // the umask may have narrowed it
    return id
  }
  throw new Error(`there's no free control-socket folder in ${root}`)
}

/** Whether `paths`' control-socket folder is one OpenCorp may end masters in and delete from: its id is known, and
 *  it's a real folder (no link), this user's, 0700, straight in hq. */
export function isOwnCm(paths: ReachPaths): boolean {
  if (paths.cmId === null || path.dirname(paths.cm) !== paths.root) return false
  try {
    checkFolder(paths.cm, "control-socket folder")
    return true
  } catch {
    return false
  }
}

/** The files of destination `name`, `<home>/hq/<name>`, and of what destinations share in `<home>/hq`. `cmId` names
 *  its control-socket folder, `hq/cm-<cmId>`, once known (`withCm`). */
export class ReachPaths {
  /** `<home>/hq`. */
  readonly root: string
  /** The destination's folder, `<home>/hq/<name>`. */
  readonly dir: string

  /** Throws when `name` is neither a name nor a temporary folder's, or `cmId` isn't 6 hex digits. */
  constructor(
    readonly home: string,
    readonly name: string,
    readonly cmId: string | null = null,
  ) {
    if (!NAME.test(name) && !TEMP.test(name)) throw new Error(`a destination's folder is one plain name: ${JSON.stringify(name)}`)
    if (cmId !== null && !CM_ID.test(cmId)) throw new Error(`a control-socket folder's id is 6 hex digits: ${JSON.stringify(cmId)}`)
    this.root = path.join(home, "hq")
    this.dir = path.join(this.root, name)
  }

  /** These paths, with control-socket folder `id`. */
  withCm(id: string): ReachPaths {
    return new ReachPaths(this.home, this.name, id)
  }

  /** These paths for the destination now called `name`: the folder renamed, the socket folder the same. */
  renamed(name: string): ReachPaths {
    return new ReachPaths(this.home, name, this.cmId)
  }

  /** How the owner runs `opencorp hq` for this destination: with its name, but a temporary folder's has none yet. */
  get command(): string {
    return isTemp(this.name) ? "opencorp hq" : `opencorp hq ${this.name}`
  }

  /** The script that prints the connection spec. */
  get script(): string {
    return path.join(this.dir, "reach.sh")
  }
  /** The approved copy of `reach.sh`, to diff a changed one against. */
  get approved(): string {
    return path.join(this.dir, "reach.approved.sh")
  }
  /** A learning run's script, before it's saved. */
  get candidate(): string {
    return path.join(this.dir, "reach.new.sh")
  }
  get notes(): string {
    return path.join(this.dir, "notes.md")
  }
  get access(): string {
    return path.join(this.dir, "access.json")
  }
  /** The learning model's connection, which every destination shares. */
  get provider(): string {
    return path.join(this.root, "provider.json")
  }
  /** The ChatGPT subscription's sign-in when `provider` is one: yian's own auth store. Shared, as `provider` is. */
  get auth(): string {
    return path.join(this.root, "auth.json")
  }
  /** The generated configs, the wrapper and the exit-status files. */
  get ssh(): string {
    return path.join(this.dir, "ssh")
  }
  get config(): string {
    return path.join(this.ssh, "config")
  }
  get batchConfig(): string {
    return path.join(this.ssh, "config.batch")
  }
  /** The config the agent's ssh reads while learning: the user's own, and never a master of its own. */
  get agentConfig(): string {
    return path.join(this.ssh, "agent.config")
  }
  get bin(): string {
    return path.join(this.ssh, "bin")
  }
  get wrapper(): string {
    return path.join(this.bin, "ssh")
  }
  /** The wrapper the agent's sandbox mounts over the system's ssh on Linux, which runs the real ssh at `REAL_SSH`. */
  get agentWrapper(): string {
    return path.join(this.ssh, "agent-ssh")
  }
  /** The exit statuses the wrapper records for the process `pid`'s children. */
  status(pid: number): string {
    return path.join(this.ssh, `status.${pid}`)
  }
  /** The status file the agent's shells may write while process `pid` learns: never `status(pid)`, which the visit's
   *  replays read. */
  agentStatus(pid: number): string {
    return path.join(this.ssh, `agent-status.${pid}`)
  }
  /** The control sockets of every master of this destination's visits: `hq/cm-<id>`, short and not built from the
   *  name, so a socket's path fits macOS's limit whatever the name. Throws before the id is known. */
  get cm(): string {
    if (this.cmId === null) throw new Error(`${this.dir} has no control-socket folder yet`)
    return path.join(this.root, `cm-${this.cmId}`)
  }
  /** The control socket of the master to HQ's machine. */
  get node(): string {
    return path.join(this.cm, "node")
  }
  /** The id of its control-socket folder, recorded when the folder is made (`claimCm`); access.json records it too
   *  once there's one. */
  get cmRecord(): string {
    return path.join(this.dir, "cm.id")
  }
  /** A learning run's port, held for it while it learns (`reservePort`), before access.json records one. */
  get portRecord(): string {
    return path.join(this.dir, "port")
  }
  /** One `opencorp hq` at a time for this destination. */
  get lock(): string {
    return path.join(this.dir, "lock")
  }
  /** The learning sessions' folders, which every destination shares: a learning run's folder is renamed when its
   *  path is saved, and its session's records stay where they are. */
  get sessions(): string {
    return path.join(this.root, "sessions")
  }
  /** Session `id`'s folder: its shells' records. Throws when `id` isn't one plain name. */
  session(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`a session's id is one plain name: ${JSON.stringify(id)}`)
    return path.join(this.sessions, id)
  }
}

/** Makes `hq/`, the destination's folder, its `ssh/` and `ssh/bin/`, and its control-socket folder once its id is
 *  known, each 0700 where missing; throws `PrivateFileError` when one is open to others, isn't a directory or isn't
 *  this user's. */
export function makeDirs(paths: ReachPaths): void {
  const dirs = [paths.root, paths.dir, paths.ssh, paths.bin, ...(paths.cmId === null ? [] : [paths.cm])]
  for (const dir of dirs) {
    makePrivateFolder(dir)
    checkFolder(dir, "folder")
  }
}

/** macOS's sun_path is 104 bytes with its NUL (Linux's 108): the smaller holds everywhere. */
export const SOCKET_PATH_MAX = 103
/** While binding, ssh names a control socket `<ControlPath>.<16 random characters>`. */
export const BIND_SUFFIX = 17
/** `%C`: 40 hex digits, the shortest per-host name ssh's ControlPath has. */
export const HASH_CHARS = 40
/** The longest home whose `hq/cm-<6 hex>/%C` still binds: 32 bytes. */
export const MAX_HOME_BYTES = SOCKET_PATH_MAX - BIND_SUFFIX - HASH_CHARS - "/hq/cm-000000/".length

/** Why SSH can't work under this home, or null: ProxyJump's hop holds the config's path unquoted in a shell command,
 *  and a control socket's path must fit sun_path. A destination's name is in neither limit's way: names are plain,
 *  and no socket's path holds one. */
export function pathProblem(paths: ReachPaths): string | null {
  if (!safePath(paths.dir))
    return `opencorp hq: OPENCORP_HOME is ${paths.home}, but ssh's jump-host command takes its paths unquoted; set OPENCORP_HOME to a folder whose path has only letters, digits and . _ + - /`
  const bytes = Buffer.byteLength(paths.home)
  if (bytes > MAX_HOME_BYTES)
    return `opencorp hq: OPENCORP_HOME is ${paths.home} (${bytes} bytes), but SSH's control sockets under it need at most ${MAX_HOME_BYTES} (macOS caps a socket's path at 104 bytes); set OPENCORP_HOME to a shorter folder`
  return null
}

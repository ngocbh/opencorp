/** The saved path's folder, `<home>/hq`: where each of its files lives, and the limits SSH puts on the home's path. */
import path from "node:path"
import { checkFolder, makePrivateFolder } from "../secrets.ts"
import { safePath } from "./spec.ts"

/** The files of `<home>/hq`. */
export class ReachPaths {
  readonly dir: string

  constructor(readonly home: string) {
    this.dir = path.join(home, "hq")
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
  get provider(): string {
    return path.join(this.dir, "provider.json")
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
  get bin(): string {
    return path.join(this.ssh, "bin")
  }
  get wrapper(): string {
    return path.join(this.bin, "ssh")
  }
  /** The exit statuses the wrapper records for the process `pid`'s children. */
  status(pid: number): string {
    return path.join(this.ssh, `status.${pid}`)
  }
  /** The control sockets of every master. */
  get cm(): string {
    return path.join(this.dir, "cm")
  }
  /** The control socket of the master to HQ's machine. */
  get node(): string {
    return path.join(this.cm, "node")
  }
  /** One `opencorp hq` at a time. */
  get lock(): string {
    return path.join(this.dir, "lock")
  }
}

/** Makes `hq/`, `hq/ssh/`, `hq/ssh/bin/` and `hq/cm/` 0700 where missing; throws `PrivateFileError` when one is
 *  open to others, isn't a directory or isn't this user's. */
export function makeDirs(paths: ReachPaths): void {
  for (const dir of [paths.dir, paths.ssh, paths.bin, paths.cm]) {
    makePrivateFolder(dir)
    checkFolder(dir, "folder")
  }
}

/** macOS's sun_path is 104 bytes with its NUL (Linux's 108): the smaller holds everywhere. */
export const SOCKET_PATH_MAX = 103
/** While binding, ssh names a control socket `<ControlPath>.<16 random characters>`. */
export const BIND_SUFFIX = 17
/** `%C`: 40 hex digits. */
export const HASH_CHARS = 40
/** The longest home whose `hq/cm/%C` still binds: 39 bytes. */
export const MAX_HOME_BYTES = SOCKET_PATH_MAX - BIND_SUFFIX - HASH_CHARS - "/hq/cm/".length

/** Why SSH can't work under this home, or null: ProxyJump's hop holds the config's path unquoted in a shell command,
 *  and a control socket's path must fit sun_path. */
export function pathProblem(paths: ReachPaths): string | null {
  if (!safePath(paths.dir))
    return `opencorp hq: OPENCORP_HOME is ${paths.home}, but ssh's jump-host command takes its paths unquoted; set OPENCORP_HOME to a folder whose path has only letters, digits and . _ + - /`
  const bytes = Buffer.byteLength(paths.home)
  if (bytes > MAX_HOME_BYTES)
    return `opencorp hq: OPENCORP_HOME is ${paths.home} (${bytes} bytes), but SSH's control sockets under it need at most ${MAX_HOME_BYTES} (macOS caps a socket's path at 104 bytes); set OPENCORP_HOME to a shorter folder`
  return null
}

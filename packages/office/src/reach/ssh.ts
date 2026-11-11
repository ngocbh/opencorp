/** The SSH plumbing of reaching a remote HQ: the generated configs and the ssh wrapper, the child runner, the node
 *  master and its lifeline, mux sessions and `-O` commands, and the watcher that ends every master once this process
 *  is gone. */
import fs from "node:fs"
import path from "node:path"
import { replaceFile, writePrivate } from "../secrets.ts"
import type { ReachPaths } from "./paths.ts"
import { safePath, word } from "./spec.ts"

/** The owner's config, then the system's, which `-F` skips. `home` is the passwd entry's (`os.userInfo().homedir`),
 *  where ssh's own `~` points; only `realVisitDeps` calls this. */
export const defaultIncludes = (home: string) => [path.join(home, ".ssh", "config"), "/etc/ssh/ssh_config"]

/** `hq/ssh/config` (`config.batch` with `batch`): our options first, since ssh keeps the first value it reads, so the
 *  owner's ControlPath can't win and our `-O exit` never ends their masters. Each include is double-quoted (a home
 *  may hold a space); there's no default, so a test can't include the real `~/.ssh/config` by leaving it out. */
export function configText(cm: string, { batch = false, includes }: { batch?: boolean; includes: readonly string[] }): string {
  if (includes.some((file) => /["\n]/.test(file))) throw new Error("an included ssh config's path can't hold \" or a newline")
  return [
    "# Written by opencorp hq on each visit; edits are lost.",
    ...(batch ? ["BatchMode yes"] : []),
    "ControlMaster auto",
    `ControlPath ${cm}/%C`,
    "ControlPersist 60",
    "ServerAliveInterval 15",
    "ServerAliveCountMax 3",
    ...includes.map((file) => `Include "${file}"`),
    "",
  ].join("\n")
}

/** `hq/ssh/bin/ssh`, first on PATH for reach.sh and the shell tool: the real ssh by absolute path (so ProxyJump's hop,
 *  built from argv0 and `-F`, shares the config) with our config; each exit status is appended to $OPENCORP_SSH_STATUS,
 *  so a 255 counts where a pipeline or `|| true` hides it. */
export function wrapperText(realSsh: string): string {
  // The hop's command holds argv0 unquoted.
  if (!safePath(realSsh)) throw new Error(`ssh's path can't be used unquoted: ${realSsh}`)
  return [
    "#!/bin/sh",
    "# Written by opencorp hq on each visit.",
    `${word(realSsh)} -F "$OPENCORP_SSH_CONFIG" "$@"`,
    "status=$?",
    // Single-quoted TS strings: `${…-}` is sh, not a template.
    'if [ -n "${OPENCORP_SSH_STATUS-}" ]; then printf \'%s\\n\' "$status" >>"$OPENCORP_SSH_STATUS"; fi',
    'exit "$status"',
    "",
  ].join("\n")
}

/** Writes both configs (0600) and the wrapper (0700) for this visit. */
export async function writeSshFiles(paths: ReachPaths, realSsh: string, includes: readonly string[]): Promise<void> {
  await writePrivate(paths.config, configText(paths.cm, { includes }))
  await writePrivate(paths.batchConfig, configText(paths.cm, { batch: true, includes }))
  await writePrivate(paths.wrapper, wrapperText(realSsh))
  fs.chmodSync(paths.wrapper, 0o700)
}

/** The first executable `ssh` in an absolute entry of `pathVar` other than the folder `skip` (our wrapper's), or
 *  null. */
export function findSsh(pathVar: string | undefined, skip: string): string | null {
  const ours = realOrSelf(skip)
  for (const entry of (pathVar ?? "").split(":")) {
    if (!path.isAbsolute(entry) || realOrSelf(entry) === ours) continue
    const file = path.join(entry, "ssh")
    try {
      if (!fs.statSync(file).isFile()) continue
      fs.accessSync(file, fs.constants.X_OK)
    } catch {
      continue
    }
    return file
  }
  return null
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** A step that can prompt (Duo, a password, a host key) gets 5 minutes; one over an open master 60 s. */
export const LIMITS = Object.freeze({ promptMs: 5 * 60_000, stepMs: 60_000 })

/** What every reach step needs; `signal` is the visit's Ctrl-C. */
export interface ReachContext {
  readonly paths: ReachPaths
  /** The real ssh, by absolute path. */
  readonly ssh: string
  /** The environment the visit was started with; children get only `sshEnv`'s part of it. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether to use `config.batch`, so a login that would prompt fails at once. */
  readonly batch: boolean
  /** Children's output for the owner. */
  readonly echo: (text: string) => void
  readonly signal?: AbortSignal
  readonly limits: { readonly promptMs: number; readonly stepMs: number }
}

/** The env of reach.sh, the shell tool and every ssh: our wrapper first on PATH, HOME, the agent socket, and the
 *  config and status file the wrapper reads. Nothing else of the visit's env. */
export function sshEnv(ctx: ReachContext): Record<string, string> {
  const { paths, env } = ctx
  return {
    PATH: `${paths.bin}:${env.PATH || "/usr/bin:/bin"}`,
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(env.SSH_AUTH_SOCK !== undefined ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}),
    OPENCORP_SSH_CONFIG: ctx.batch ? paths.batchConfig : paths.config,
    OPENCORP_SSH_STATUS: paths.status(process.pid),
  }
}

/** Empties this process's status file (0600), before a run whose ssh exits are read after. */
export function resetStatus(ctx: ReachContext): void {
  replaceFile(ctx.paths.ssh, path.basename(ctx.paths.status(process.pid)), "")
}

/** The exit statuses the wrapper recorded since `resetStatus`, in order. */
export function readStatuses(ctx: ReachContext): number[] {
  let text: string
  try {
    text = fs.readFileSync(ctx.paths.status(process.pid), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return text
    .split("\n")
    .filter((line) => /^[0-9]+$/.test(line.trim()))
    .map((line) => Number(line.trim()))
}

/** `text` without control characters other than tab and newline: output from another machine must not drive the
 *  owner's terminal. */
export const cleanOutput = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")

/** The SSH plumbing of reaching a remote HQ: the generated configs and the ssh wrapper, the child runner, the node
 *  master and its lifeline, mux sessions and `-O` commands, and the watcher that ends every master once this process
 *  is gone. */
import fs from "node:fs"
import path from "node:path"
import { writePrivate } from "../secrets.ts"
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

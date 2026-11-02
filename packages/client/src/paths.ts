import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** The OpenCorp home: `$OPENCORP_HOME`, default `~/.opencorp`. */
export function opencorpHome() {
  // Empty is unset and a leading `~` is expanded, as the office's install commands read it.
  const home = process.env.OPENCORP_HOME || path.join(os.homedir(), ".opencorp")
  return home === "~" || home.startsWith("~/") ? path.join(os.homedir(), home.slice(1)) : home
}

/** The office socket: `$OPENCORP_HOME/office/office.sock` (default `~/.opencorp/office/office.sock`). */
export function defaultSocket() {
  return path.join(opencorpHome(), "office", "office.sock")
}

/** This device's identity file: `$OPENCORP_HOME/identity.json` (default `~/.opencorp/identity.json`). */
export function identityPath() {
  return path.join(opencorpHome(), "identity.json")
}

/**
 * Why the socket at `socket` can't be reached, for a message; undefined when there's no socket (the office isn't
 * running). It looks after a failed connection, so an office that restarted in between can make it wrong.
 */
export function socketProblem(socket: string): string | undefined {
  let stat: fs.Stats
  try {
    stat = fs.statSync(socket)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    if (code === "EACCES" || code === "EPERM") return `permission denied on ${socket}`
    return `${socket} can't be read (${code})`
  }
  if (!stat.isSocket()) return `${socket} isn't a socket`
  // Connecting needs write permission on the socket, which stat doesn't.
  try {
    fs.accessSync(socket, fs.constants.W_OK)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // EPERM: a sandbox or an ACL refused, which the mode bits don't show.
    if (code === "EACCES" || code === "EPERM") return `permission denied on ${socket}`
  }
  return `nothing answers on ${socket}; the office may have stopped or crashed`
}

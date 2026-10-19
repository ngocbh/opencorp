import os from "node:os"
import path from "node:path"

/** The OpenCorp home: `$OPENCORP_HOME`, default `~/.opencorp`. */
export function opencorpHome() {
  // Read as Python's install commands read it: empty is unset, and a leading `~` is expanded.
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

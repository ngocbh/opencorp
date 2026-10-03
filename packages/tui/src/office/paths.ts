import os from "node:os"
import path from "node:path"

/** The agent-corp home: `$AGENT_CORP_HOME`, default `~/.agent-corp`. */
export function agentCorpHome() {
  // Read as Python's install commands read it: empty is unset, and a leading `~` is expanded.
  const home = process.env.AGENT_CORP_HOME || path.join(os.homedir(), ".agent-corp")
  return home === "~" || home.startsWith("~/") ? path.join(os.homedir(), home.slice(1)) : home
}

/** The office socket: `$AGENT_CORP_HOME/office/office.sock` (default `~/.agent-corp/office/office.sock`). */
export function defaultSocket() {
  return path.join(agentCorpHome(), "office", "office.sock")
}

/** This device's identity file: `$AGENT_CORP_HOME/identity.json` (default `~/.agent-corp/identity.json`). */
export function identityPath() {
  return path.join(agentCorpHome(), "identity.json")
}

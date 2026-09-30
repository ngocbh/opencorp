import os from "node:os"
import path from "node:path"

/** The office socket: `$AGENT_CORP_HOME/office/office.sock` (default `~/.agent-corp/office/office.sock`). */
export function defaultSocket() {
  return path.join(process.env.AGENT_CORP_HOME ?? path.join(os.homedir(), ".agent-corp"), "office", "office.sock")
}

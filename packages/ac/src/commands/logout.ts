// `ac logout`: takes this device off the office's list, then forgets its identity.
import { createOfficeClient } from "@agent-corp/tui/office/client"
import { OfficeError, OfficeUnavailable, UnknownDevice } from "@agent-corp/tui/office/errors"
import { readIdentity, type Identity } from "@agent-corp/tui/office/identity"
import { defaultSocket, identityPath } from "@agent-corp/tui/office/paths"
import fs from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"

/**
 * `ac logout`: removes this device from its person's devices, sent with its own token, then
 * deletes `identity.json`. With no office, deletes it anyway and says the entry remains.
 */
export const run: CommandRun = async (argv) => {
  try {
    parseArgs({ args: argv, options: {} })
  } catch (e) {
    console.error(`ac logout: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const file = identityPath()
  let me: Identity | undefined
  try {
    me = readIdentity(file, (m) => console.error(`ac: ${m}`))
  } catch {
    // Nothing in it can be used to reach the office.
    fs.rmSync(file, { force: true })
    console.log(`Removed ${file}, which couldn't be read.`)
    return 0
  }
  if (!me) {
    console.error("ac logout: this device isn't logged in")
    return 1
  }
  const entry = `${me.device} in people/${me.handle}/person.yaml`
  let note: string
  try {
    await createOfficeClient({ socket: defaultSocket(), token: me.token }).devices.remove(me.handle, me.device)
    note = `Removed ${entry}.`
  } catch (e) {
    if (e instanceof OfficeUnavailable)
      note = `The office isn't running, so ${entry} remains; remove it with \`ac devices remove ${me.handle} ${me.device}\`.`
    // The office no longer lists the token, so there is nothing to remove.
    else if (e instanceof UnknownDevice) note = "The office didn't know this device."
    else if (e instanceof OfficeError && e.code === "not_found") note = `${entry} was already gone.`
    else {
      console.error(`ac logout: ${e instanceof Error ? e.message : e}`)
      return 1
    }
  }
  fs.rmSync(file, { force: true })
  console.log(`${note} This device is logged out.`)
  return 0
}

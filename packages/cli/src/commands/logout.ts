// `opencorp logout`: takes this device off the office's list, then forgets its identity.
import { createOfficeClient } from "@opencorp/tui/office/client"
import { OfficeError, OfficeUnavailable, UnknownDevice } from "@opencorp/tui/office/errors"
import { readIdentity, type Identity } from "@opencorp/tui/office/identity"
import { defaultSocket, identityPath } from "@opencorp/tui/office/paths"
import fs from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"

/**
 * `opencorp logout`: removes this device from its person's devices, sent with its own token, then
 * deletes `identity.json`. With no office, deletes it anyway and says the entry remains.
 */
export const run: CommandRun = async (argv) => {
  try {
    parseArgs({ args: argv, options: {} })
  } catch (e) {
    console.error(`opencorp logout: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const file = identityPath()
  let me: Identity | undefined
  try {
    me = readIdentity(file, (m) => console.error(`opencorp: ${m}`))
  } catch {
    // Nothing in it can be used to reach the office.
    fs.rmSync(file, { force: true })
    console.log(`Removed ${file}, which couldn't be read.`)
    return 0
  }
  if (!me) {
    console.error("opencorp logout: this device isn't logged in")
    return 1
  }
  const entry = `${me.device} in people/${me.handle}/person.yaml`
  let note: string
  try {
    await createOfficeClient({ socket: defaultSocket(), token: me.token }).devices.remove(me.handle, me.device)
    note = `Removed ${entry}.`
  } catch (e) {
    if (e instanceof OfficeUnavailable)
      note = `The office isn't running, so ${entry} remains; remove it with \`opencorp devices remove ${me.handle} ${me.device}\`.`
    // The office no longer lists the token, so there is nothing to remove.
    else if (e instanceof UnknownDevice) note = "The office didn't know this device."
    else if (e instanceof OfficeError && e.code === "not_found") note = `${entry} was already gone.`
    else {
      console.error(`opencorp logout: ${e instanceof Error ? e.message : e}`)
      return 1
    }
  }
  fs.rmSync(file, { force: true })
  console.log(`${note} This device is logged out.`)
  return 0
}

// `opencorp logout`: takes this device off the office's list, then forgets its identity.
import { createOfficeClient, OfficeDropped, OfficeError, OfficeUnavailable, UnknownDevice } from "@opencorp/client"
import { readIdentity, UnusableToken, type Identity, defaultSocket, identityPath } from "@opencorp/client/node"
import fs from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { unreachableReason, warnIfTokenless } from "../office"

const USAGE = "usage: opencorp logout"

/**
 * `opencorp logout`: removes this device from its person's devices, sent with its own token, then
 * deletes `identity.json`. With no office, deletes it anyway and says the entry remains.
 */
export const run: CommandRun = async (argv) => {
  try {
    if (parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" } } }).values.help) {
      console.log(USAGE)
      return 0
    }
  } catch (e) {
    console.error(`opencorp logout: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const file = identityPath()
  let me: Identity | undefined
  try {
    me = readIdentity(file, (m) => console.error(`opencorp: ${m}`))
  } catch (e) {
    // Nothing in it can be used to reach the office.
    fs.rmSync(file, { force: true })
    // A token that can't be sent still names its entry (readIdentity checked the handle and device).
    if (e instanceof UnusableToken)
      console.log(
        `Removed ${file}, which couldn't be read; ${e.device} in people/${e.handle}/person.yaml remains; ` +
          `remove it with \`opencorp devices remove ${e.handle} ${e.device}\`.`,
      )
    // Its token may still be listed, so the device may be too, under a name the file doesn't give.
    else
      console.log(
        `Removed ${file}, which couldn't be read; the office may still list this device: ` +
          "check with `opencorp devices list`.",
      )
    return 0
  }
  if (!me) {
    console.error("opencorp logout: this device isn't logged in")
    return 1
  }
  const entry = `${me.device} in people/${me.handle}/person.yaml`
  let note: string
  let removed = false
  try {
    await createOfficeClient({ socket: defaultSocket(), token: me.token }).devices.remove(me.handle, me.device)
    note = `Removed ${entry}.`
    removed = true
  } catch (e) {
    const remove = `remove it with \`opencorp devices remove ${me.handle} ${me.device}\``
    if (e instanceof OfficeDropped)
      note =
        `The office dropped the connection, so ${entry} may remain; ` +
        `check with \`opencorp devices list\` and ${remove}.`
    else if (e instanceof OfficeUnavailable) {
      const reason = unreachableReason(e)
      note =
        reason === undefined
          ? `The office isn't running, so ${entry} remains; ${remove}.`
          : `The office can't be reached (${reason}), so ${entry} remains; ${remove}.`
    }
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
  if (removed) await warnIfTokenless()
  return 0
}

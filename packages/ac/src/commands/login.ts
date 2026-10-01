// `ac login`: gives this device its own token and asks the office to list it for a person.
import type { Person } from "@agent-corp/protocol"
import { createOfficeClient } from "@agent-corp/tui/office/client"
import { OfficeError, UnknownDevice } from "@agent-corp/tui/office/errors"
import { DEVICE_NAME, deviceName, newToken, tokenSha256, writeIdentity } from "@agent-corp/tui/office/identity"
import { defaultSocket, identityPath } from "@agent-corp/tui/office/paths"
import fs from "node:fs"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { localIdentity, officeAnswers, officeNotRunning } from "../office"

/** The company's CEO among `people`: the human with no manager. */
export const ceoOf = (people: Person[]) => people.find((p) => p.kind === "human" && !p.manager)?.handle

/**
 * `ac login [--handle H] [--device NAME] [--force]`: makes a token, writes this device's identity,
 * then adds the device to H's devices. The device defaults to this host's short name and H to
 * the CEO. When the office won't take it from an unknown device, prints the `ac devices add` to
 * run on a device it trusts.
 */
export const run: CommandRun = async (argv) => {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: { handle: { type: "string" }, device: { type: "string" }, force: { type: "boolean" } },
    }))
  } catch (e) {
    console.error(`ac login: ${e instanceof Error ? e.message : e}`)
    return 2
  }
  const file = identityPath()
  const device = values.device ?? deviceName()
  if (!DEVICE_NAME.test(device)) {
    console.error("ac login: --device takes lowercase letters, digits, '.', '_' and '-', starting with a letter or digit")
    return 2
  }
  if (fs.existsSync(file) && !values.force) {
    console.error(`ac login: this device already has an identity (${file}); pass --force to replace it`)
    return 1
  }
  const socket = defaultSocket()
  // Checked before anything is written, so no office leaves no half-made identity.
  if (!(await officeAnswers(socket))) return officeNotRunning()
  // The identity being replaced may still be trusted, which lets the office take the new device
  // even once it requires a token.
  const office = createOfficeClient({ socket, token: values.force ? localIdentity()?.token : undefined })
  let handle = values.handle
  if (handle === undefined) {
    try {
      handle = ceoOf(await office.people.list())
    } catch (e) {
      if (!(e instanceof UnknownDevice)) return failed(e)
    }
    if (handle === undefined) {
      console.error("ac login: the office won't list its people to this device; pass --handle")
      return 2
    }
  }
  const token = newToken()
  const hash = tokenSha256(token)
  // The identity is written only once the office takes the device or says to vouch for it from
  // a trusted one, so a refused `--force` keeps the identity it would have replaced.
  const save = () => {
    try {
      writeIdentity(file, { handle, device, token })
      return true
    } catch (e) {
      console.error(`ac login: couldn't write ${file}: ${e instanceof Error ? e.message : e}`)
      return false
    }
  }
  try {
    await office.devices.add(handle, { name: device, token_sha256: hash })
  } catch (e) {
    if (e instanceof OfficeError && (e.status === 401 || e.status === 403)) {
      if (!save()) return 1
      console.error(`ac login: the office doesn't trust this device yet. On a device it trusts, run:`)
      console.error(`  ac devices add ${handle} ${device} ${hash}`)
      return 1
    }
    if (e instanceof OfficeError && e.code === "device_exists") {
      console.error(
        `ac login: @${handle} already has a device named ${device}; remove it (\`ac devices remove ${handle} ${device}\`) or pick another --device`,
      )
      return 1
    }
    return failed(e)
  }
  if (!save()) return 1
  console.log(`This device is ${device}, acting as @${handle}; its token is in ${file}.`)
  return 0
}

function failed(e: unknown) {
  console.error(`ac login: ${e instanceof Error ? e.message : e}`)
  return 1
}

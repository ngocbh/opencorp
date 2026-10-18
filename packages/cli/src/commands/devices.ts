// `opencorp devices`: the devices a human uses opencorp from, as their person.yaml lists them.
import { OfficeUnavailable } from "@opencorp/tui/office/errors"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { localIdentity, officeClient, officeNotRunning } from "../office"

class Usage extends Error {}

const USAGE = "usage: opencorp devices list [HANDLE] [--hashes] | add HANDLE NAME SHA256 | remove HANDLE NAME"

/**
 * `opencorp devices list [H] [--hashes]`: H's device names (this device's person by default), with
 * their token hashes only on `--hashes`. `opencorp devices add H NAME SHA256` and `opencorp devices remove
 * H NAME` change H's list.
 */
export const run: CommandRun = async (argv) => {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { hashes: { type: "boolean" } },
    })
    const [sub, ...rest] = positionals
    const me = localIdentity()
    const office = officeClient(me)
    if (sub === "list" && rest.length <= 1) {
      const handle = rest[0] ?? (await office.whoami()).person
      const person = (await office.people.list()).find((p) => p.handle === handle)
      if (!person) throw new Error(`no person @${handle}`)
      const devices = person.devices ?? []
      if (!devices.length) console.log(`@${handle} has no devices.`)
      for (const d of devices) {
        const mine = me?.handle === handle && me.device === d.name ? "  (this device)" : ""
        console.log(values.hashes ? `${d.name}  ${d.token_sha256}${mine}` : `${d.name}${mine}`)
      }
      return 0
    }
    if (values.hashes) throw new Usage("--hashes goes with list")
    if (sub === "add" && rest.length === 3) {
      const [handle, name, sha256] = rest
      await office.devices.add(handle, { name, token_sha256: sha256 })
      console.log(`@${handle} has device ${name}.`)
      return 0
    }
    if (sub === "remove" && rest.length === 2) {
      const [handle, name] = rest
      await office.devices.remove(handle, name)
      console.log(`Removed device ${name} from @${handle}.`)
      return 0
    }
    throw new Usage(USAGE)
  } catch (e) {
    if (e instanceof OfficeUnavailable) return officeNotRunning()
    console.error(`opencorp devices: ${e instanceof Error ? e.message : e}`)
    return e instanceof Usage || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1
  }
}

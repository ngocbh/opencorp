// `opencorp devices`: the devices a human uses opencorp from, as their person.yaml lists them.
// `opencorp devices remove-browser ID-OR-NAME` signs one of this office's browsers out. It's a separate verb because
// browser names and person.yaml device names are different namespaces.
import { isMissingRoute, isNotImplemented, OfficeError, OfficeUnavailable, type OfficeClient } from "@opencorp/client"
import type { BrowserSession, Person } from "@opencorp/protocol"
import { parseArgs } from "node:util"
import type { CommandRun } from "../main"
import { localIdentity, officeClient, officeNotRunning } from "../office"

class Usage extends Error {}

const USAGE = "usage: opencorp devices list [HANDLE] [--hashes] | add HANDLE NAME SHA256 | remove HANDLE NAME | remove-browser ID-OR-NAME"

const day = (ts: string) => new Date(ts).toLocaleDateString()

/**
 * This office's browser sessions for `person`, or none when there's nothing the asker may see: agents have none,
 * and someone else's (403), an unknown person (404), an agent (422), an office without HQ (501) or from before it
 * (no_route) leave the section out, so `devices list` reads as it did before.
 */
async function browsersOf(office: OfficeClient, person: Person): Promise<BrowserSession[]> {
  if (person.kind !== "human") return []
  try {
    return await office.hq.browsers(person.handle)
  } catch (e) {
    if (isMissingRoute(e) || isNotImplemented(e) || (e instanceof OfficeError && [403, 404, 422].includes(e.status)))
      return []
    throw e
  }
}

/** The "Browsers (this office)" section; nothing when there are none. */
function browserLines(browsers: BrowserSession[]): string[] {
  if (!browsers.length) return []
  // Office-local, and named in their own namespace, apart from person.yaml's devices.
  return [
    "Browsers (this office):",
    ...browsers.map(
      (b) =>
        `  ${b.id}  ${b.name}${b.label ? ` (${b.label})` : ""}  paired by @${b.issued_by}  ` +
        `last used ${b.last_used_at ? day(b.last_used_at) : "never"}  ` +
        // The office keeps an expired session until its next cleanup.
        `${Date.parse(b.expires_at) <= Date.now() ? "expired" : "expires"} ${day(b.expires_at)}`,
    ),
  ]
}

/**
 * `opencorp devices list [H] [--hashes]`: H's device names (this device's person by default), with
 * their token hashes only on `--hashes`. `list` also shows this office's browser sessions, when there are any you
 * may see. `opencorp devices add H NAME SHA256` and `opencorp devices remove H NAME` change H's list;
 * `opencorp devices remove-browser ID-OR-NAME` signs one of this office's browsers out (by name, only your own).
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
      for (const line of browserLines(await browsersOf(office, person))) console.log(line)
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
    if (sub === "remove-browser" && rest.length === 1) {
      const [given] = rest
      // One of the asker's own sessions may be given by its web-xxxxxx name, and is confirmed by it; anyone else's
      // (the CEO's case) by its id.
      const own = (await office.hq.browsers().catch(() => [])).find((b) => b.id === given || b.name === given)
      const name = own?.name ?? given
      try {
        await office.hq.removeBrowser(own?.id ?? given)
      } catch (e) {
        if (isMissingRoute(e) || isNotImplemented(e))
          throw new Error("this office has no HQ yet; update the checkout and run `opencorp restart`")
        throw e
      }
      console.log(`Signed out browser ${name}.`)
      return 0
    }
    throw new Usage(USAGE)
  } catch (e) {
    if (e instanceof OfficeUnavailable) return officeNotRunning()
    console.error(`opencorp devices: ${e instanceof Error ? e.message : e}`)
    return e instanceof Usage || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1
  }
}

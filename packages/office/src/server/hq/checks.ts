/** HQ's lines for `opencorp doctor`: where HQ listens, whether the web app is built for this office, HQ's own
 *  warnings, and `GET /hq` to read them. The setup commands pass them to doctor's `checks`. */
import fs from "node:fs"
import path from "node:path"
import type { HqStatus } from "@opencorp/protocol"
import { VERSION } from "@opencorp/protocol/version"
import type { Identity } from "../../runtime/auth/identity.ts"
import { otherPort } from "./config.ts"
import { RETRY_MS } from "./servers.ts"
import type { Check } from "../../features/doctor/doctor.ts"
import * as service from "../../runtime/service/service.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `body`, once every part of it that `hqChecks` reads is there; undefined if one isn't. */
function readByChecks(body: unknown): HqStatus | undefined {
  if (!isRecord(body) || !isRecord(body.tcp) || !isRecord(body.health)) return undefined
  const { tcp, health } = body
  const office = health.office
  const app = health.app
  if (!("socket" in body && "url" in body)) return undefined
  if (!["enabled", "port", "listening", "error"].every((key) => key in tcp)) return undefined
  if (!isRecord(office) || !("api" in office)) return undefined
  if (app !== null && !(isRecord(app) && "api" in app)) return undefined
  const { warnings } = body
  if (warnings !== undefined && !(Array.isArray(warnings) && warnings.every((w) => typeof w === "string"))) {
    return undefined
  }
  return body as HqStatus
}

/**
 * `GET /hq` from the office on `socket`, sent with the identity's token when there is one, or why it couldn't be
 * read.
 */
export async function hqStatus(
  socket: string,
  identity: Identity | undefined,
  timeoutMs = 2000,
): Promise<HqStatus | service.Unread> {
  return service.readFromOffice(socket, identity, "/hq", timeoutMs, readByChecks)
}

/** How HQ's status starts the TCP error when the web port's server stopped after it bound, not a failed bind. */
const SERVER_ENDED = "its server ended"

/** What to do about an HQ status doctor couldn't read, by why. */
export const UNREAD: Record<service.Unread, string> = {
  refused: "the office doesn't know this device, so it won't say where HQ listens: run `opencorp login`",
  unreachable: "the office didn't say where HQ listens (an office from before HQ?): run `opencorp restart`",
  unreadable:
    "the office's answer about HQ isn't one doctor can read (an office running other code?): run `opencorp restart`",
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

/** Where HQ listens (see `hqPortChecks`), whether the web app is built for this office, and HQ's own warnings. */
export function hqChecks(
  status: HqStatus | service.Unread,
  officeDir: string,
  repo: string,
  socketMissing: string | null = null,
): Check[] {
  if (typeof status === "string") return [{ name: "hq", status: "warn", detail: UNREAD[status] }]
  const found = hqPortChecks(status, officeDir, socketMissing)
  const { app, office } = status.health
  if (app === null && !isDirectory(path.join(repo, "packages", "app"))) {
    // Installed from a package, not a checkout.
    found.push({
      name: "web app",
      status: "warn",
      detail:
        "this install has no web app; it's built in a checkout of the opencorp repo. To serve one, point " +
        `"app_dir" in ${path.join(officeDir, "hq.json")} at packages/app/dist in a checkout at this version ` +
        `(v${VERSION}), built there, then run \`opencorp restart\``,
    })
  } else if (app === null) {
    found.push({ name: "web app", status: "warn", detail: `not built: run \`bun run build\` in ${repo}` })
  } else if (app.api !== office.api) {
    found.push({
      name: "web app",
      status: "warn",
      detail:
        `built for ${app.api}, which doesn't match the office's ${office.api}: run \`bun run build\` in ${repo}, ` +
        "or `opencorp restart`",
    })
  } else {
    found.push({ name: "web app", status: "ok", detail: `built for ${office.api}` })
  }
  for (const warning of status.warnings ?? []) found.push({ name: "hq warning", status: "warn", detail: warning })
  return found
}

/** Where HQ listens: on hq.sock and on its web port. `socketMissing` is why the socket isn't at its path when the
 *  office itself saw nothing wrong, with what to do about it. */
export function hqPortChecks(status: HqStatus, officeDir: string, socketMissing: string | null = null): Check[] {
  const { tcp } = status
  const error = tcp.error
  const retry = RETRY_MS / 1000
  let found: Check[]
  if (tcp.listening) {
    found = [{ name: "hq", status: "ok", detail: `web app at ${status.url}, and on ${status.socket}` }]
  } else if (!tcp.enabled) {
    found = [
      {
        name: "hq",
        status: "ok",
        detail: `on ${status.socket} only (the web port is off); \`opencorp hq\` prints the SSH forward`,
      },
    ]
  } else if (!error) {
    found = [{ name: "hq", status: "warn", detail: `port ${tcp.port} isn't listening yet (HQ is binding it)` }]
  } else if (error.startsWith(SERVER_ENDED)) {
    const why = error.slice("its ".length)
    found = [
      {
        name: "hq",
        status: "warn",
        detail: `port ${tcp.port}: ${why}; HQ binds it again in ${retry} s, or run \`opencorp restart\``,
      },
    ]
  } else {
    found = [
      {
        name: "hq",
        status: "warn",
        detail:
          `port ${tcp.port} isn't free (${error}); HQ tries it again every ${retry} s. Free it, or set another ` +
          `"port" in ${path.join(officeDir, "hq.json")} (for example {"port": ${otherPort(tcp.port)}}; create the ` +
          "file if it doesn't exist; keep any keys it already has) and run `opencorp restart`",
      },
    ]
  }
  // An office from before the field has none.
  const socketError = status.socket_error
    ? `${status.socket_error}; run \`opencorp restart\` once that's fixed`
    : socketMissing
  if (socketError) {
    // The web port keeps a line of its own, so what's wrong with it isn't lost under the socket's problem.
    const port: Check = tcp.listening
      ? { name: "hq port", status: "ok", detail: `web app at ${status.url}` }
      : { ...found[0]!, name: "hq port" }
    found = [
      {
        name: "hq",
        status: "warn",
        detail: `not listening on ${status.socket}: ${socketError}`,
      },
      ...(tcp.enabled ? [port] : []),
    ]
  }
  return found
}

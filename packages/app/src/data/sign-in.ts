// What the sign-in and pair pages share: the browser's name, the handle as typed, what a failure says, and the
// session they keep.
import { OfficeError, UnknownDevice } from "@opencorp/client"
import type { BrowserSession } from "@opencorp/protocol"
import { forget, store } from "./storage"

/** "Safari on Mac", from the user agent, to name this browser in `opencorp devices list`. */
export function browserLabel(ua: string) {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser"
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "this device"
  return `${browser} on ${os}`
}

/**
 * The handle as typed, made into one the office can match: trimmed, without a leading `@`, lowercased. Typed as is,
 * `@NgocBH` would fail the office's handle pattern instead of signing in.
 */
export const cleanHandle = (typed: string) => typed.trim().replace(/^@/, "").toLowerCase()

/** The protocol's `Handle` pattern. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** Whether `handle` (already cleaned) could be a handle; the form doesn't send one that couldn't. */
export const isHandle = (handle: string) => HANDLE.test(handle)

/** What the sign-in form says after `e`; `code` spans are in backticks. */
export function signInFailure(e: unknown) {
  // An office without /api/login refuses it as it refuses any request without a session.
  if (e instanceof UnknownDevice && e.code === "sign_in_required")
    return "This office can't take a password yet; run `opencorp pair`."
  if (e instanceof OfficeError) {
    if (e.status === 401) return "Wrong handle or password."
    if (e.status === 429) {
      const minutes = e.retryAfterS === undefined ? undefined : Math.max(1, Math.ceil(e.retryAfterS / 60))
      const wait = minutes === undefined ? "a few minutes" : minutes === 1 ? "1 minute" : `${minutes} minutes`
      return `Too many tries; wait ${wait}, or run \`opencorp pair\`.`
    }
    if (e.status === 503) return "The office is busy; try again."
  }
  return `Couldn't sign in: ${e instanceof Error ? e.message : e}.`
}

/**
 * Keeps who signed this browser in, for the sidebar's "paired by". Not a secret (the cookie is HttpOnly): the
 * session's id, name and issuer only.
 */
export function rememberSession({ id, name, issued_by }: BrowserSession) {
  store("localStorage", "hq.session", JSON.stringify({ id, name, issued_by }))
}

/** Forgets what rememberSession kept, once this browser is signed out. */
export const forgetSession = () => forget("localStorage", "hq.session")

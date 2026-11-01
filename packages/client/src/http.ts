import { OfficeDropped, OfficeError, OfficeTimeout, OfficeUnavailable, UnknownDevice, VersionConflictError } from "./errors"

// Bun sends the request over the socket; the host only fills the Host header.
export const BASE = "http://localhost"

/** Where the office is: its unix socket (Bun: the TUI and the CLI), or a base URL (a browser, with its cookie). */
export type Transport = { socket: string; baseUrl?: never } | { baseUrl: string; socket?: never }

/** `target` as a transport, without a base URL's trailing slashes; a bare string is a socket path. */
export function transportOf(target: string | Transport): Transport {
  if (typeof target === "string") return { socket: target }
  return target.socket !== undefined ? { socket: target.socket } : { baseUrl: target.baseUrl.replace(/\/+$/, "") }
}

/** The socket path or base URL `t` points at, for messages. */
export const where = (t: Transport) => (t.socket !== undefined ? t.socket : t.baseUrl)

/** Fetches `path` from the office over `t`. */
export function officeFetch(t: Transport, path: string, init: RequestInit): Promise<Response> {
  return t.socket !== undefined
    ? fetch(BASE + path, { ...init, unix: t.socket })
    : fetch(t.baseUrl + path, { ...init, credentials: "same-origin" })
}

export type Method = "GET" | "POST" | "PUT" | "DELETE"

/** Encodes one path segment (an id or a folder path). */
export const seg = encodeURIComponent

/**
 * Whether `value` can be sent as one path segment: the URL parser collapses `.` and `..` even percent-encoded, and the
 * office refuses an empty segment or one holding `/`.
 */
export const isSegment = (value: string) => value !== "" && value !== "." && value !== ".." && !value.includes("/")

export type RequestOptions = {
  /** Aborts the request; the abort error is rethrown as is. */
  signal?: AbortSignal
  /** Gives up after this long, headers and body included, with `OfficeTimeout`. */
  timeoutMs?: number
  /** This device's token, sent as `Authorization: Bearer`. */
  token?: string
}

/**
 * What a token may hold: printable ASCII with no space. Tokens are `act_` and base64url; Bun's error for a header it
 * can't send quotes the header, token and all, so one that can't be sent never reaches fetch.
 */
export const TOKEN_CHARS = /^[\x21-\x7E]+$/

/** The headers that carry `token`, if there is one. Throws `bad_token` for a token a header can't carry. */
export function authorization(token?: string): Record<string, string> {
  if (!token) return {}
  if (!TOKEN_CHARS.test(token))
    throw new OfficeError(
      0,
      "bad_token",
      "this device's token can't be sent (it holds characters a token can't have); run `opencorp login --force`",
    )
  return { authorization: `Bearer ${token}` }
}

/** Sends one JSON request to the office and returns the parsed body. Throws `OfficeError`. */
export async function request<T>(
  target: string | Transport,
  method: Method,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const { signal, timeoutMs, token } = opts
  const t = transportOf(target)
  // HQ refuses a write without a JSON body (a CORS "simple" POST can't send one), so a browser always sends one.
  const sent = body === undefined && method !== "GET" && t.baseUrl !== undefined ? {} : body
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
  const both = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout)
  const failed = (e: unknown, otherwise: () => OfficeError) => {
    if (signal?.aborted) return e
    if (timeout?.aborted) return new OfficeTimeout(method, path, timeoutMs!)
    return otherwise()
  }
  // Outside the try: a token that can't be sent is bad_token, not an office that's away.
  const headers = { ...authorization(token), ...(sent !== undefined && { "content-type": "application/json" }) }
  let res: Response
  try {
    res = await officeFetch(t, path, {
      method,
      signal: both,
      headers,
      body: sent === undefined ? undefined : JSON.stringify(sent),
    })
  } catch (e) {
    const remote = t.baseUrl !== undefined
    throw failed(e, () =>
      (e as { code?: unknown } | null)?.code === "ECONNRESET"
        ? new OfficeDropped(where(t), method, path, e, remote)
        : new OfficeUnavailable(where(t), e, remote),
    )
  }
  let text: string
  try {
    text = await res.text()
  } catch (e) {
    throw failed(e, () => new OfficeError(res.status, "bad_response", `${method} ${path}: the body could not be read`))
  }
  let data: unknown
  let json = true
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    json = false
  }
  const d = (json && data && typeof data === "object" ? data : {}) as Record<string, unknown>
  // Before the JSON check: a 401 from a proxy or a sign-in page has an HTML body and still means "sign in again".
  if (res.status === 401)
    throw new UnknownDevice(typeof d.error === "string" ? d.error : "unauthenticated", t.baseUrl !== undefined)
  if (!json) throw new OfficeError(res.status, "bad_response", `${method} ${path}: HTTP ${res.status}, body is not JSON`)
  if (res.ok) return data as T
  if (res.status === 409 && typeof d.expected === "string" && typeof d.current === "string")
    throw new VersionConflictError(d.expected, d.current)
  const err =
    typeof d.error === "string"
      ? new OfficeError(res.status, d.error, typeof d.message === "string" ? d.message : d.error)
      : new OfficeError(res.status, "bad_response", `${method} ${path}: HTTP ${res.status}`)
  err.retryAfterS = retryAfter(res.headers.get("retry-after"))
  throw err
}

/** A `Retry-After` header's delay in seconds; undefined when it's missing or an HTTP date. */
function retryAfter(value: string | null) {
  return value !== null && /^\s*\d+\s*$/.test(value) ? Number(value) : undefined
}

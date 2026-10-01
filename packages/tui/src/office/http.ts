import { OfficeError, OfficeTimeout, OfficeUnavailable, UnknownDevice, VersionConflictError } from "./errors"

// Bun sends the request over the socket; the host only fills the Host header.
export const BASE = "http://localhost"

export type Method = "GET" | "POST" | "PUT" | "DELETE"

/** Encodes one path segment (an id or a folder path). */
export const seg = encodeURIComponent

export type RequestOptions = {
  /** Aborts the request; the abort error is rethrown as is. */
  signal?: AbortSignal
  /** Gives up after this long, headers and body included, with `OfficeTimeout`. */
  timeoutMs?: number
  /** This device's token, sent as `Authorization: Bearer`. */
  token?: string
}

/** The headers that carry `token`, if there is one. */
export const authorization = (token?: string): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {}

/** Sends one JSON request to the office and returns the parsed body. Throws `OfficeError`. */
export async function request<T>(
  socket: string,
  method: Method,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const { signal, timeoutMs, token } = opts
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
  const both = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout)
  const failed = (e: unknown, otherwise: () => OfficeError) => {
    if (signal?.aborted) return e
    if (timeout?.aborted) return new OfficeTimeout(method, path, timeoutMs!)
    return otherwise()
  }
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      unix: socket,
      signal: both,
      headers: { ...authorization(token), ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    throw failed(e, () => new OfficeUnavailable(socket, e))
  }
  let data: unknown
  try {
    const text = await res.text()
    try {
      data = text ? JSON.parse(text) : undefined
    } catch {
      throw new OfficeError(res.status, "bad_response", `${method} ${path}: HTTP ${res.status}, body is not JSON`)
    }
  } catch (e) {
    if (e instanceof OfficeError) throw e
    throw failed(e, () => new OfficeError(res.status, "bad_response", `${method} ${path}: the body could not be read`))
  }
  if (res.ok) return data as T
  const d = (data ?? {}) as Record<string, unknown>
  if (res.status === 401) throw new UnknownDevice(typeof d.error === "string" ? d.error : "unauthenticated")
  if (res.status === 409 && typeof d.expected === "string" && typeof d.current === "string")
    throw new VersionConflictError(d.expected, d.current)
  if (typeof d.error === "string")
    throw new OfficeError(res.status, d.error, typeof d.message === "string" ? d.message : d.error)
  throw new OfficeError(res.status, "bad_response", `${method} ${path}: HTTP ${res.status}`)
}

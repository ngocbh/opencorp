import { OfficeError, OfficeUnavailable, VersionConflictError } from "./errors"

// Bun sends the request over the socket; the host only fills the Host header.
export const BASE = "http://localhost"

export type Method = "GET" | "POST" | "PUT"

/** Encodes one path segment (an id or a folder path). */
export const seg = encodeURIComponent

/** Sends one JSON request to the office and returns the parsed body. Throws `OfficeError`. */
export async function request<T>(
  socket: string,
  method: Method,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      unix: socket,
      signal,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new OfficeUnavailable(socket, e)
  }
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    throw new OfficeError(res.status, "bad_response", `${method} ${path}: HTTP ${res.status}, body is not JSON`)
  }
  if (res.ok) return data as T
  const d = (data ?? {}) as Record<string, unknown>
  if (res.status === 409 && typeof d.expected === "string" && typeof d.current === "string")
    throw new VersionConflictError(d.expected, d.current)
  if (typeof d.error === "string")
    throw new OfficeError(res.status, d.error, typeof d.message === "string" ? d.message : d.error)
  throw new OfficeError(res.status, "bad_response", `${method} ${path}: HTTP ${res.status}`)
}

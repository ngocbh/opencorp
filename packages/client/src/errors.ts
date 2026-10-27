/** A failed office request: the `ApiError` body, or a response the client couldn't read. */
export class OfficeError extends Error {
  /** How many seconds the office asked the client to wait first (its `Retry-After` header), when it said. */
  retryAfterS?: number
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "OfficeError"
  }
}

/** Nothing answers at the office's socket or base URL. */
export class OfficeUnavailable extends OfficeError {
  constructor(
    readonly socket: string,
    cause?: unknown,
    remote = false,
  ) {
    super(
      0,
      "office_unavailable",
      remote ? `can't reach the office at ${socket}` : `the office is not running (no socket at ${socket})`,
    )
    this.name = "OfficeUnavailable"
    this.cause = cause
  }
}

/** The office refused the request's device token or browser session, or wanted one (a 401). */
export class UnknownDevice extends OfficeError {
  /** `remote`: the client reached the office at a base URL (a browser, signed in by pairing). */
  constructor(code: string, remote = false) {
    super(
      401,
      code,
      remote
        ? "the office doesn't know this browser: pair this browser again"
        : "the office doesn't know this device: run `opencorp login`",
    )
    this.name = "UnknownDevice"
  }
}

/** The office didn't answer within the request's time limit. */
export class OfficeTimeout extends OfficeError {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(0, "timeout", `${method} ${path}: no answer from the office within ${timeoutMs / 1000} s`)
    this.name = "OfficeTimeout"
  }
}

/** A profile write lost a race: the profile is at `current`, not `expected`. */
export class VersionConflictError extends OfficeError {
  constructor(
    readonly expected: string,
    readonly current: string,
  ) {
    super(409, "version_conflict", `the profile changed (expected ${expected}, now ${current})`)
    this.name = "VersionConflictError"
  }
}

/** Whether `e` is the office's 501 for a route that hasn't landed yet. */
export const isNotImplemented = (e: unknown) => e instanceof OfficeError && e.status === 501

/** Whether `e` is an office's `404 no_route`: an office older than the route. */
export const isMissingRoute = (e: unknown) => e instanceof OfficeError && e.status === 404 && e.code === "no_route"

/** Whether `e` is a company file read's `409 stale_commit`: its `at` is no longer served, so refetch the tree. */
export const isStaleCommit = (e: unknown) => e instanceof OfficeError && e.status === 409 && e.code === "stale_commit"

/** Whether `e` is a company file read's `404 no_file`: the path isn't a file at that commit. */
export const isNoFile = (e: unknown) => e instanceof OfficeError && e.status === 404 && e.code === "no_file"

/** Whether `e` is a company file read's `400 bad_path`: the path isn't repo-relative and `/`-separated. */
export const isBadPath = (e: unknown) => e instanceof OfficeError && e.status === 400 && e.code === "bad_path"

/** Whether `e` is a run page read's `409 unsupported_schema`: the log uses a run-log schema this office can't read. */
export const isUnsupportedSchema = (e: unknown) =>
  e instanceof OfficeError && e.status === 409 && e.code === "unsupported_schema"

/** Whether `e` is a run page read's `404 no_log`: the run has no log (it didn't start, or the log is gone). */
export const isNoLog = (e: unknown) => e instanceof OfficeError && e.status === 404 && e.code === "no_log"

/**
 * What kind of failure `e` is, to tell a new failure from a repeat of the last: the class and status when the office
 * answered, "network" when it didn't (no answer, a dropped connection), "none" for no failure.
 */
export function failureKind(e: unknown) {
  if (e === undefined) return "none"
  return e instanceof OfficeError && e.status > 0 ? `${e.name} ${e.status}` : "network"
}

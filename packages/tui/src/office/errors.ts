/** A failed office request: the `ApiError` body, or a response the client couldn't read. */
export class OfficeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "OfficeError"
  }
}

/** Nothing is listening on the office socket. */
export class OfficeUnavailable extends OfficeError {
  constructor(
    readonly socket: string,
    cause?: unknown,
  ) {
    super(0, "office_unavailable", `the office is not running (no socket at ${socket})`)
    this.name = "OfficeUnavailable"
    this.cause = cause
  }
}

/** The office refused the request's device token, or wanted one (a 401). */
export class UnknownDevice extends OfficeError {
  constructor(code: string) {
    super(401, code, "the office doesn't know this device: run `opencorp login`")
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

/** The time `at` as a protocol Timestamp in UTC, e.g. 2026-09-29T10:00:00.000Z. */
export function stamp(at: Date): string {
  return at.toISOString()
}

/** The current UTC time as a protocol Timestamp, e.g. 2026-09-29T10:00:00.000Z. */
export function now(): string {
  return stamp(new Date())
}

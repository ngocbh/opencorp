import { z } from "zod"

/**
 * Error codes the office sends in `ApiError.error` and clients may branch on; route modules add theirs as they
 * land. `ApiError.error` stays a plain string, so a client ignores a code it doesn't know.
 */
export const ERROR_CODES = [
  "bad_login",
  "bad_path",
  "bad_target",
  "body_timeout",
  "body_too_large",
  "busy",
  "cross_site",
  "device_exists",
  "forbidden",
  "host_not_allowed",
  "http_error",
  "indexing",
  "internal_error",
  "invalid_body",
  "json_required",
  "method_not_allowed",
  "no_file",
  "no_log",
  "no_password",
  "no_route",
  "not_found",
  "not_implemented",
  "origin_not_allowed",
  "pair_code_invalid",
  "sign_in_required",
  "stale_commit",
  "stopping",
  "too_large",
  "too_many_attempts",
  "unauthenticated",
  "unsupported_schema",
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/** The keys of `schema`'s top level: an object's shape keys, or every option's for a discriminated union. */
function topKeys(schema: z.ZodType): Set<string> {
  if (schema instanceof z.ZodObject) return new Set(Object.keys(schema.shape))
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return new Set(schema.options.flatMap((o) => (o instanceof z.ZodObject ? Object.keys(o.shape) : [])))
  }
  return new Set()
}

const isObject = (v: unknown): v is Record<PropertyKey, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Whether `path`'s last key is missing from `data`; it reads key presence only, never a value. */
function missing(data: unknown, path: readonly PropertyKey[]): boolean {
  let parent = data
  for (const [i, key] of path.entries()) {
    if (!isObject(parent) && !(typeof key === "number" && Array.isArray(parent))) return false
    const container = parent as Record<PropertyKey, unknown>
    if (i === path.length - 1) return !Object.hasOwn(container, key)
    parent = container[key]
  }
  return false
}

// Each phrase is fixed: zod's own messages can quote the input, such as an enum's or a literal's expected values.
function phrase(issue: z.core.$ZodIssue, data: unknown): string {
  const presence = issue.code === "invalid_type" || issue.code === "invalid_value" || issue.code === "invalid_union"
  if (presence && missing(data, issue.path)) return "is required"
  switch (issue.code) {
    case "invalid_type":
      return "has the wrong type"
    case "too_small":
      return issue.origin === "string" || issue.origin === "array" ? "is too short" : "is too small"
    case "too_big":
      return issue.origin === "string" || issue.origin === "array" ? "is too long" : "is too large"
    case "invalid_format":
      return "isn't in the right format"
    case "invalid_value":
    case "invalid_union":
      return "isn't an allowed value"
    case "unrecognized_keys":
      return issue.path.length === 0 ? "isn't allowed" : "has an unknown field"
    default:
      return "isn't valid"
  }
}

/**
 * The text of a 422 `invalid_body`: each issue's top-level field and a fixed phrase. It never holds an input value
 * or an unknown key's name, since a body may carry a key or a password.
 *
 * `data` is the parsed JSON body that failed `schema`, read only to tell a missing key from a wrong or disallowed
 * one: zod reports the input only with `reportInput`, which stays off.
 */
export function validationMessage(schema: z.ZodType, error: z.ZodError, data: unknown): string {
  const keys = topKeys(schema)
  return error.issues
    .map((issue) => {
      const head = issue.path[0]
      const where =
        typeof head === "string" && keys.has(head)
          ? head
          : issue.path.length === 0 && issue.code !== "unrecognized_keys"
            ? "body"
            : "an extra field"
      return `${where}: ${phrase(issue, data)}`
    })
    .join("; ")
}

import { z } from "zod"

/**
 * Error codes the office sends in `ApiError.error` and clients may branch on; route modules add theirs as they
 * land. `ApiError.error` stays a plain string, so a client ignores a code it doesn't know.
 */
export const ERROR_CODES = [
  "bad_credentials",
  "bad_login",
  "bad_path",
  "bad_target",
  "bad_token",
  "body_timeout",
  "body_too_large",
  "busy",
  "cannot_send_back",
  "cannot_stop",
  "cant_wake",
  "cap_too_low",
  "codex_refused",
  "connection_unusable",
  "cross_site",
  "device_exists",
  "ending",
  "forbidden",
  "harness_card",
  "host_not_allowed",
  "http_error",
  "indexing",
  "internal_error",
  "invalid_answer",
  "invalid_body",
  "invalid_connection",
  "json_required",
  "key_refused",
  "lint_failed",
  "live",
  "method_not_allowed",
  "model_refused",
  "models_unlisted",
  "no_discussion",
  "no_file",
  "no_log",
  "no_manager_flow",
  "no_password",
  "no_route",
  "not_a_card",
  "not_a_human",
  "not_an_agent",
  "not_continuable",
  "not_found",
  "not_implemented",
  "not_live",
  "not_open",
  "not_supported",
  "origin_not_allowed",
  "pair_code_invalid",
  "password_changed",
  "refused",
  "run_busy",
  "set_up_by_onboard",
  "sign_in_required",
  "stale_commit",
  "start_failed",
  "stopping",
  "token_in_use",
  "too_large",
  "too_many_attempts",
  "unauthenticated",
  "unknown_connection",
  "unsafe_workspace",
  "unsupported_harness",
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

const isContainer = (v: unknown): v is Record<PropertyKey, unknown> => typeof v === "object" && v !== null

/** Whether `path`'s last key is missing from `data`; it reads key presence only, never a value. */
function missing(data: unknown, path: readonly PropertyKey[]): boolean {
  const last = path.at(-1)
  if (last === undefined) return false
  let parent = data
  for (const key of path.slice(0, -1)) {
    if (!isContainer(parent)) return false
    parent = parent[key]
  }
  return isContainer(parent) && !Object.hasOwn(parent, last)
}

/** The field `issue` names: its top-level key when `keys` has it, else the body itself or an extra field. */
function field(issue: z.core.$ZodIssue, keys: Set<string>): string {
  const head = issue.path[0]
  if (typeof head === "string" && keys.has(head)) return head
  if (issue.path.length === 0 && issue.code !== "unrecognized_keys") return "body"
  return "an extra field"
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
 *
 * Callers must never log, rethrow or send the `ZodError` itself (`error.message`, `String(error)`) or its `issues`:
 * they quote unknown keys and record keys, such as `Unrecognized key: "<key>"` or a path like
 * `["tools", "<key>", "risk"]`.
 */
export function validationMessage(schema: z.ZodType, error: z.ZodError, data: unknown): string {
  const keys = topKeys(schema)
  const lines = error.issues.map((issue) => `${field(issue, keys)}: ${phrase(issue, data)}`)
  // A long array of bad items gives one issue per item, so an 800 KB body could otherwise give megabytes of text.
  return [...new Set(lines)].join("; ")
}

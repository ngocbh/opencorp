/** The connection spec `reach.sh` prints, the part of reaching a remote HQ that differs between setups, checked so
 *  no value can become an ssh option, a shell word or a second forward; and the remote command built from it. */
import { z } from "zod"

const USER = "[a-z_][a-z0-9_.-]{0,31}"
const HOST = "[A-Za-z0-9][A-Za-z0-9.-]{0,252}"
/** `[user@]host`. */
export const DESTINATION = new RegExp(`^(?:${USER}@)?${HOST}$`)
/** `[user@]host[:port]`. */
export const JUMP = new RegExp(`^(?:${USER}@)?${HOST}(?::([1-9][0-9]{0,4}))?$`)
const PATH_CHARS = /^\/[A-Za-z0-9._+/-]*$/

/** Whether `p` is an absolute path of letters, digits and `._+-/` with no `..` segment: safe unquoted in a shell
 *  command, an ssh config line and a `-L` forward (no `:`, `%`, space or quote). */
export function safePath(p: string): boolean {
  return p.length <= 1024 && PATH_CHARS.test(p) && !p.split("/").includes("..")
}
const SafePath = z
  .string()
  .refine(safePath, { message: "must be an absolute path of letters, digits and . _ + - / with no .." })

/** What the remote command may set: what a non-interactive shell on the node may lack. */
export const ENV_KEYS = ["PATH", "OPENCORP_BUN", "OPENCORP_HOME"] as const

export const Spec = z.strictObject({
  host: z.string().regex(DESTINATION, { message: "must be [user@]host" }),
  port: z.int().min(1).max(65535).optional(),
  jump: z
    .array(
      z
        .string()
        .regex(JUMP, { message: "must be [user@]host[:port]" })
        .refine((j) => Number(JUMP.exec(j)?.[1] ?? "22") <= 65535, { message: "its port must be 1-65535" }),
    )
    .min(1)
    .max(3)
    .optional(),
  opencorp: SafePath.refine((p) => p.endsWith("/opencorp"), { message: "must end in /opencorp" }),
  env: z
    .strictObject({
      PATH: z
        .string()
        .max(4096)
        .refine((v) => v.split(":").every(safePath), { message: "must be absolute paths joined by :" })
        .optional(),
      OPENCORP_BUN: SafePath.optional(),
      OPENCORP_HOME: SafePath.optional(),
    })
    .optional(),
})
export type Spec = z.output<typeof Spec>

/** The last non-blank line of `text`, trimmed, or null: a login banner or a `.bashrc` may print above it. */
export function lastLine(text: string): string | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  return lines.at(-1) ?? null
}

/** `lastLine(text)` parsed as JSON, or `undefined` when there's none or it isn't JSON. */
export function lastJson(text: string): unknown {
  const line = lastLine(text)
  if (line === null) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** The spec on the last line of `stdout`, or what's wrong with it: field names and our own words, never a value,
 *  since the output came from another machine. */
export function parseSpec(stdout: string): { spec: Spec } | { problem: string } {
  const data = lastJson(stdout)
  if (data === undefined) return { problem: "its last line of output isn't JSON" }
  const parsed = Spec.safeParse(data)
  if (parsed.success) return { spec: parsed.data }
  return {
    problem: parsed.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "the spec"}: ${issueMessage(issue)}`)
      .join("; "),
  }
}

/** An issue's message, unless zod's own words would quote the input (an unknown key's name, say). */
function issueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") return "has a key that isn't allowed"
  return /["'`]/.test(issue.message) ? "isn't allowed" : issue.message
}

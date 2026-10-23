// Protocol schemas: company.
import { z } from "zod"
import { GitId, Handle, Id, Timestamp } from "./common"

export const CompanyDefaults = z.strictObject({
  provider_policy: z.string().default("default"),
  cost_cap_usd: z.number().min(0).default(5),
  max_turns: z.int().min(1).default(500),
  profile_max_chars: z.int().min(1).default(32000),
  side_chat_cost_cap_usd: z.number().min(0).default(1),
  side_seed_max_chars: z.int().min(1).default(200000),
})
export type CompanyDefaults = z.input<typeof CompanyDefaults>

export const Company = z.strictObject({
  name: z.string().min(1),
  ceo: Handle,
  hq: z.string().nullable().default(null),
  defaults: CompanyDefaults.nullable().default(null),
})
export type Company = z.input<typeof Company>

export const HarnessPolicy = z.strictObject({
  sandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
  network: z.boolean().default(false),
})
export type HarnessPolicy = z.input<typeof HarnessPolicy>

export const Sop = z.strictObject({
  flow: z.string(),
  gate: z.boolean().default(false),
})
export type Sop = z.input<typeof Sop>

export const Routine = z.strictObject({
  name: z.string(),
  flow: z.string(),
  trigger: z.record(z.string(), z.unknown()).nullable().default(null),
})
export type Routine = z.input<typeof Routine>

export const AssetTool = z.strictObject({
  risk: z.enum(["normal", "gated"]).default("normal"),
})
export type AssetTool = z.input<typeof AssetTool>

export const Grant = z.strictObject({
  /** A person's handle, or group:<group id>. */
  who: z.string().regex(/^(?:group:(?:[0-9A-HJKMNP-TV-Z]{26}|[a-z0-9](?:-?[a-z0-9])*)|[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$/u),
  can: z.array(z.string()).min(1),
  where: z.record(z.string(), z.array(z.unknown())).nullable().default(null),
})
export type Grant = z.input<typeof Grant>

export const Asset = z.strictObject({
  id: Id,
  kind: z.string(),
  tools: z.record(z.string(), AssetTool).default(() => ({})),
  grants: z.array(Grant).default(() => []),
  secrets: z.array(z.string()).default(() => []),
})
export type Asset = z.input<typeof Asset>

export const RepoIssue = z.strictObject({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  severity: z.enum(["error", "warning"]).default("error"),
})
export type RepoIssue = z.input<typeof RepoIssue>

/** A commit of the office's clone of the company repo. */
export const CommitInfo = z.strictObject({
  id: GitId,
  /** The first line of the commit message. */
  subject: z.string(),
  /** The author's name, never their email. */
  author: z.string(),
  time: Timestamp,
})
export type CommitInfo = z.input<typeof CommitInfo>

/** An entry (file, folder, symlink or submodule) of the company repo at one commit. */
export const CompanyTreeEntry = z.strictObject({
  /** Repo-relative and /-separated, with no leading or trailing /. */
  path: z.string().regex(/^[^\/]+(?:\/[^\/]+)*$/u),
  type: z.enum(["file", "folder", "symlink", "submodule"]),
  /** The blob's size in bytes for a file or symlink; null for a folder or submodule. */
  size: z.int().min(0).nullable().default(null),
})
export type CompanyTreeEntry = z.input<typeof CompanyTreeEntry>

/** The company repo's files at HEAD of the office's clone, as GET /api/company/tree serves it. */
export const CompanyTree = z.strictObject({
  commit: CommitInfo,
  /** At most 5,000, taken breadth-first: by depth, then name. */
  entries: z.array(CompanyTreeEntry),
  /** True when entries past the cap were left out. */
  truncated: z.boolean(),
  /** Paths left out because they aren't valid UTF-8 or have a `.` or `..` segment; they can't be read. */
  skipped: z.int().min(0),
})
export type CompanyTree = z.input<typeof CompanyTree>

/**
 * One file of the company repo at a served commit, as GET /api/company/file serves it. Errors come as an
 * ApiError: a malformed path gets 400 bad_path; a path that isn't in that commit's listing, or is a folder,
 * gets 404 no_file; 409 stale_commit means `at` isn't one of the last 8 HEADs the office served, so refetch
 * the tree.
 */
export const CompanyFile = z.strictObject({
  /** Repo-relative and /-separated, with no leading or trailing /. */
  path: z.string().regex(/^[^\/]+(?:\/[^\/]+)*$/u),
  commit: GitId,
  /**
   * What the response holds: text in `text`, a symlink's target in `target`; nothing for the others. The
   * office no longer sends `hidden` (kept for compatibility; clients ignore it).
   */
  content: z.enum(["text", "binary", "too_large", "hidden", "symlink", "submodule"]),
  /** The file's text as stored, when content is text; else null. */
  text: z.string().nullable().default(null),
  /** Where the symlink points, shown and never followed, when content is symlink; else null. */
  target: z.string().nullable().default(null),
  /** Always null: the office no longer hides files. Kept for compatibility; clients ignore it. */
  reason: z.string().nullable().default(null),
  /** Always false: the office no longer rewrites files. Kept for compatibility; clients ignore it. */
  rewritten: z.boolean().default(false),
})
export type CompanyFile = z.input<typeof CompanyFile>

import { z } from "zod"
import { GitId, Handle, Timestamp, Ulid } from "./common"
import { Company, RepoIssue } from "./company"
import { Group, Person } from "./people"

/**
 * The company at one commit of the office's clone, as GET /api/company serves it. People come without devices
 * or password hashes.
 */
export const CompanyView = z.strictObject({
  sha: GitId,
  /** Null when company.yaml is missing or doesn't parse at this commit. */
  company: Company.nullable(),
  people: z.array(Person),
  groups: z.array(Group),
  /** The files at this commit that don't parse. */
  issues: z.array(RepoIssue),
})
export type CompanyView = z.input<typeof CompanyView>

export const PersonCost = z.strictObject({
  /** The price of the person's model calls since the report's start; only composer sessions are priced. */
  usd: z.number().min(0),
  /**
   * The person's harness sessions (Codex, Claude) updated since then, whose tokens the office doesn't price.
   */
  unpriced_sessions: z.int().min(0),
})
export type PersonCost = z.input<typeof PersonCost>

/** Spend per person since a time, as GET /costs and GET /api/costs serve it. */
export const CostReport = z.strictObject({
  since: Timestamp,
  /** By handle; people with no spend are left out. */
  people: z.record(z.string(), PersonCost),
})
export type CostReport = z.input<typeof CostReport>

export const ApiVersion = z.strictObject({
  /** The compatibility key, `apiId()`: the version plus 12 hex of a hash of the protocol's JSON Schema. */
  api: z.string(),
})
export type ApiVersion = z.input<typeof ApiVersion>

/** The built web app's build.json. */
export const AppBuild = z.strictObject({
  /** A random nonce per build. */
  build: z.string(),
  /** The compatibility key the app was built for. */
  api: z.string(),
})
export type AppBuild = z.input<typeof AppBuild>

/** GET /api/health: the office's compatibility key and the built app's, if there is one. */
export const Health = z.strictObject({
  ok: z.literal(true),
  office: ApiVersion,
  /** Null when the web app isn't built. */
  app: AppBuild.nullable(),
})
export type Health = z.input<typeof Health>

/** HQ's TCP listener on 127.0.0.1. */
export const HqTcp = z.strictObject({
  enabled: z.boolean(),
  /** The bound port while listening, else the configured one. */
  port: z.int().min(0).max(65535),
  listening: z.boolean(),
  /** Why the last bind failed. */
  error: z.string().nullable().default(null),
  next_retry_at: Timestamp.nullable().default(null),
})
export type HqTcp = z.input<typeof HqTcp>

/** GET /hq on the office socket: where HQ listens, for `opencorp pair` and `opencorp doctor`. */
export const HqStatus = z.strictObject({
  /** The path of hq.sock. */
  socket: z.string(),
  tcp: HqTcp,
  /** `http://127.0.0.1:<port>/` while TCP is listening, else null. */
  url: z.string().nullable(),
  health: Health,
  /** Why hq.sock isn't listening, or null when it is. */
  socket_error: z.string().nullable().default(null),
  warnings: z.array(z.string()).default(() => []),
})
export type HqStatus = z.input<typeof HqStatus>

/** The body of POST /hq/pair on the office socket. */
export const PairCodeRequest = z.strictObject({
  /** The human the browser will act as; null: the asking person. */
  handle: Handle.nullable().default(null),
  /** Also write a 0600 redirect file to open, so the code never appears in a process's arguments. */
  open_file: z.boolean().default(false),
})
export type PairCodeRequest = z.input<typeof PairCodeRequest>

/**
 * A one-time pairing link: single use, valid for 5 minutes. `path` and `url` carry the secret code: served
 * only on the office socket, never under `/api`, and never logged.
 */
export const PairCode = z.strictObject({
  /** The link's path, `/pair#<code>`. */
  path: z.string(),
  /** `http://127.0.0.1:<port>/pair#<code>` while TCP is listening, else null. */
  url: z.string().nullable(),
  /** The path of hq.sock, for an SSH forward. */
  socket: z.string(),
  port: z.int().min(0).max(65535),
  expires_at: Timestamp,
  /** The redirect file's path, when one was asked for and TCP is listening. */
  open_file: z.string().nullable(),
})
export type PairCode = z.input<typeof PairCode>

/** The body of POST /api/pair: the code from the link's fragment. */
export const PairRequest = z.strictObject({
  code: z.string().min(1).max(64),
  /** Free text naming the browser, such as 'Safari on Mac'. */
  label: z.string().max(100).nullable().default(null),
})
export type PairRequest = z.input<typeof PairRequest>

/** A browser signed in to this office's HQ. Local to the office; never the cookie's secret. */
export const BrowserSession = z.strictObject({
  id: Ulid,
  person: Handle,
  /** The office's name for it, `web-<6 characters>`. */
  name: z.string(),
  label: z.string().nullable(),
  /** How it signed in. `pair`: a code from `opencorp pair`; `login`: a password. */
  via: z.enum(["pair", "login"]),
  /** Who ran `opencorp pair`, or the person who signed in with a password. */
  issued_by: Handle,
  created_at: Timestamp,
  expires_at: Timestamp,
  last_used_at: Timestamp.nullable(),
})
export type BrowserSession = z.input<typeof BrowserSession>

/**
 * The body of POST /api/login: a human's handle and password; the office answers with a browser session
 * cookie. A wrong handle or password gets 401 `bad_credentials`; too many tries get 429 `too_many_attempts`
 * with a Retry-After header; success returns a `BrowserSession`, as for /api/pair.
 */
export const HqLoginRequest = z.strictObject({
  handle: Handle,
  /** Checked, then dropped: never stored, logged, or echoed in an error. */
  password: z.string().min(1),
  /** Free text naming the browser, such as 'Safari on Mac'. */
  label: z.string().max(100).nullable().default(null),
})
export type HqLoginRequest = z.input<typeof HqLoginRequest>

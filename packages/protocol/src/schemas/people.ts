// Protocol schemas: people.
import { z } from "zod"
import { DeviceName, GitId, Handle, Id, PasswordHash, TokenHash } from "./common"
import { HarnessPolicy, RepoIssue, Routine, Sop } from "./company"

/** A device a human uses opencorp from: requests carrying the token whose hash this is act as that person. */
export const Device = z.strictObject({
  name: DeviceName,
  token_sha256: TokenHash,
})
export type Device = z.input<typeof Device>

export const Person = z.strictObject({
  handle: Handle,
  name: z.string().min(1),
  kind: z.enum(["human", "agent"]),
  title: z.string(),
  manager: Handle.nullable(),
  groups: z.array(Id).default(() => []),
  home_office: z.string().nullable().default(null),
  main: z.string().nullable().default(null),
  sops: z.array(Sop).default(() => []),
  skills: z.array(z.string()).default(() => []),
  harnesses: z.array(z.enum(["composer", "codex", "claude"])).default(() => []),
  harness_policy: HarnessPolicy.nullable().default(null),
  routines: z.array(Routine).default(() => []),
  provider_policy: z.string().default("default"),
  /** The devices this human uses opencorp from, each with a unique name. */
  devices: z.array(Device).default(() => []),
  /** The hash of the password this human logs in a new device with; null for none. */
  password_hash: PasswordHash.nullable().default(null),
  /**
   * A model id as a connection lists it, e.g. `gpt-5.5`, or `openai/gpt-4o` on OpenRouter. Each office starts
   * the agent's chats on the first of its connections that offers it (the default first, then the others by
   * name). If none does, it uses its default and says so in the chat.
   */
  model: z.string().nullable().default(null),
})
export type Person = z.input<typeof Person>

export const Group = z.strictObject({
  id: Id,
  name: z.string().min(1),
  parent: Id.nullable().default(null),
  head: Handle.nullable().default(null),
})
export type Group = z.input<typeof Group>

export const HireRequest = z.strictObject({
  name: z.string().min(1),
  handle: Handle,
  title: z.string(),
  manager: Handle,
  confirm: z.boolean().default(false),
})
export type HireRequest = z.input<typeof HireRequest>

export const HireResponse = z.strictObject({
  person: Person,
  diff: z.string(),
  issues: z.array(RepoIssue),
  commit: GitId.nullable(),
})
export type HireResponse = z.input<typeof HireResponse>

/** The body of POST /people/{handle}/devices. */
export const AddDeviceRequest = z.strictObject({
  name: DeviceName,
  token_sha256: TokenHash,
})
export type AddDeviceRequest = z.input<typeof AddDeviceRequest>

/**
 * The body of POST /login: a human's handle and password, and the device to add to their devices once they
 * check out.
 */
export const LoginRequest = z.strictObject({
  handle: Handle,
  password: z.string().min(1),
  device: DeviceName,
  token_sha256: TokenHash,
})
export type LoginRequest = z.input<typeof LoginRequest>

/** The body of PUT /people/{handle}/password: the new password, which the office stores only as a hash. */
export const SetPasswordRequest = z.strictObject({
  password: z.string().min(8),
})
export type SetPasswordRequest = z.input<typeof SetPasswordRequest>

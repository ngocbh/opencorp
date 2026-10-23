// Protocol schemas: connections.
import { z } from "zod"
import { ConnectionName } from "./common"

/** A model connection on this office. Never holds a key. */
export const Connection = z.strictObject({
  name: ConnectionName,
  provider: z.string(),
  method: z.enum(["api_key", "subscription", "none"]),
  model: z.string().nullable().default(null),
  default: z.boolean().default(false),
})
export type Connection = z.input<typeof Connection>

/** The connections on this office. */
export const ConnectionList = z.strictObject({
  connections: z.array(Connection),
  default: ConnectionName,
  /** Whether the asking person may add, remove or set the default. */
  can_manage: z.boolean(),
})
export type ConnectionList = z.input<typeof ConnectionList>

/** A model a connection offers; `name` is its display name when the provider gives one. */
export const ModelOption = z.strictObject({
  id: z.string(),
  name: z.string().nullable().default(null),
})
export type ModelOption = z.input<typeof ModelOption>

/**
 * A connection's models. When `listed` is false, the provider can't list models, so a model name is typed.
 */
export const ModelList = z.strictObject({
  connection: ConnectionName,
  models: z.array(ModelOption),
  listed: z.boolean(),
  error: z.string().nullable().default(null),
})
export type ModelList = z.input<typeof ModelList>

/** A model equal to the connection's own is stored as null, so it follows that connection's changes. */
export const SetModelRequest = z.strictObject({
  connection: ConnectionName,
  model: z.string().min(1),
})
export type SetModelRequest = z.input<typeof SetModelRequest>

/** A new API-key connection. The office never echoes it: a 422 names fields only. */
export const AddConnectionRequest = z.strictObject({
  provider: z.string(),
  api_key: z.string().min(1),
  /** Azure: the resource name or URL. provider openai: an OpenAI-compatible base URL. */
  endpoint: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
})
export type AddConnectionRequest = z.input<typeof AddConnectionRequest>

export const SetDefaultConnectionRequest = z.strictObject({
  connection: ConnectionName,
})
export type SetDefaultConnectionRequest = z.input<typeof SetDefaultConnectionRequest>

/** Starts a subscription sign-in that adds a connection. */
export const StartLoginRequest = z.strictObject({
  provider: z.enum(["openai"]),
})
export type StartLoginRequest = z.input<typeof StartLoginRequest>

/**
 * A subscription sign-in. While `waiting`, the human opens `url` and enters `user_code`; `connection` names
 * the new connection once `signed_in`; `message` says why it failed.
 */
export const ConnectionLogin = z.strictObject({
  id: z.string(),
  state: z.enum(["waiting", "signed_in", "failed", "cancelled"]),
  url: z.string().nullable().default(null),
  user_code: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  connection: ConnectionName.nullable().default(null),
})
export type ConnectionLogin = z.input<typeof ConnectionLogin>

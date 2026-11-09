/** The job the office hands a worker, and helpers that describe office-side tools. */
import path from "node:path"
import { validationMessage } from "@opencorp/protocol"
import { z } from "zod"

/** The reason a `stop` frame stops the run with; the worker's `error` frame then reads `Error: <reason>`. */
export const STOP_REASON = "the office stopped the run"

const emptyParameters = (): Record<string, unknown> => ({ type: "object", properties: {} })

/** A tool the office serves over the channel, as the model sees it. */
export const ToolSpec = z.strictObject({
  name: z.string(),
  description: z.string().default(""),
  parameters: z.record(z.string(), z.unknown()).default(emptyParameters),
})
export type ToolSpec = z.output<typeof ToolSpec>

// validationMessage replaces these messages with a fixed phrase; they only say what each check means.
const absolute = z.string().refine((p) => path.posix.isAbsolute(p), "must be an absolute path")

const deliveryId = z.string().min(1)
const present = z.custom<unknown>((value) => value !== undefined, "is required")

/** One yian host call the worker makes on the run, with the id its `deliver_reply` answers. */
export const Delivery = z.discriminatedUnion("op", [
  z.strictObject({ id: deliveryId, op: z.literal("send"), inbox: z.string(), event: present }),
  z.strictObject({
    id: deliveryId,
    op: z.literal("complete"),
    call_id: z.string(),
    result: z.union([z.strictObject({ output: present }), z.strictObject({ error: z.string() })]),
  }),
  z.strictObject({ id: deliveryId, op: z.literal("close"), inbox: z.string() }),
  z.strictObject({ id: deliveryId, op: z.literal("interrupt"), inbox: z.string() }),
  z.strictObject({ id: deliveryId, op: z.literal("cancel") }),
])
export type Delivery = z.output<typeof Delivery>

/** The run of the same session a fresh `chat` run replaces: its log, the env that run had, whether to cancel it. */
export const Seed = z.strictObject({ log: absolute, env: z.record(z.string(), z.string()), cancel: z.boolean() })
export type Seed = z.output<typeof Seed>

/** The run a `chat` run nests under in yian's run index, and that run's node, if one node started it. */
export const Parent = z.strictObject({ run_id: z.string().min(1), node: z.string().min(1).nullable().default(null) })
export type Parent = z.output<typeof Parent>

/**
 * What one worker runs: a flow from a pinned company worktree, and how to run it.
 *
 * `kind` is `chat` (runs the flow afresh), `advance` (moves the run `run_id` on from its log with yian's
 * `advance`, which uses the recorded flow, inputs and worker bound, so `flow`, `inputs` and `num_workers` are
 * ignored), or `check` (runs the office's one-reply model check (`install/flows/check_model.yaml`) on
 * `llm_config`, and reads no other field but `session_id`). `flow` is relative to `pin`. `deliver` lists host calls
 * applied to the run in order, each answered by one `deliver_reply`; `advance: false` applies them without moving
 * the run. `seed` names the run of the same session a fresh `chat` run replaces (its log, the env that run had,
 * whether to cancel it); the worker seeds the flow's `summary` and `history` inputs from it and moves its unread
 * messages. `parent` names the run (and node) a fresh `chat` run nests under in yian's run index; an `advance`
 * resumes a log that already records it. `memory` names the flow's memory inputs the office keeps: the worker binds
 * each, by that name, to the office's memory of the name, on the run call and every `advance`. With `keep`, a worker
 * whose run call comes back `waiting` stays up for the run's next `advance` job (`serve` says how); a `check` job
 * never keeps. A `Job` holds the provider key in `llm_config`, so it is never logged.
 */
export const Job = z
  .strictObject({
    kind: z.enum(["chat", "advance", "check"]),
    session_id: z.string(),
    run_id: z.string(),
    person: z.string(),
    pin: absolute,
    flow: z.string().refine((p) => !path.posix.isAbsolute(p), "must be relative to pin"),
    log: absolute,
    inputs: z.record(z.string(), z.unknown()).default(() => ({})),
    llm_config: z.record(z.string(), z.unknown()).nullable().default(null),
    skills: z.array(z.string()).default(() => []),
    num_workers: z.number().int().default(8),
    groups: z
      .record(z.string(), z.array(ToolSpec))
      .refine(
        (groups) => !Object.hasOwn(groups, "ask") && !Object.hasOwn(groups, "ask_user"),
        "ask and ask_user are the worker's own tools, not groups",
      )
      .default(() => ({})),
    memory: z.array(z.string()).default(() => []),
    deliver: z.array(Delivery).default(() => []),
    advance: z.boolean().default(true),
    seed: Seed.nullable().default(null),
    parent: Parent.nullable().default(null),
    keep: z.boolean().default(false),
  })
  .refine((job) => job.advance || job.kind === "advance", {
    message: "advance false needs kind advance",
    path: ["advance"],
  })
  .refine((job) => job.seed === null || job.kind === "chat", { message: "a seed needs kind chat", path: ["seed"] })
  .refine((job) => job.parent === null || job.kind === "chat", {
    message: "a parent needs kind chat",
    path: ["parent"],
  })
  .refine((job) => !job.keep || job.kind !== "check", { message: "a check job never keeps", path: ["keep"] })
export type Job = z.output<typeof Job>
export type JobInput = z.input<typeof Job>

/** A job failed validation; the message names fields only, never a value. */
export class JobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JobError"
  }
}

/** `data` as a `Job`. Throws a `JobError` with value-free text and no cause, since `data` holds the provider key. */
export function parseJob(data: unknown): Job {
  const result = Job.safeParse(data)
  if (!result.success) throw new JobError(validationMessage(Job, result.error, data))
  return result.data
}

/** The pin-relative path of a person's main flow (`main` is relative to the person directory). */
export function personFlow(handle: string, main: string): string {
  return `people/${handle}/${main}`
}

/** What an office tool declares about itself for the model. */
export interface DeclaredTool {
  readonly description?: string
  readonly parameters?: Record<string, unknown>
}

/** The spec a worker needs to offer `tool` under `name`: the declared description and JSON Schema, unchanged. */
export function toolSpec(name: string, tool: DeclaredTool): ToolSpec {
  return { name, description: tool.description ?? "", parameters: tool.parameters ?? emptyParameters() }
}

/** `Job.groups` for office tool groups given as `{group: {tool name: tool}}`, in key order. */
export function groupSpecs(groups: Record<string, Record<string, DeclaredTool>>): Record<string, ToolSpec[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, tools]) => [
      group,
      Object.entries(tools).map(([name, tool]) => toolSpec(name, tool)),
    ]),
  )
}

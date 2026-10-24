/** The job the office hands a worker, and helpers that describe office-side tools. */
import path from "node:path"
import { validationMessage } from "@opencorp/protocol"
import { z } from "zod"

const emptyParameters = (): Record<string, unknown> => ({ type: "object", properties: {} })

/** A tool the office serves over the channel, as the model sees it. */
export const ToolSpec = z.strictObject({
  name: z.string(),
  description: z.string().default(""),
  parameters: z.record(z.string(), z.unknown()).default(emptyParameters),
})
export type ToolSpec = z.output<typeof ToolSpec>

/** A Yian `ProfileMemory` over the office store named `store`. */
export const ProfileMemorySpec = z.strictObject({
  kind: z.literal("profile").default("profile"),
  store: z.string(),
  max_chars: z.number().int().default(32000),
  llm_config: z.record(z.string(), z.unknown()).nullable().default(null),
})
export type ProfileMemorySpec = z.output<typeof ProfileMemorySpec>

// validationMessage replaces these messages with a fixed phrase; they only say what each check means.
const absolute = z.string().refine((p) => path.posix.isAbsolute(p), "must be an absolute path")

/**
 * What one worker runs: a flow from a pinned company worktree, and how to run it.
 *
 * `kind` is `chat` (runs the flow afresh) or `resume` (resumes the run `run_id` from its log). `flow` is relative
 * to `pin`. A `Job` holds the provider key in `llm_config`, so it is never logged.
 */
export const Job = z.strictObject({
  kind: z.enum(["chat", "resume"]),
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
  memory: z.record(z.string(), ProfileMemorySpec).default(() => ({})),
})
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

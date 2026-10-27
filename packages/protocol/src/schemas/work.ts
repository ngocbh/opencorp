import { z } from "zod"
import { Handle, Id, Timestamp, Ulid } from "./common"

export const WorkItem = z.strictObject({
  id: Ulid,
  title: z.string().min(1),
  kind: z.enum(["task", "question"]),
  status: z.enum(["open", "in_progress", "done", "cancelled"]),
  requester: Handle,
  assignee: Handle.nullable().default(null),
  parent_id: Ulid.nullable().default(null),
  groups: z.array(Id).default(() => []),
  gate: z.boolean().default(false),
  resolved_by: Handle.nullable().default(null),
  on_behalf_of: Handle.nullable().default(null),
  summary: z.string().nullable().default(null),
  cost: z.number().min(0).default(0),
  version: z.int().min(1).default(1),
  created_at: Timestamp,
  updated_at: Timestamp,
})
export type WorkItem = z.input<typeof WorkItem>

export const Comment = z.strictObject({
  id: Ulid,
  work_item_id: Ulid,
  author: Handle,
  body: z.string(),
  on_behalf_of: Handle.nullable().default(null),
  created_at: Timestamp,
})
export type Comment = z.input<typeof Comment>

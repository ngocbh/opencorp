/** Hiring: preview a new agent's files and lint them in a scratch copy, then commit them on confirm. */
import { isDeepStrictEqual } from "node:util"
import { type HireRequest, Person as PersonSchema } from "@opencorp/protocol"
import { z } from "zod"
import { writeYaml } from "../company/flow_yaml.ts"
import { strip } from "../perm/redact.ts"

/** What a hire from the short form gets besides its name, handle, title, and manager. */
export const NEW_AGENT = {
  kind: "agent",
  main: "../../shared/flows/chat.yaml",
  harnesses: ["composer"],
  harness_policy: { sandbox: "workspace-write", network: false },
} as const

type Person = z.output<typeof PersonSchema>
type HireForm = Pick<z.output<typeof HireRequest>, "name" | "handle" | "title" | "manager">

/** The agent `request` hires and its files by repo path: person.yaml, and a profile.md headed with its name
 *  and title, followed by `about` if given. */
export function agentFiles(request: HireForm, about = ""): [Person, Record<string, string>] {
  const { name, handle, title, manager } = request
  const person = PersonSchema.parse({ name, handle, title, manager, ...NEW_AGENT })
  const base = `people/${person.handle}`
  const text = strip(about)
  const profile = `# ${person.name}, ${person.title}\n` + (text ? `\n${text}\n` : "")
  const body = withoutDefaults(PersonSchema, person)
  return [person, { [`${base}/person.yaml`]: writeYaml(body), [`${base}/profile.md`]: profile }]
}

/** `value`'s fields in `schema`'s order, each left out when equal to its default, nested objects too
 *  (pydantic's `exclude_defaults`). */
function withoutDefaults(schema: z.ZodObject, value: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    let item = value[key]
    if (field instanceof z.ZodDefault && isDeepStrictEqual(item, field.parse(undefined))) continue
    let inner: unknown = field
    while (inner instanceof z.ZodDefault || inner instanceof z.ZodNullable) inner = inner.unwrap()
    if (inner instanceof z.ZodObject && item !== null && typeof item === "object") {
      item = withoutDefaults(inner, item as Record<string, unknown>)
    }
    body[key] = item
  }
  return body
}

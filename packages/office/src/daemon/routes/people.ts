/** People routes: how the API shows a person. The roster, folder and hire routes come with their own port. */
import type { Person as PersonSchema } from "@opencorp/protocol"
import type { z } from "zod"

type Person = z.output<typeof PersonSchema>

/** `person` as the API shows them: without their password hash, which only the company repo holds. */
export function served(person: Person): Person {
  return { ...person, password_hash: null }
}

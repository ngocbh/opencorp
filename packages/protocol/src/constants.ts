import { RulePattern } from "./schemas/rules"

/** The office's own name: its own connection, set up at onboarding, the driver of the runs the office starts itself,
 *  and the author of its notes to an agent about the agent's own work (`isOfficeNote`). */
export const OFFICE = "office"

/** Whether `message` is a note from the office to the agent about the agent's own work, such as a command of its that
 *  ended: a user message whose author is `office`. Its first line says what happened; clients show that line, which
 *  opens to the whole note. */
export function isOfficeNote(message: { readonly role: string; readonly author?: string | null }): boolean {
  return message.role === "user" && message.author === OFFICE
}

/** How long, in ms, a pairing code HQ mints stays valid: HQ refuses it after, and `opencorp hq` deletes the code's
 *  redirect file then. */
export const PAIR_CODE_TTL_MS = 5 * 60_000

/** An approval card's Yes options, as the office offers and reads them and its clients pick them: Yes; with rules to
 *  add, "don't ask again this session" for those rules; and "always" for them where the host keeps always-rules. */
export const APPROVAL_YES = "Yes"
export const approvalSessionOption = (rules: readonly string[]) =>
  `Yes, and don't ask again this session for: ${rules.join(", ")}`
export const approvalAlwaysOption = (rules: readonly string[]) => `Yes, and always allow: ${rules.join(", ")}`

/** `pattern`'s words, or null when it isn't a `RulePattern` (the empty pattern has no words). Rules match by these
 *  words alone, so a pattern no rules file could hold matches nothing. */
export function ruleWords(pattern: string): string[] | null {
  if (pattern === "") return []
  return RulePattern.safeParse(pattern).success ? pattern.split(" ") : null
}

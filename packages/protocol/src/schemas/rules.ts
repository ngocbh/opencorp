import { z } from "zod"
import { Handle, Timestamp } from "./common"

/** A rule's pattern: words that hold no whitespace, one space between each; only a final `*` word is a wildcard,
 *  matching any further words (none included). */
export const RulePattern = z.string().regex(/^\S+(?: \S+)*$/u)
export type RulePattern = z.input<typeof RulePattern>

/** A rule for an agent's commands or typed input: allow, ask or deny, on a `RulePattern`. `source`: `session` rules
 *  last while the session runs; `agent` rules are the agent's file (`people/<handle>/rules.yaml`); `company` rules
 *  are `rules.yaml` at the company repo's root, for every agent. `note`: for a session rule an "always" couldn't save
 *  to the agent's file, why. */
export const Rule = z.strictObject({
  effect: z.enum(["allow", "ask", "deny"]),
  kind: z.enum(["command", "input"]),
  pattern: RulePattern,
  source: z.enum(["session", "agent", "company"]),
  by: Handle.nullable().default(null),
  at: Timestamp.nullable().default(null),
  note: z.string().nullable().default(null),
})
export type Rule = z.input<typeof Rule>

/** A rules file that exists at HEAD but doesn't load: while it is listed, every command of the sessions it
 *  covers asks (dontAsk refuses it). */
export const RuleFileError = z.strictObject({
  source: z.enum(["agent", "company"]),
  path: z.string(),
  message: z.string(),
})
export type RuleFileError = z.input<typeof RuleFileError>

/** A chat's rules, each with its source, and the rules files that don't load. */
export const RuleList = z.strictObject({ rules: z.array(Rule), errors: z.array(RuleFileError).default(() => []) })
export type RuleList = z.input<typeof RuleList>

/** The rule a chat's approver removes: a session rule, or one of the agent's file. */
export const RemoveRuleRequest = Rule.pick({ effect: true, kind: true, pattern: true, source: true })
export type RemoveRuleRequest = z.input<typeof RemoveRuleRequest>

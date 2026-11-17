/** The office's own name: its own connection, set up at onboarding, and the driver of the runs the office starts itself. */
export const OFFICE = "office"

/** How long, in ms, a pairing code HQ mints stays valid: HQ refuses it after, and `opencorp hq` deletes the code's
 *  redirect file then. */
export const PAIR_CODE_TTL_MS = 5 * 60_000

/** An approval card's Yes options, as the office offers and reads them and its clients pick them: Yes; with rules to
 *  add, "don't ask again this session" for those rules; and "always" for them where the host keeps always-rules. */
export const APPROVAL_YES = "Yes"
export const approvalSessionOption = (rules: readonly string[]) =>
  `Yes, and don't ask again this session for: ${rules.join(", ")}`
export const approvalAlwaysOption = (rules: readonly string[]) => `Yes, and always allow: ${rules.join(", ")}`

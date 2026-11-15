/** The office's own name: its own connection, set up at onboarding, and the driver of the runs the office starts itself. */
export const OFFICE = "office"

/** How long, in ms, a pairing code HQ mints stays valid: HQ refuses it after, and `opencorp hq` deletes the code's
 *  redirect file then. */
export const PAIR_CODE_TTL_MS = 5 * 60_000

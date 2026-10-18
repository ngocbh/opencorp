import { createSimpleContext } from "./helper"

/** What `opencorp` passes the TUI from its flags. */
export interface Args {
  /** Text to send as soon as the office is online (from the home screen). */
  prompt?: string
  /** Open the newest main session in cwd. */
  continue?: boolean
  /** Open this session. */
  sessionID?: string
  /** The person to talk to, by handle (with or without the @). */
  person?: string
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})

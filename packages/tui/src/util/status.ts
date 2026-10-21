import type { Session } from "@opencorp/protocol"

/** Whether Esc interrupts a session in `status`: its run is starting, working, or waiting on someone. */
export const interruptible = (status: Session["status"] | undefined) =>
  status === "starting" || status === "busy" || status === "waiting"

/** Whether a session in `status` is working, which the spinners show; a waiting one isn't. */
export const working = (status: Session["status"] | undefined) => status === "starting" || status === "busy"

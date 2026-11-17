import { SessionMode } from "@opencorp/protocol"
import { onMount } from "solid-js"
import { usePermission } from "../../context/permission"
import { DialogSelect } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"

/** What each mode lets the chat's agent do, in one line. */
const MEANING: Record<SessionMode, string> = {
  auto: "Runs read-only commands and workspace file changes; Auto's check judges the rest",
  default: "Runs read-only commands; asks before anything else",
  ask: "Asks before every command no rule allows",
  dontAsk: "Refuses whatever would ask: for runs with nobody to answer",
}

/** Picks the chat's mode from the four, the current one marked; the office switches it. */
export function DialogMode(props: { sessionID: string }) {
  const permission = usePermission()
  const dialog = useDialog()
  const toast = useToast()
  let switching = false
  // Wide enough for each mode's line on a 100-column terminal.
  onMount(() => dialog.setSize("xlarge"))

  async function pick(mode: SessionMode) {
    if (switching) return
    switching = true
    try {
      await permission.set(props.sessionID, mode)
      dialog.clear()
    } catch (e) {
      toast.show({ message: errorMessage(e), variant: "error" })
    } finally {
      switching = false
    }
  }

  return (
    <DialogSelect<SessionMode>
      title="Chat mode"
      options={SessionMode.options.map((mode) => ({ title: mode, value: mode, description: MEANING[mode] }))}
      current={permission.mode(props.sessionID) ?? undefined}
      onSelect={(option) => void pick(option.value)}
    />
  )
}

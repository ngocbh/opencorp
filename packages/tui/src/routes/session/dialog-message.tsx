import { createMemo } from "solid-js"
import { DialogSelect } from "../../ui/dialog-select"
import { useClipboard } from "../../context/clipboard"
import { useOffice } from "../../context/office"

/** Actions on one message of a session. */
export function DialogMessage(props: { messageID: string; sessionID: string }) {
  const office = useOffice()
  const message = createMemo(() => office.state.messages[props.sessionID]?.find((x) => x.id === props.messageID))
  const clipboard = useClipboard()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return
            const text = msg.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
            await clipboard.write?.(text)
            dialog.clear()
          },
        },
      ]}
    />
  )
}

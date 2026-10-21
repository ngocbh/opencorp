import { useOffice } from "../context/office"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

/** The text typed after `/cost-cap`, in any case ("" for the bare command), or undefined when `text` isn't that
 * command. */
export function costCapArgument(text: string): string | undefined {
  const m = /^\/cost-cap(?:\s+([\s\S]*))?$/i.exec(text.trim())
  return m ? (m[1] ?? "").trim() : undefined
}

/** Dollars from what a person typed ("20", "$12.50"), or undefined unless it is a positive decimal number. */
export function dollars(text: string): number | undefined {
  // Plain decimals only: Number() alone would also take "0x10", "0b11" and "1e3".
  const m = /^\$?(\d+(?:\.\d*)?|\.\d+)$/.exec(text.trim())
  const usd = m ? Number(m[1]) : 0
  return usd > 0 ? usd : undefined
}

/** Raising a session's cost cap: `raise` asks the office and says how it went; `ask` opens a dialog for the amount,
 * starting from `value`. */
export function useCostCap() {
  const office = useOffice()
  const toast = useToast()
  const dialog = useDialog()

  function raise(sessionID: string, usd: number) {
    office.client.sessions
      .costCap(sessionID, { cost_cap_usd: usd })
      .then(() => toast.show({ message: `Cost cap raised to $${usd.toFixed(2)}`, variant: "info" }))
      // The office's own words: cap_too_low says the cost so far, not_supported says why (a Codex session).
      .catch((error) => toast.show({ message: errorMessage(error), variant: "error", duration: 5000 }))
  }

  function ask(sessionID: string, value = "") {
    dialog.replace(() => (
      <DialogPrompt
        title="Raise the cost cap"
        placeholder="New cap in USD, e.g. 10"
        value={value}
        onConfirm={(text) => {
          const usd = dollars(text)
          if (usd === undefined) {
            toast.show({ message: "Enter a number of dollars, such as 10", variant: "warning" })
            return
          }
          dialog.clear()
          raise(sessionID, usd)
        }}
      />
    ))
  }

  return { raise, ask }
}

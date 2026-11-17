import type { Rule, RuleList } from "@opencorp/protocol"
import { For, createSignal, onMount } from "solid-js"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectRef } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"

/** What `d` on a company rule says: the office never changes the company's file. */
export const COMPANY_RULE = "Edit rules.yaml in the company repo to change company rules"

/** Where a rule comes from, and who added it when its file says. */
function sourceOf(rule: Rule): string {
  return rule.by ? `${rule.source}, by @${rule.by}` : rule.source
}

/**
 * The chat's rules as the office decides its commands by them: the session's, its agent's and the company's, each
 * with its source, and above them each rules file that doesn't load, while which every command asks. `d` removes a
 * session or agent rule (only the chat's approver may) and reads the list again.
 */
export function DialogRules(props: { sessionID: string }) {
  const office = useOffice()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [list, setList] = createSignal<RuleList>({ rules: [], errors: [] })
  let select: DialogSelectRef<Rule> | undefined
  let removing = false
  // Wide enough for a rule and its source on a 100-column terminal.
  onMount(() => {
    dialog.setSize("xlarge")
    void refresh()
  })

  async function refresh() {
    try {
      setList(await office.client.sessions.rules(props.sessionID))
    } catch (e) {
      toast.show({ message: errorMessage(e), variant: "error" })
    }
  }

  async function remove(rule: Rule) {
    if (rule.source === "company") {
      toast.show({ message: COMPANY_RULE, variant: "warning" })
      return
    }
    if (removing) return
    removing = true
    try {
      const { effect, kind, pattern, source } = rule
      await office.client.sessions.removeRule(props.sessionID, { effect, kind, pattern, source })
      await refresh()
    } catch (e) {
      toast.show({ message: errorMessage(e), variant: "error" })
    } finally {
      removing = false
    }
  }

  return (
    <box>
      <For each={list().errors ?? []}>
        {(error) => (
          <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
            <text fg={theme.error} wrapMode="word">
              {`${error.path} doesn't load: ${error.message}. Every command asks until a commit fixes it.`}
            </text>
          </box>
        )}
      </For>
      <DialogSelect<Rule>
        title="Rules"
        renderFilter={false}
        ref={(r) => (select = r)}
        options={list().rules.map((rule) => ({
          title: `${rule.effect.padEnd(5)}  ${rule.kind.padEnd(7)}  ${rule.pattern}`,
          truncateTitle: false,
          footer: sourceOf(rule),
          value: rule,
        }))}
        emptyView={
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
            <text fg={theme.textMuted}>No rules: the chat's mode decides each command</text>
          </box>
        }
        footerHints={[{ title: "remove", label: "d" }]}
        bindings={[
          {
            key: "d",
            desc: "Remove the rule",
            group: "Dialog",
            cmd: () => {
              const rule = select?.selected?.value
              if (rule) void remove(rule)
            },
          },
        ]}
      />
    </box>
  )
}

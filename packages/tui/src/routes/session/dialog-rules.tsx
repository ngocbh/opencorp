import type { Rule, RuleList } from "@opencorp/protocol"
import { For, Show, createSignal, onMount } from "solid-js"
import { useOffice } from "../../context/office"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../keymap"
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

/** What removing a deny or an ask rule gives up, which is asked before it goes; null for an allow rule, whose removal
 *  only makes the chat ask more. */
export function removalQuestion(rule: Rule): string | null {
  if (rule.effect === "allow") return null
  const gone = rule.effect === "deny" ? "refuses would no longer be refused" : "asks about would no longer ask"
  return `Remove the ${rule.effect} rule ${rule.pattern}? What it ${gone}. y removes it, n keeps it.`
}

/**
 * The chat's rules as the office decides its commands by them: the session's, its agent's and the company's, each
 * with its source, and above them each rules file that doesn't load, while which every command asks, and each session
 * rule an "always" couldn't save. `d` removes a session or agent rule (only the chat's approver may), a deny or an ask
 * rule once `y` confirms it, and reads the list again.
 */
export function DialogRules(props: { sessionID: string }) {
  const office = useOffice()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [list, setList] = createSignal<RuleList>({ rules: [], errors: [] })
  let select: DialogSelectRef<Rule> | undefined
  let removing = false
  /** The deny or ask rule whose removal waits on y or n. */
  const [confirming, setConfirming] = createSignal<Rule | null>(null)
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

  /** `d` on `rule`: a company rule says where it changes, a deny or an ask rule asks first, an allow rule goes. */
  function pick(rule: Rule) {
    if (confirming() !== null) return
    if (rule.source === "company") {
      toast.show({ message: COMPANY_RULE, variant: "warning" })
      return
    }
    if (removalQuestion(rule) !== null) setConfirming(rule)
    else void remove(rule)
  }

  useBindings(() => ({
    enabled: confirming() !== null,
    bindings: [
      {
        key: "y",
        desc: "Remove the rule",
        group: "Dialog",
        cmd: () => {
          const rule = confirming()
          setConfirming(null)
          if (rule) void remove(rule)
        },
      },
      ...["n", "return"].map((key) => ({
        key,
        desc: "Keep the rule",
        group: "Dialog",
        cmd: () => {
          setConfirming(null)
        },
      })),
    ],
  }))

  async function remove(rule: Rule) {
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
      <For each={list().rules.filter((rule) => rule.note)}>
        {(rule) => (
          <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
            <text fg={theme.warning} wrapMode="word">
              {`${rule.effect} ${rule.pattern} applies to this session only: ${rule.note}`}
            </text>
          </box>
        )}
      </For>
      <Show when={confirming()}>
        {(rule) => (
          <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
            <text fg={theme.warning} wrapMode="word">
              {removalQuestion(rule())}
            </text>
          </box>
        )}
      </Show>
      <DialogSelect<Rule>
        title="Rules"
        renderFilter={false}
        locked={confirming() !== null}
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
              if (rule) pick(rule)
            },
          },
        ]}
      />
    </box>
  )
}

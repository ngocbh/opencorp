import { APPROVAL_YES, approvalAlwaysOption, approvalSessionOption, type Approval } from "@opencorp/protocol"

/** How an approval card shows what it asks to allow: an icon and a title naming what would act, the body's lines,
 *  each shown whole, and, when the call's tool says what it acts on, that target (`targetText`). */
export type PermissionPresentation = {
  icon: string
  title: string
  lines: string[]
  target?: TargetText
}

/** A call's target as a card shows it: its JSON, escaped, and how many characters past `TARGET_CHARS` it leaves out
 *  (0 when it shows whole). */
export type TargetText = { text: string; more: number }

/** The most characters of a target a card shows. A card that can't show its target whole doesn't approve its call. */
export const TARGET_CHARS = 4000

/** A run of spaces a target shows as `<N spaces>`, as the office shows a command, so padding can't push the rest of a
 *  value away: four or more. */
const SPACES = / {4,}/g

/** The tools that run a command in a shell. */
const SHELLS = new Set(["shell", "workspace_shell", "terminal_run"])

/** Anything but printable ASCII, by code point (a lone surrogate on its own). */
const ODD = /[^\x20-\x7e]/gu

/** `text` with each character outside printable ASCII shown as `<U+XXXX>`, as the office shows a command, so a name
 *  or rule reads as it runs: an invisible or bidi character can't make it read otherwise. */
export function shownText(text: string): string {
  return text.replace(ODD, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`)
}

/**
 * What a card shows of `target`, a call's gate target (Yian's `GatedCall.target`, which the office derives from the
 * validated call): its JSON, whose escapes cover the C0 controls, with every other character outside printable
 * ASCII as `<U+XXXX>` and each run of four or more spaces as `<N spaces>`, cut to `TARGET_CHARS`. Null for no
 * target. It is shown only: the card's answer binds to its call id.
 */
export function targetText(target: Readonly<Record<string, unknown>> | null | undefined): TargetText | null {
  if (target == null) return null
  const shown = shownText(JSON.stringify(target)).replace(SPACES, (run) => `<${run.length} spaces>`)
  return { text: shown.slice(0, TARGET_CHARS), more: Math.max(0, shown.length - TARGET_CHARS) }
}

/**
 * The title and body of an approval of `approval.tool`. `shown` is the action as the office shows it, the card's
 * question (odd characters escaped, a script numbered), so what the owner reads is what runs:
 * - a shell command: `# Shell command`, and `$ ` before its first line;
 * - a typed line: `⌨ Type into <shell>`, the line, whether it ends without Enter, and the command it goes into;
 * - a tool card (`kind: "tool"`), whatever its tool's name, and any other tool: `⚙ Call tool <tool>`, and the action;
 *   with what its call acts on (`approval.target`) when its tool says.
 */
export function permissionPresentation(
  approval: Pick<Approval, "tool" | "args" | "partial" | "into" | "target"> & { kind?: Approval["kind"] },
  shown: string,
): PermissionPresentation {
  const lines = shown === "" ? [] : shown.split("\n")
  if (approval.kind === "tool") {
    const target = targetText(approval.target)
    return { icon: "⚙", title: `Call tool ${shownText(approval.tool)}`, lines, ...(target && { target }) }
  }
  if (SHELLS.has(approval.tool))
    return { icon: "#", title: "Shell command", lines: lines.map((line, i) => (i === 0 ? `$ ${line}` : `  ${line}`)) }
  if (approval.tool === "terminal_type") {
    const shell = typeof approval.args?.shell === "string" ? shownText(approval.args.shell) : ""
    return {
      icon: "⌨",
      title: shell ? `Type into ${shell}` : "Type into a running command",
      lines: [
        ...(lines.length > 0 ? lines : approval.partial ? [] : ["(Enter alone)"]),
        ...(approval.partial ? ["(without Enter)"] : []),
        ...(approval.into ? [`Into: ${shownText(approval.into)}`] : []),
      ],
    }
  }
  return { icon: "⚙", title: `Call tool ${shownText(approval.tool)}`, lines }
}

/** What a "don't ask again" (`session`) or "always" page says it saves, then each rule whole, one per line. */
export function permissionAlwaysLines(kind: "session" | "always", rules: readonly string[], asker: string): string[] {
  const intro =
    kind === "session"
      ? "These will run without asking for the rest of this session:"
      : `These will always run for @${asker} without asking (people/${asker}/rules.yaml):`
  return [intro, ...rules.map((rule) => `- ${shownText(rule)}`)]
}

/** A card's Yes choices among its own `options`, by the protocol's labels for its `rules`: Yes, and "don't ask
 *  again" and "always" when the card offers them for those rules. Any other label is never offered. */
export function permissionOptions(
  options: readonly string[],
  rules: readonly string[],
): { yes?: string; session?: string; always?: string } {
  const offered = (label: string) => (options.includes(label) ? label : undefined)
  const yes = offered(APPROVAL_YES)
  const session = rules.length > 0 ? offered(approvalSessionOption(rules)) : undefined
  const always = rules.length > 0 ? offered(approvalAlwaysOption(rules)) : undefined
  return { ...(yes ? { yes } : {}), ...(session ? { session } : {}), ...(always ? { always } : {}) }
}

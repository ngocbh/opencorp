import { APPROVAL_YES, approvalAlwaysOption, approvalSessionOption, type Approval } from "@opencorp/protocol"

/** How an approval card shows what it asks to allow: an icon and a title naming what would act, and the body's
 *  lines, each shown whole. */
export type PermissionPresentation = {
  icon: string
  title: string
  lines: string[]
}

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
 * The title and body of an approval of `approval.tool`. `shown` is the action as the office shows it, the card's
 * question (odd characters escaped, a script numbered), so what the owner reads is what runs:
 * - a shell command: `# Shell command`, and `$ ` before its first line;
 * - a typed line: `⌨ Type into <shell>`, the line, whether it ends without Enter, and the command it goes into;
 * - any other tool: `⚙ Call tool <tool>`, and the action.
 */
export function permissionPresentation(
  approval: Pick<Approval, "tool" | "args" | "partial" | "into">,
  shown: string,
): PermissionPresentation {
  const lines = shown === "" ? [] : shown.split("\n")
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

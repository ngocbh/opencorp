import stripAnsi from "strip-ansi"

/** `text` without control characters, which could move the cursor or retitle the terminal; tabs and newlines stay. */
export function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
}

/**
 * Text from the office (model output, questions, names) as the TUI draws it: terminal sequences go whole, so a
 * colour code leaves no "[31m" behind, then any control character left.
 */
export function display(text: string): string {
  return printable(stripAnsi(text))
}

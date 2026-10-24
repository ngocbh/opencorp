/** The `fake` asset kind, for tests and demos: `echo` returns its text. */
import type { KindTool } from "./registry.ts"

/** Returns `text` unchanged. */
export function echo(_asset: unknown, args: Record<string, unknown>, _secrets: ReadonlyMap<string, string>): unknown {
  return args.text
}

export const TOOLS: Readonly<Record<string, KindTool>> = {
  echo: {
    run: echo,
    description: "Echo the text back.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
}

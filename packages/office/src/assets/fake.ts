/** The `fake` asset kind, for tests and demos: `echo` returns its text. */
import type { Asset as AssetSchema } from "@opencorp/protocol"
import type { z } from "zod"
import type { KindTool } from "./registry.ts"

type Asset = z.output<typeof AssetSchema>

/** Returns `text` unchanged. */
export function echo(_asset: Asset, args: Record<string, unknown>, _secrets: ReadonlyMap<string, string>): unknown {
  return args.text
}

export const TOOLS: Readonly<Record<string, KindTool>> = {
  echo: {
    run: echo,
    description: "Echo the text back.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
}

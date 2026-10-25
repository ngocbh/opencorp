/** Office extensions: each has `register(office)`, called once at start-up. */
import type { Office } from "../daemon/office.ts"
import * as questions from "./questions.ts"

/** One office extension: `register` hooks it into the office once, at start-up. */
export interface Extension {
  name: string
  register(office: Office): void
}

/** An extension failed to load; the message names it and the cause is the error it threw. */
export class ExtensionError extends Error {
  override name = "ExtensionError"
}

/** The office's extensions, in the order they register (an explicit list, no folder discovery). */
export const EXTENSIONS: readonly Extension[] = [{ name: "questions", register: questions.register }]

/** Calls each extension's `register(office)` in list order; returns the names registered. The first that
 *  throws stops loading with an `ExtensionError` naming it; an `ExtensionError` it throws passes through. */
export function loadExtensions(office: Office, extensions: readonly Extension[] = EXTENSIONS): string[] {
  const loaded: string[] = []
  for (const extension of extensions) {
    try {
      extension.register(office)
    } catch (error) {
      if (error instanceof ExtensionError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new ExtensionError(`extension ${extension.name}: ${message}`, { cause: error })
    }
    loaded.push(extension.name)
  }
  return loaded
}

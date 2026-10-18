import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerOpenCorpSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}

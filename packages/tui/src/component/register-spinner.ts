import { extend, getComponentCatalogue } from "@opentui/solid/components"
import { SpinnerRenderable } from "./spinner-renderable"

export function registerOpenCorpSpinner() {
  if (!getComponentCatalogue().spinner) extend({ spinner: SpinnerRenderable })
}

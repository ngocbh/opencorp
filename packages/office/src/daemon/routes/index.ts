/** The office's routes, one module per area. */
import type { Route } from "../http.ts"
import type { RequestContext } from "../office.ts"
import { ROUTES as deviceRoutes } from "./devices.ts"
import { eventRoutes } from "./events.ts"
import { ROUTES as runRoutes } from "./runs.ts"
import { ROUTES as workItemRoutes } from "./work_items.ts"

/** Every route the office socket serves; each route area adds its module. `pingMs` sets the event stream's idle
 *  ping. */
export function allRoutes({ pingMs }: { pingMs?: number } = {}): Route<RequestContext>[] {
  return [...eventRoutes(pingMs), ...deviceRoutes, ...workItemRoutes, ...runRoutes]
}

/** The office's routes, one module per area. */
import { ROUTES as hqSocketRoutes } from "../../hq/socket_routes.ts"
import type { Route } from "../http.ts"
import type { RequestContext } from "../office.ts"
import { ROUTES as connectionRoutes } from "./connections.ts"
import { ROUTES as costRoutes } from "./costs.ts"
import { ROUTES as deviceRoutes } from "./devices.ts"
import { eventRoutes } from "./events.ts"
import { ROUTES as peopleRoutes } from "./people.ts"
import { ROUTES as profileRoutes } from "./profiles.ts"
import { ROUTES as runRoutes } from "./runs.ts"
import { ROUTES as workItemRoutes } from "./work_items.ts"

/** Every route the office socket serves; each route area adds its module. `pingMs` sets the event stream's idle
 *  ping. */
export function allRoutes({ pingMs }: { pingMs?: number } = {}): Route<RequestContext>[] {
  return [
    ...eventRoutes(pingMs),
    ...deviceRoutes,
    ...peopleRoutes,
    ...workItemRoutes,
    ...profileRoutes,
    ...costRoutes,
    ...runRoutes,
    ...connectionRoutes,
    ...hqSocketRoutes,
  ]
}

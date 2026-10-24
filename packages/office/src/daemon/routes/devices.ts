/** Identity routes: the office's liveness probe and process info, who a request acts as, logging in, and humans'
 *  devices and passwords. */
import {
  AddDeviceRequest,
  DeviceName,
  LoginRequest,
  Person as PersonSchema,
  SetPasswordRequest,
} from "@opencorp/protocol"
import type { z } from "zod"
import { DeviceRefused, addDevice, login, removeDevice, setPassword } from "../../auth/devices.ts"
import { actingPerson } from "../auth.ts"
import { HttpError, type Route } from "../http.ts"
import type { RequestContext } from "../office.ts"
import { served } from "./people.ts"

type Person = z.output<typeof PersonSchema>

/** `{person: handle, device: name | null}`: who this request acts as, and from which device. */
export function whoami(ctx: RequestContext): { person: string; device: string | null } {
  return { person: actingPerson(ctx), device: ctx.device }
}

/** The person `change` leaves, as served; a `DeviceRefused` is its HTTP error. */
async function refusable(change: Promise<Person>): Promise<Person> {
  try {
    return served(await change)
  } catch (error) {
    if (error instanceof DeviceRefused) throw new HttpError(error.status, error.code, error.message)
    throw error
  }
}

/** The identity routes. */
export const ROUTES: readonly Route<RequestContext>[] = [
  // `{"ok": true}`, exactly: the office is answering. Served without a token.
  { method: "GET", path: "/health", handler: () => ({ ok: true }) },
  { method: "GET", path: "/whoami", handler: whoami },
  // Adds a device to a human's `person.yaml` and commits it; the person afterwards.
  {
    method: "POST",
    path: "/people/:handle/devices",
    body: AddDeviceRequest,
    reply: PersonSchema,
    handler: (ctx, params, body) => {
      const { name, token_sha256 } = body as AddDeviceRequest
      return refusable(addDevice(ctx.office.git, params.handle!, { name, token_sha256 }, actingPerson(ctx)))
    },
  },
  // Removes a device, by name, from a human's `person.yaml` and commits it; the person afterwards.
  {
    method: "DELETE",
    path: "/people/:handle/devices/:name",
    reply: PersonSchema,
    handler: (ctx, params) => {
      const actor = actingPerson(ctx)
      const handle = params.handle!
      // The name would end up in the 404 text and the commit subject; one no device can have reaches neither.
      if (!DeviceName.safeParse(params.name).success) {
        throw new HttpError(404, "not_found", `@${handle} has no device by that name`)
      }
      return refusable(removeDevice(ctx.office.git, handle, params.name!, actor))
    },
  },
  // Adds a device for a human who gives their password and commits it; the person afterwards. Served without a
  // token (in `OPEN`). `login` already spends one password check on an unknown handle or an agent, so the time
  // taken doesn't tell them apart; the route adds none.
  {
    method: "POST",
    path: "/login",
    body: LoginRequest,
    reply: PersonSchema,
    handler: (ctx, _params, body) => refusable(login(ctx.office.git, body as LoginRequest)),
  },
  // Sets a human's password, committing only its hash; the person afterwards.
  {
    method: "PUT",
    path: "/people/:handle/password",
    body: SetPasswordRequest,
    reply: PersonSchema,
    handler: (ctx, params, body) => {
      const { password } = body as SetPasswordRequest
      return refusable(setPassword(ctx.office.git, params.handle!, password, actingPerson(ctx)))
    },
  },
]

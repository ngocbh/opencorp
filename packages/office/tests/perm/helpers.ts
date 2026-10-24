/** Monitor test helpers (Python's perm conftest): a company repo, a store, a secret store, and test asset kinds. */
import fs from "node:fs"
import path from "node:path"
import { stringify } from "yaml"
import { TOOLS } from "../../src/assets/fake.ts"
import type { Kinds } from "../../src/assets/registry.ts"
import { Monitor } from "../../src/perm/monitor.ts"
import { SecretStore } from "../../src/secrets.ts"
import type { Store } from "../../src/store/store.ts"
import { makeCompany } from "../company/helpers.ts"
import { tempDir } from "../helpers.ts"
import { openStore } from "../store/helpers.ts"

export const TOKEN = "s3cr3t-t0ken-value"

/** The error the Python kinds raise, named as Python names it. */
export class RuntimeError extends Error {
  override name = "RuntimeError"
}

/** A kind tool that needs its secret, and would leak it if the office let it. A missing arg reads `None`, as
 *  Python's f-string writes it. */
function useKey(_asset: unknown, args: Record<string, unknown>, secrets: ReadonlyMap<string, string>): string {
  if (secrets.get("vault_token") !== TOKEN) throw new RuntimeError("no token")
  return `ran ${args.job ?? "None"} on ${args.partition ?? "None"} with ${secrets.get("vault_token")}`
}

function boom(_asset: unknown, _args: Record<string, unknown>, secrets: ReadonlyMap<string, string>): never {
  throw new RuntimeError(`cannot reach host (token ${secrets.get("vault_token")})`)
}

export const KINDS: Kinds = {
  fake: TOOLS,
  cluster: {
    submit_job: {
      run: useKey,
      description: "Submit a job.",
      parameters: {
        type: "object",
        properties: { job: { type: "string" }, partition: { type: "string" }, vault_token: { type: "string" } },
        required: ["job"],
      },
    },
    read_logs: { run: () => "logs" },
    delete_data: { run: () => "deleted" },
    broken: { run: boom },
  },
}

/** The `cluster-a` asset file with `grants`, overridden by `over`. */
export function cluster(grants: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cluster-a",
    kind: "cluster",
    secrets: ["vault_token"],
    grants,
    tools: { submit_job: {}, read_logs: {}, delete_data: { risk: "gated" }, broken: {} },
    ...over,
  }
}

/** A secret store at `<tmp>/office/secrets` holding `vault_token = TOKEN`. Call inside a test. */
export async function makeSecrets(): Promise<SecretStore> {
  const secrets = new SecretStore(path.join(tempDir(), "office", "secrets"))
  await secrets.set("vault_token", TOKEN)
  return secrets
}

/** A monitor over a company of the base files with `files` applied, with a fresh store and secret store, which it
 *  returns too. Call inside a test. */
export async function makeMonitor(
  files: Record<string, unknown> = {},
  kinds: Kinds = KINDS,
): Promise<{ monitor: Monitor; store: Store; secrets: SecretStore }> {
  const store = openStore()
  const secrets = await makeSecrets()
  return { monitor: new Monitor(makeCompany(files), store, secrets, kinds), store, secrets }
}

/** Writes `content` as YAML to repo path `rel` under `root`. */
export function setFile(root: string, rel: string, content: unknown): void {
  fs.writeFileSync(path.join(root, rel), stringify(content))
}

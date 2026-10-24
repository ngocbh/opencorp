/** Sandbox test helpers (Python's sandbox conftest fixtures). */
import fs from "node:fs"
import path from "node:path"
import { type Helper, type OfficePaths, SandboxPolicy } from "../../src/sandbox/policy.ts"
import { tempDir } from "../helpers.ts"

/** A fresh `ws` and `tmp` under one temp dir (removed after the test), and `make`, which builds policies over them. */
export function makePolicy(): {
  root: string
  ws: string
  tmp: string
  make(opts?: {
    writable?: boolean
    network?: boolean
    readOnly?: readonly string[]
    helper?: Helper
    office?: OfficePaths
  }): SandboxPolicy
} {
  const root = tempDir()
  const ws = path.join(root, "ws")
  const tmp = path.join(root, "tmp")
  fs.mkdirSync(ws)
  fs.mkdirSync(tmp)
  return {
    root,
    ws,
    tmp,
    make: ({ writable = true, network = false, readOnly = [], helper, office } = {}) =>
      new SandboxPolicy({ workspace: ws, writable, network, tmpdir: tmp, readOnly, helper, office }),
  }
}

/** A policy with exactly these (already real) paths and no disk checks, for golden profiles. */
export function goldenPolicy(fields: {
  workspace: string
  writable: boolean
  network: boolean
  tmpdir: string
  readOnly?: readonly string[]
  install?: readonly string[]
  helper?: Helper
}): SandboxPolicy {
  return Object.assign(Object.create(SandboxPolicy.prototype), {
    workspace: fields.workspace,
    writable: fields.writable,
    network: fields.network,
    tmpdir: fields.tmpdir,
    readOnly: fields.readOnly ?? [],
    helper: fields.helper,
    office: { home: "/Users/me", install: fields.install ?? [], tools: [], path: [] },
  })
}

/** Offboarding this machine: what it finds, what it asks, what it removes and keeps, and the launchers it reports. */
import fs from "node:fs"
import path from "node:path"
import { expect, test } from "bun:test"
import { launchers } from "../../src/install/offboard.ts"
import { tempDir } from "../helpers.ts"

test("launchers finds another name and entry", () => {
  const dir = tempDir()
  const repo = path.join(dir, "repo")
  const bin = path.join(dir, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "old"), `#!/bin/bash\nexec bun ${repo}/packages/old/main.ts "$@"\n`)
  fs.writeFileSync(path.join(bin, "opencorp"), `#!/bin/bash\nexec bun ${repo}/packages/cli/src/main.ts "$@"\n`)
  const found = launchers({ PATH: bin }, repo, { name: "old", entries: [path.join("packages", "old", "main.ts")] })
  expect(found).toEqual([path.join(bin, "old")])
})

test("launchers finds a link to the checkout wrapper and a script naming it", () => {
  const dir = tempDir()
  const repo = path.join(dir, "checkout")
  const wrapper = path.join(repo, "packages", "cli", "bin", "opencorp")
  const other = path.join(dir, "checkout2", "packages", "cli", "bin", "opencorp")
  for (const file of [wrapper, other]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "#!/bin/sh\n")
  }
  const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => path.join(dir, name)) as [string, string, string, string]
  for (const folder of [a, b, c, d]) fs.mkdirSync(folder)
  fs.symlinkSync(wrapper, path.join(a, "opencorp"))
  fs.writeFileSync(path.join(b, "opencorp"), `#!/bin/sh\nexec ${repo}/packages/cli/bin/opencorp "$@"\n`)
  fs.writeFileSync(path.join(c, "opencorp"), "#!/bin/sh\necho hello\n")
  fs.symlinkSync(other, path.join(d, "opencorp"))
  const found = launchers({ PATH: [a, b, c, d].join(":") }, repo)
  expect(found).toEqual([path.join(a, "opencorp"), path.join(b, "opencorp")])
})

import { expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"

test("nothing imports the OpenCode SDK", async () => {
  const root = path.join(import.meta.dir, "..")
  const hits: string[] = []
  for await (const file of new Glob("{src,script,test}/**/*.{ts,tsx}").scan(root)) {
    const text = await Bun.file(path.join(root, file)).text()
    if (/from ["']@opencode-ai\/sdk/.test(text)) hits.push(file)
  }
  expect(hits).toEqual([])
  const pkg = await Bun.file(path.join(root, "package.json")).json()
  expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain("@opencode-ai/sdk")
})

/** A terminal's record: what the model saw, the commands it ran with their exits, and the shell's state. */
import fs from "node:fs"
import path from "node:path"
import { expect, spyOn, test } from "bun:test"
import { ModelView } from "../../../src/tools/terminal/output.ts"
import { PrivateFileError } from "../../../src/util/private_files.ts"
import { InstrumentRecord, recoverRecords, type RecordMeta } from "../../../src/tools/terminal/record.ts"
import { tempDir } from "../../helpers.ts"

const META: RecordMeta = {
  id: "sh_1",
  name: "shell 1",
  kind: "terminal",
  profile: "workspace",
  driver: "@minh",
  started: "2026-11-17T09:00:00.000Z",
}

/** A record's meta.json, parsed. */
const metaOf = (dir: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"))

/** A record's output.log. */
const outputOf = (dir: string): string => fs.readFileSync(path.join(dir, "output.log"), "utf8")

/** The whole of `view`'s text. */
const textOf = (view: ModelView): string => view.page(0, view.length + 1).output

const mode = (p: string): number => fs.statSync(p).mode & 0o777

/** Adds `raw` to `view`, and the text that adds to the view to `record`. No line here is redrawn, so the view's
 *  text only grows. */
function feed(view: ModelView, record: InstrumentRecord, raw: string): void {
  const from = view.length
  view.append(raw)
  record.append(view.page(from, view.length - from + 1).output)
}

test("a record keeps what the model saw and the commands with their exits", () => {
  const dir = path.join(tempDir(), "instruments", "sh_1")
  const record = new InstrumentRecord(dir, META)
  expect(metaOf(dir)).toEqual({ ...META, state: "running", commands: [] })

  const view = new ModelView()
  record.command("echo hi; false", "@minh")
  feed(view, record, "$ echo hi; false\r\n\x1b[32mhi\x1b[0m\r\n")
  record.exit(1)
  record.command("sleep 300", "@minh")
  feed(view, record, "$ sleep 300\r\n^C\r\n")
  record.exit(130)
  // An exit with no command of the record's open, as when the owner's command ends, changes nothing.
  record.exit(0)
  record.command("kill -9 $$", "@minh")
  feed(view, record, "$ kill -9 $$\r\n")
  record.exit(null)
  record.end("ended")

  expect(metaOf(dir)).toEqual({
    ...META,
    state: "ended",
    ended: expect.any(String),
    commands: [
      { command: "echo hi; false", by: "@minh", at: expect.any(String), exit: 1 },
      { command: "sleep 300", by: "@minh", at: expect.any(String), exit: 130 },
      { command: "kill -9 $$", by: "@minh", at: expect.any(String), exit: null },
    ],
  })
  expect(outputOf(dir)).toBe(textOf(view))
  expect(outputOf(dir)).toBe("$ echo hi; false\nhi\n$ sleep 300\n^C\n$ kill -9 $$\n")

  // An ended record changes no more.
  record.append("late\n")
  record.command("true", "@minh")
  record.end("failed", "too late")
  expect(outputOf(dir)).toBe(textOf(view))
  expect(metaOf(dir).state).toBe("ended")
  expect(metaOf(dir).commands).toHaveLength(3)

  const failed = path.join(tempDir(), "sh_2")
  new InstrumentRecord(failed, { ...META, id: "sh_2" }).end("failed", "the PTY wouldn't open")
  expect(metaOf(failed)).toMatchObject({ state: "failed", error: "the PTY wouldn't open", commands: [] })
  expect(outputOf(failed)).toBe("")
})

test("a record keeps what the screen showed, echoed input included, and no keystrokes", () => {
  const dir = path.join(tempDir(), "sh_1")
  const record = new InstrumentRecord(dir, META)
  const view = new ModelView()
  record.command("cat", "@minh")
  feed(view, record, "$ cat\r\n")
  // The owner types a line: the terminal echoes it, and cat prints it back.
  feed(view, record, "owner-typed-text\r\n")
  feed(view, record, "owner-typed-text\r\n")
  record.exit(0)
  // At an echo-off prompt the owner's password reaches the program and never the screen: only the prompt shows.
  record.command("read -s -p 'Password: ' pw; echo; echo done", "@minh")
  feed(view, record, "$ read -s -p 'Password: ' pw; echo; echo done\r\nPassword: ")
  feed(view, record, "\r\ndone\r\n")
  record.exit(0)
  record.end("ended")

  expect(outputOf(dir)).toBe(textOf(view))
  expect(outputOf(dir).split("owner-typed-text\n")).toHaveLength(3)
  expect(outputOf(dir)).toContain("Password: \ndone\n")
  expect(fs.readdirSync(dir).sort()).toEqual(["meta.json", "output.log"])
})

test("a record left running when its host stopped is marked interrupted on the next start", () => {
  const session = tempDir()
  const left = new InstrumentRecord(path.join(session, "sh_1"), META)
  left.command("make", "@minh")
  left.append("$ make\nbuilding\n")
  const ended = new InstrumentRecord(path.join(session, "sh_2"), { ...META, id: "sh_2" })
  ended.end("ended")
  const failed = new InstrumentRecord(path.join(session, "sh_3"), { ...META, id: "sh_3" })
  failed.end("failed", "no sandbox")
  // The session folder's other files and folders aren't records.
  fs.writeFileSync(path.join(session, "checks.jsonl"), "{}\n")
  fs.mkdirSync(path.join(session, "checks"))
  fs.mkdirSync(path.join(session, "run"), { mode: 0o700 })
  fs.writeFileSync(path.join(session, "run", "meta.json"), '{"state":"running"}')
  fs.mkdirSync(path.join(session, "broken"), { mode: 0o700 })
  fs.writeFileSync(path.join(session, "broken", "meta.json"), "{not json")

  recoverRecords(session)

  expect(metaOf(path.join(session, "sh_1"))).toEqual({
    ...META,
    state: "interrupted",
    commands: [{ command: "make", by: "@minh", at: expect.any(String) }],
  })
  expect(outputOf(path.join(session, "sh_1"))).toBe("$ make\nbuilding\n")
  expect(metaOf(path.join(session, "sh_2")).state).toBe("ended")
  expect(metaOf(path.join(session, "sh_3"))).toMatchObject({ state: "failed", error: "no sandbox" })
  expect(fs.readFileSync(path.join(session, "run", "meta.json"), "utf8")).toBe('{"state":"running"}')
  expect(fs.readFileSync(path.join(session, "broken", "meta.json"), "utf8")).toBe("{not json")
  expect(fs.readdirSync(path.join(session, "sh_1")).sort()).toEqual(["meta.json", "output.log"])

  // A host with no session folder yet has nothing to recover.
  recoverRecords(path.join(session, "missing"))
})

test("meta.json is private to the owner", () => {
  const dir = path.join(tempDir(), "sh_1")
  const record = new InstrumentRecord(dir, META)
  expect(mode(dir)).toBe(0o700)
  expect(mode(path.join(dir, "meta.json"))).toBe(0o600)
  expect(mode(path.join(dir, "output.log"))).toBe(0o600)
  record.command("ls", "@minh")
  record.exit(0)
  expect(mode(path.join(dir, "meta.json"))).toBe(0o600)
  recoverRecords(path.dirname(dir))
  expect(mode(path.join(dir, "meta.json"))).toBe(0o600)

  // Never through a symlink, never over another record.
  const elsewhere = tempDir()
  const link = path.join(tempDir(), "sh_1")
  fs.symlinkSync(elsewhere, link)
  expect(() => new InstrumentRecord(link, META)).toThrow(PrivateFileError)
  expect(fs.readdirSync(elsewhere)).toEqual([])
  expect(() => new InstrumentRecord(dir, META)).toThrow(/EEXIST/)
  expect(metaOf(dir).commands).toHaveLength(1)
})

test("a record that can't write its output says so in meta.json, and the shell goes on", () => {
  const dir = path.join(tempDir(), "sh_1")
  const record = new InstrumentRecord(dir, META)
  record.append("before\n")
  const write = spyOn(fs, "writeSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })
  })
  try {
    expect(() => record.append("lost\n")).not.toThrow()
  } finally {
    write.mockRestore()
  }
  record.append("after\n")
  record.command("true", "@minh")
  record.exit(0)
  record.end("ended")
  expect(outputOf(dir)).toBe("before\n")
  expect(metaOf(dir)).toMatchObject({
    state: "ended",
    outputError: "ENOSPC: no space left on device, write",
    commands: [{ command: "true", exit: 0 }],
  })
})

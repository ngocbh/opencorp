/** A terminal's record: what the model saw, the commands it ran with their exits, and the shell's state. */
import fs from "node:fs"
import path from "node:path"
import { expect, spyOn, test } from "bun:test"
import { ModelView } from "../../../src/tools/terminal/output.ts"
import { PrivateFileError } from "../../../src/util/private_files.ts"
import {
  InstrumentRecord,
  META_MAX,
  RecordError,
  readRecord,
  recoverRecords,
  type RecordFile,
  type RecordMeta,
} from "../../../src/tools/terminal/record.ts"
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

/** A full disk's error. */
const enospc = (): Error => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })

/** A new record in `dir`, following a new view. */
function recordOf(dir: string, meta: RecordMeta = META): { record: InstrumentRecord; view: ModelView } {
  const record = new InstrumentRecord(dir, meta)
  const view = new ModelView()
  record.follow(view)
  return { record, view }
}

test("a record keeps what the model saw and the commands with their exits", () => {
  const dir = path.join(tempDir(), "instruments", "sh_1")
  const { record, view } = recordOf(dir)
  expect(metaOf(dir)).toEqual({ ...META, state: "running", commands: [] })

  record.command("echo hi; false", "@minh")
  view.append("$ echo hi; false\r\n\x1b[32mhi\x1b[0m\r\n")
  record.exit(1)
  record.command("sleep 300", "@minh")
  view.append("$ sleep 300\r\n^C\r\n")
  record.exit(130)
  // An exit with no command of the record's open, as when the owner's command ends, changes nothing.
  record.exit(0)
  record.command("kill -9 $$", "@minh")
  view.append("$ kill -9 $$\r\n")
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
  expect(readRecord(dir)).toEqual(metaOf(dir) as never)
  expect(outputOf(dir)).toBe(textOf(view))
  expect(outputOf(dir)).toBe("$ echo hi; false\nhi\n$ sleep 300\n^C\n$ kill -9 $$\n")

  // An ended record changes no more.
  view.append("late\n")
  record.command("true", "@minh")
  record.end("failed", "too late")
  expect(outputOf(dir)).toBe("$ echo hi; false\nhi\n$ sleep 300\n^C\n$ kill -9 $$\n")
  expect(metaOf(dir).state).toBe("ended")
  expect(metaOf(dir).commands).toHaveLength(3)

  const failed = path.join(tempDir(), "sh_2")
  new InstrumentRecord(failed, { ...META, id: "sh_2" }).end("failed", "the PTY wouldn't open")
  expect(metaOf(failed)).toMatchObject({ state: "failed", error: "the PTY wouldn't open", commands: [] })
  expect(outputOf(failed)).toBe("")
  // A record follows one view, from its start.
  const used = new ModelView()
  used.append("before\n")
  expect(() => new InstrumentRecord(path.join(tempDir(), "sh_3"), META).follow(used)).toThrow()
})

test("a record keeps what the screen showed, echoed input included, and no keystrokes", () => {
  const dir = path.join(tempDir(), "sh_1")
  const { record, view } = recordOf(dir)
  record.command("cat", "@minh")
  view.append("$ cat\r\n")
  // The owner types a line: the terminal echoes it, and cat prints it back.
  view.append("owner-typed-text\r\n")
  view.append("owner-typed-text\r\n")
  record.exit(0)
  // At an echo-off prompt the owner's password reaches the program and never the screen: only the prompt shows.
  record.command("read -s -p 'Password: ' pw; echo; echo done", "@minh")
  view.append("$ read -s -p 'Password: ' pw; echo; echo done\r\nPassword: ")
  view.append("\r\ndone\r\n")
  record.exit(0)
  record.end("ended")

  expect(outputOf(dir)).toBe(textOf(view))
  expect(outputOf(dir).split("owner-typed-text\n")).toHaveLength(3)
  expect(outputOf(dir)).toContain("Password: \ndone\n")
  expect(fs.readdirSync(dir).sort()).toEqual(["meta.json", "output.log"])
})

test("a redrawn line is in the record once, as it ended, and the record is the view's text at its offsets", () => {
  const dir = path.join(tempDir(), "sh_1")
  const { record, view } = recordOf(dir)
  view.append("$ make\r\n")
  view.append("progress 10%")
  view.append("\rprogress 50%")
  // The unfinished line can still be redrawn, so it waits.
  expect(outputOf(dir)).toBe("$ make\n")
  view.append("\rprogress 100%\r\ndone\r\n> ")
  expect(outputOf(dir)).toBe("$ make\nprogress 100%\ndone\n")
  // At the end, the unfinished last line goes in as it is.
  record.end("ended")
  expect(outputOf(dir)).toBe("$ make\nprogress 100%\ndone\n> ")
  expect(outputOf(dir)).toBe(textOf(view))
  expect(outputOf(dir).match(/progress/g)).toHaveLength(1)

  // A line too long to keep: its head goes in the record as it leaves memory, so a page that says output was
  // skipped finds it in the record at the same offsets, before a redraw and after.
  const long = path.join(tempDir(), "sh_2")
  const big = recordOf(long, { ...META, id: "sh_2" })
  big.view.append("$ cat blob\r\n")
  for (let i = 0; i < 96; i++) big.view.append("a".repeat(64 * 1024))
  const cut = big.view.page(0, big.view.length + 1)
  expect(cut.skipped).toBeDefined()
  const dropped = big.view.length - cut.output.length
  expect(outputOf(long)).toBe(`$ cat blob\n${"a".repeat(dropped - 11)}`)
  big.view.append("\rshort\r\n")
  big.record.end("ended")
  const page = big.view.page(0, big.view.length + 1)
  expect(page.output).toBe("short\n")
  expect(outputOf(long).length).toBe(big.view.length)
  expect(outputOf(long).slice(dropped)).toBe(page.output)
  expect(outputOf(long)).toBe(`$ cat blob\n${"a".repeat(dropped - 11)}short\n`)
})

test("a record left running when its host stopped is marked interrupted on the next start", () => {
  const session = tempDir()
  const left = recordOf(path.join(session, "sh_1"))
  left.record.command("make", "@minh")
  left.view.append("$ make\r\nbuilding\r\n")
  new InstrumentRecord(path.join(session, "sh_2"), { ...META, id: "sh_2" }).end("ended")
  new InstrumentRecord(path.join(session, "sh_3"), { ...META, id: "sh_3" }).end("failed", "no sandbox")
  // Files, and folders that aren't private or hold no meta.json, are no record's.
  fs.writeFileSync(path.join(session, "checks.jsonl"), "{}\n")
  fs.mkdirSync(path.join(session, "checks"))
  fs.mkdirSync(path.join(session, "empty"), { mode: 0o700 })
  // A meta.json that isn't a record's is reported and left as it is.
  const odd = (name: string, write: (file: string) => void): string => {
    fs.mkdirSync(path.join(session, name), { mode: 0o700 })
    write(path.join(session, name, "meta.json"))
    return path.join(session, name)
  }
  const run = odd("run", (file) => fs.writeFileSync(file, '{"state":"running"}'))
  const broken = odd("broken", (file) => fs.writeFileSync(file, "{not json"))
  // Sparse: its size is over the cap, and nothing reads it.
  const huge = odd("huge", (file) => {
    fs.writeFileSync(file, JSON.stringify({ ...META, state: "running", commands: [] }))
    fs.truncateSync(file, META_MAX + 1)
  })

  const problems = recoverRecords(session)

  expect(problems.sort()).toEqual(
    [
      `${run}: its meta.json isn't a terminal's record`,
      `${broken}: its meta.json isn't JSON`,
      `${huge}: its meta.json is over 64 MiB`,
    ].sort(),
  )
  expect(metaOf(path.join(session, "sh_1"))).toEqual({
    ...META,
    state: "interrupted",
    commands: [{ command: "make", by: "@minh", at: expect.any(String) }],
  })
  expect(outputOf(path.join(session, "sh_1"))).toBe("$ make\nbuilding\n")
  expect(metaOf(path.join(session, "sh_2")).state).toBe("ended")
  expect(metaOf(path.join(session, "sh_3"))).toMatchObject({ state: "failed", error: "no sandbox" })
  expect(fs.readFileSync(path.join(run, "meta.json"), "utf8")).toBe('{"state":"running"}')
  expect(fs.readFileSync(path.join(broken, "meta.json"), "utf8")).toBe("{not json")
  expect(fs.statSync(path.join(huge, "meta.json")).size).toBe(META_MAX + 1)
  expect(fs.readdirSync(path.join(session, "sh_1")).sort()).toEqual(["meta.json", "output.log"])

  // readRecord is the one way in: null for no record, an error for a meta.json that isn't one.
  expect(readRecord(path.join(session, "sh_1"))?.state).toBe("interrupted")
  expect(readRecord(path.join(session, "checks.jsonl"))).toBeNull()
  expect(readRecord(path.join(session, "empty"))).toBeNull()
  expect(readRecord(path.join(session, "missing"))).toBeNull()
  expect(() => readRecord(huge)).toThrow(RecordError)
  // A host with no session folder yet has nothing to recover.
  expect(recoverRecords(path.join(session, "missing"))).toEqual([])
})

test("recovery hands its host each record it marks interrupted, with the commands still running when it stopped", () => {
  const session = tempDir()
  const left = new InstrumentRecord(path.join(session, "sh_1"), { ...META, id: "sh_1" })
  left.command("ls", "@minh")
  left.exit(0)
  left.command("make", "@minh")
  new InstrumentRecord(path.join(session, "sh_2"), { ...META, id: "sh_2" }).end("ended")
  const handed: RecordFile[] = []
  expect(recoverRecords(session, (file) => void handed.push(file))).toEqual([])
  expect(handed.map((file) => [file.id, file.state, file.commands.map((c) => [c.command, c.exit])])).toEqual([
    ["sh_1", "interrupted", [["ls", 0], ["make", undefined]]],
  ])
  // Marked once: a later start hands nothing again.
  expect(recoverRecords(session, (file) => void handed.push(file))).toEqual([])
  expect(handed).toHaveLength(1)
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

test("a record that can't write never throws on the shell's output, and says why at its next save", () => {
  const dir = path.join(tempDir(), "sh_1")
  const { record, view } = recordOf(dir)
  view.append("before\n")
  // The disk is full: the output's write fails, and so does the save that would say so.
  const write = spyOn(fs, "writeSync").mockImplementationOnce(() => {
    throw enospc()
  })
  const save = spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
    throw enospc()
  })
  try {
    expect(() => view.append("lost\n")).not.toThrow()
    expect(write).toHaveBeenCalled()
    expect(save).toHaveBeenCalled()
  } finally {
    write.mockRestore()
    save.mockRestore()
  }
  expect(metaOf(dir).outputError).toBeUndefined()
  view.append("after\n")

  // A command whose save fails throws and isn't recorded.
  const failing = spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
    throw enospc()
  })
  try {
    expect(() => record.command("false", "@minh")).toThrow(/ENOSPC/)
  } finally {
    failing.mockRestore()
  }
  record.command("true", "@minh")
  expect(metaOf(dir).outputError).toBe("ENOSPC: no space left on device, write")
  record.exit(0)
  record.end("ended")
  expect(outputOf(dir)).toBe("before\n")
  expect(metaOf(dir)).toMatchObject({ state: "ended", outputError: "ENOSPC: no space left on device, write" })
  expect(metaOf(dir).commands).toEqual([{ command: "true", by: "@minh", at: expect.any(String), exit: 0 }])
  expect(fs.readdirSync(dir).sort()).toEqual(["meta.json", "output.log"])
})

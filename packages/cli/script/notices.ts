// The license and notice files the build ships beside each package's assets.
import fs from "node:fs"
import path from "node:path"

/** A package's license and notice files: its LICENSE and any others, such as those of the libraries OpenTUI's native
 *  library links. */
const NOTICE = /^(LICENSE|AUTHORS|PATENTS)|^FFMPEG-SOURCE\.md$/
/** What a package under the LGPL must ship: the notice and source offer of the FFmpeg OpenTUI's native library links. */
const LGPL_NOTICES = ["LICENSE-FFMPEG", "FFMPEG-SOURCE.md"]

/** The license and notice files of the package in `root`, or why it can't ship: it has no LICENSE, or its license
 *  names the LGPL and it lacks the LGPL's notice files. */
export function noticeFiles(root: string): { files: string[] } | { error: string } {
  if (!fs.existsSync(path.join(root, "LICENSE"))) return { error: `has no LICENSE (${path.join(root, "LICENSE")})` }
  const names = fs.readdirSync(root).filter((name) => NOTICE.test(name) && fs.statSync(path.join(root, name)).isFile())
  const { license } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { license?: unknown }
  const missing = LGPL_NOTICES.filter((name) => !names.includes(name))
  if (typeof license === "string" && license.includes("LGPL") && missing.length > 0)
    return { error: `is under ${license} but ships no ${missing.join(" or ")} (${root})` }
  return { files: names.map((name) => path.join(root, name)) }
}

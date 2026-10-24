/** Secret scrubbing for asset-tool results and audit rows: every form of a secret the office
 *  knows, as Python's monitor scrubs them (perm/monitor.py), with the Python string functions it relies on. */

// Python string functions the forms of a secret are built with

const JSON_NAMED: Record<number, string> = {
  0x22: "\\\"", 0x5c: "\\\\", 0x08: "\\b", 0x0c: "\\f", 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t",
}

const hex4 = (unit: number) => "\\u" + unit.toString(16).padStart(4, "0")

/** Python's `json.dumps(text, ensure_ascii=...)` of a str, quotes included. */
export function jsonDumps(text: string, ensureAscii = true): string {
  let out = "\""
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    // Units are escaped one by one, so an astral character becomes its surrogate pair as in Python.
    const named = JSON_NAMED[unit]
    const escaped = named ?? (unit < 0x20 || (ensureAscii && unit > 0x7e) ? hex4(unit) : undefined)
    if (escaped === undefined) continue
    out += text.slice(start, i) + escaped
    start = i + 1
  }
  return out + text.slice(start) + "\""
}

const ALWAYS_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~"
const UTF8 = new TextEncoder()
const PERCENT = Array.from({ length: 256 }, (_, byte) => "%" + byte.toString(16).toUpperCase().padStart(2, "0"))

/** Python's `urllib.parse.quote(text, safe)`; a lone surrogate encodes as U+FFFD, where Python raises. */
export function quote(text: string, safe = "/"): string {
  const table = PERCENT.slice()
  // Python drops non-ASCII characters of `safe`, so only ASCII ones keep their byte.
  for (const char of ALWAYS_SAFE + safe) if (char.charCodeAt(0) < 0x80) table[char.charCodeAt(0)] = char
  let out = ""
  for (const byte of UTF8.encode(text)) out += table[byte]
  return out
}

/** Python's `urllib.parse.quote_plus(text, safe)`. */
export function quotePlus(text: string, safe = ""): string {
  if (!text.includes(" ")) return quote(text, safe)
  return quote(text, safe + " ").replaceAll(" ", "+")
}

/** Python's whitespace (`str.isspace`); unlike JS's, it holds U+001C to U+001F and U+0085 but not U+FEFF. */
const SPACE = /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/

/** Python's `str.strip()` with no argument. */
export function strip(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && SPACE.test(text[start]!)) start++
  while (end > start && SPACE.test(text[end - 1]!)) end--
  return text.slice(start, end)
}

/** Python's `str.splitlines()` without line ends. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  // A text that ends at a break (or is empty) leaves an empty last piece that Python doesn't return.
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** Python's `str.casefold()`; a lone surrogate stays as it is. */
export function casefold(text: string): string {
  if (!/[^\x00-\x7f]/.test(text)) return text.toLowerCase()
  let out = ""
  for (const ch of text) out += FOLDS.get(ch.codePointAt(0)!) ?? ch
  return out
}

/** Python's `repr(text)` of a str, quotes included; a lone surrogate is escaped as one code point. */
export function repr(text: string): string {
  const mark = text.includes("'") && !text.includes("\"") ? "\"" : "'"
  let out = mark
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (ch === mark || ch === "\\") out += "\\" + ch
    else if (ch === "\t") out += "\\t"
    else if (ch === "\n") out += "\\n"
    else if (ch === "\r") out += "\\r"
    else if (isPrintable(cp)) out += ch
    else if (cp <= 0xff) out += "\\x" + cp.toString(16).padStart(2, "0")
    else if (cp <= 0xffff) out += hex4(cp)
    else out += "\\U" + cp.toString(16).padStart(8, "0")
  }
  return out + mark
}

/** Python's `chr(cp).isprintable()`. */
function isPrintable(cp: number): boolean {
  // The index of the last run start at or below cp; runs alternate not printable, printable.
  let low = 0
  let high = PRINTABLE_STARTS.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (PRINTABLE_STARTS[mid]! <= cp) low = mid
    else high = mid - 1
  }
  return low % 2 === 1
}

// Python 3.12's Unicode 15.0 data: `chr(c).isprintable()` and `chr(c).casefold()` over every code point, kept as
// data so repr and casefold match Python and don't move with the runtime's ICU.
// PRINTABLE_RUNS: base-36 run lengths from U+0000, alternating not printable and printable.
// FOLD_RUNS: base-36 `start.count.step.delta`; `start + i*step` for `i < count` folds to itself plus delta.
// FOLD_MULTI: base-36 `cp:a.b[.c]`; cp folds to those code points.

const PRINTABLE_RUNS =
  "w,2n,y,c,1,ju,2,6,4,7,1,1,1,k,1,b1,1,12,2,1e,2,3,1,1j,8,r,4,6,h,m,1,5c,1,1c,2,1n,2,2t,e,1n,2,1d,2,f,1,s,2,1,1," +
  "b,5,v,9,22,1,4h,1,8,2,2,2,m,1,7,1,1,3,4,2,9,2,2,2,4,8,1,4,2,1,5,2,p,2,3,1,6,4,2,2,m,1,7,1,2,1,2,1,2,2,1,1,5,4," +
  "2,2,3,3,1,7,4,1,1,7,h,a,3,1,9,1,3,1,m,1,7,1,2,1,5,2,a,1,3,1,3,2,1,f,4,2,c,7,7,1,3,1,8,2,2,2,m,1,7,1,2,1,5,2,9," +
  "2,2,2,3,7,3,4,2,1,5,2,i,a,2,1,6,3,3,1,4,3,2,1,1,1,2,3,2,3,3,3,c,4,5,3,3,1,4,2,1,6,1,e,l,5,d,1,3,1,n,1,g,2,9,1," +
  "3,1,4,7,2,1,3,2,1,2,4,2,a,7,m,1,3,1,n,1,a,1,5,2,9,1,3,1,4,7,2,6,2,1,4,2,a,1,3,c,d,1,3,1,1f,1,3,1,6,4,g,2,q,1,3" +
  ",1,i,3,o,1,9,1,1,2,7,3,1,4,6,1,1,1,8,6,a,2,3,c,1m,4,t,11,2,1,1,1,5,1,o,1,1,1,n,2,5,1,1,1,7,1,a,2,4,w,20,1,10,4" +
  ",13,1,10,1,f,1,d,11,5i,1,1,5,1,2,ah,1,4,2,7,1,1,1,4,2,15,1,4,2,x,1,4,2,7,1,1,1,4,2,f,1,1l,1,4,2,1v,2,w,3,q,6,2" +
  "e,2,6,2,hs,1,s,3,2h,7,m,9,o,9,k,c,d,1,3,1,2,c,2m,2,a,6,a,6,e,1,b,6,2h,7,17,5,1y,a,v,1,c,4,c,4,1,3,16,2,5,b,18," +
  "4,q,6,b,3,1q,2,1t,1,t,2,b,6,a,6,e,2,v,1d,25,3,1b,1,38,8,1o,3,f,3,1o,7,17,2,b,8,17,5,eu,2,6,2,12,2,6,2,8,1,1,1," +
  "1,1,1,1,v,2,1h,1,f,1,e,2,6,1,j,2,3,1,9,h,o,8,1b,h,2,2,r,1,d,3,x,f,x,f,3w,4,if,p,b,l,1ec,2,w,1,9p,5,19,1,1,5,1," +
  "2,1k,7,2,e,o,9,7,1,7,1,7,1,7,1,7,1,7,1,7,1,7,1,3i,y,q,1,2h,c,5y,q,c,5,1r,1,2e,2,2v,5,17,1,2m,1,2c,c,1b,1,mlp,3" +
  ",1j,9,9o,k,54,8,5n,5,2,1,1,1,5,o,1n,3,a,6,1k,8,1y,8,c,6,38,b,u,3,26,1,b,4,x,1,1j,9,e,2,a,2,2v,o,s,a,6,2,6,2,6," +
  "9,7,1,7,1,1o,4,3i,2,a,6,8mc,c,n,4,1d,6is,a6,2,2y,12,7,c,5,5,q,1,5,1,1,1,2,1,2,1,3h,g,cd,2,1i,7,1,w,16,6,1f,1,j" +
  ",1,4,4,5,1,3r,4,5a,3,6,2,6,2,6,2,3,3,7,1,7,d,2,2,c,1,q,1,j,1,2,1,f,2,e,y,3f,5,3,4,19,3,2g,1,d,3,1,1b,1a,3m,t,3" +
  ",1d,f,s,4,10,9,u,5,17,5,u,1,11,4,e,16,4e,2,a,6,10,4,10,4,14,8,1g,b,c,1,f,1,7,1,2,1,b,1,f,1,7,1,2,1v,8n,9,m,a,8" +
  ",o,6,1,16,1,9,1x,6,2,1,1,18,1,2,3,1,2,n,1,20,8,9,1c,j,1,2,5,x,3,r,5,1,1s,1k,4,k,2,1e,1,2,5,8,1,3,1,t,2,3,4,a,7" +
  ",9,7,1s,w,13,4,c,9,1i,3,t,2,r,5,q,7,4,c,7,28,21,1j,1f,d,1f,7,1a,8,a,86,v,1,16,1,3,2,2,23,17,8,16,m,q,12,s,k,n," +
  "9,26,4,10,9,1q,1,5,d,p,7,a,6,1h,1,i,8,13,9,2o,1,k,b,i,1,1b,1q,7,1,1,1,4,1,f,1,b,6,1n,5,a,6,4,1,8,2,2,2,m,1,7,1" +
  ",2,1,5,1,a,2,2,2,3,2,1,6,1,5,7,2,7,3,5,3v,2k,1,5,u,20,8,a,4m,1i,2,12,y,1x,b,a,6,d,j,1m,6,a,1i,r,2,f,4,n,55,1o," +
  "2s,2b,c,8,2,1,2,8,1,2,1,u,1,2,2,c,9,a,1y,8,2,1a,2,b,r,20,8,2b,d,21,7,a,6u,9,1,19,1,e,a,t,3,w,2,m,1,e,21,7,1,2," +
  "1,18,3,1,1,2,1,9,8,a,6,6,1,2,1,11,1,2,1,6,7,a,8m,p,7,h,1,15,3,s,2e,1,f,1e,d,pn,2u,33,1,5,b,5g,218,2r,d,ts,g,m," +
  "33e,g7,6nt,ft,7,v,1,a,4,29,1,a,6,u,2,6,a,1y,a,a,1,7,1,l,5,j,j4,2j,2t,23,4,1l,7,h,1s,5,b,2,e,4qg,8,ye,16,9,6w7," +
  "4,1,7,1,2,1,83,f,1,t,3,2,1,e,4,8,b0,1s4,2z,5,d,3,9,7,a,2,4,3mo,1a,2,n,9,38,1o,6u,a,13,2,22,8,34,l,1y,3e,k,c,k," +
  "c,2f,9,p,3r,2d,1,1z,1,2,2,1,2,2,2,4,1,c,1,1,1,7,1,1t,1,4,2,8,1,7,1,s,1,4,1,5,1,1,3,7,1,9g,2,84,2,ji,f,5,1,f,uo" +
  ",v,6,6,5x,7,1,h,2,7,1,2,1,5,5,1q,x,1,34,19,3,e,2,a,4,2,8w,v,h,1m,5,1,cw,16,km,7,1,4,1,2,1,f,1,5h,2,g,15,24,4,a" +
  ",4,2,lt,1w,24,1p,5e,4,1,r,1,2,1,1,2,1,1,a,1,4,1,1,1,1,6,1,4,1,1,1,1,1,1,3,1,2,1,1,2,1,1,1,1,1,1,1,1,1,1,2,1,1," +
  "2,4,1,7,1,4,1,4,1,1,1,a,1,h,5,3,1,5,1,h,1g,2,7i,18,4,2s,c,f,2,f,1,f,1,11,a,4u,1k,t,d,18,4,9,7,2,e,6,4a,rc,4,h," +
  "3,d,3,3b,4,2n,6,c,4,1,f,c,4,1k,8,a,6,14,8,u,2,2,26,9g,c,e,2,d,3,9,7,1a,1,7,8,e,4,9,7,9,7,43,1,1j,11,a,sm,wyo,w" +
  ",37e,6,66,2,4g2,e,5rl,2e7,f2,15u,3t7,5,38g,f9e8,6o,47bk"

const FOLD_RUNS =
  "1t.q.1.w 51.1.1.lj 5c.n.1.w 60.7.1.w 74.o.2.1 8i.3.2.1 8p.8.2.1 96.n.2.1 ag.1.1.-3d ah.3.2.1 an.1.1.-7g ap.1.1" +
  ".5u aq.2.2.1 au.1.1.5q av.1.1.1 ax.2.1.5p az.1.1.1 b2.1.1.27 b3.1.1.5m b4.1.1.5n b5.1.1.1 b7.1.1.5p b8.1.1.5r " +
  "ba.1.1.5v bb.1.1.5t bc.1.1.1 bg.1.1.5v bh.1.1.5x bj.1.1.5y bk.3.2.1 bq.1.1.62 br.1.1.1 bt.1.1.62 bw.1.1.1 by.1" +
  ".1.62 bz.1.1.1 c1.2.1.61 c3.2.2.1 c7.1.1.63 c8.1.1.1 cc.1.1.1 ck.1.1.2 cl.1.1.1 cn.1.1.2 co.1.1.1 cq.1.1.2 cr." +
  "9.2.1 da.9.2.1 dt.1.1.2 du.2.2.1 dy.1.1.-2p dz.1.1.-1k e0.k.2.1 f4.1.1.-3m f6.9.2.1 fu.1.1.8bv fv.1.1.1 fx.1.1" +
  ".-4j fy.1.1.8bs g1.1.1.1 g3.1.1.-5f g4.1.1.1x g5.1.1.1z g6.5.2.1 n9.1.1.38 og.2.2.1 om.1.1.1 ov.1.1.38 p2.1.1." +
  "12 p4.3.1.11 p8.1.1.1s pa.2.1.1r pd.h.1.w pv.9.1.w qq.1.1.1 r3.1.1.8 r4.1.1.-u r5.1.1.-p r9.1.1.-f ra.1.1.-m r" +
  "c.c.2.1 s0.1.1.-1i s1.1.1.-1c s4.1.1.-1o s5.1.1.-1s s7.1.1.1 s9.1.1.-7 sa.1.1.1 sd.3.1.-3m sg.g.1.28 sw.w.1.w " +
  "v4.h.2.1 wa.r.2.1 xs.1.1.f xt.7.2.1 y8.1c.2.1 10x.12.1.1c 3a8.12.1.5ls 3bb.1.1.5ls 3bh.1.1.5ls 3y0.6.1.-8 5mo." +
  "1.1.-4su 5mp.1.1.-4st 5mq.1.1.-4sk 5mr.2.1.-4si 5mt.1.1.-4sj 5mu.1.1.-4sc 5mv.1.1.-4ro 5mw.1.1.r7n 5n4.17.1.-2" +
  "bk 5od.3.1.-2bk 5xc.23.2.1 61n.1.1.-1m 61s.1c.2.1 64o.8.1.-8 654.6.1.-8 65k.8.1.-8 660.8.1.-8 66g.6.1.-8 66x.4" +
  ".2.-8 67c.8.1.-8 69k.2.1.-8 69m.2.1.-22 69q.1.1.-5j9 6a0.4.1.-2e 6ag.2.1.-8 6ai.2.1.-2s 6aw.2.1.-8 6ay.2.1.-34" +
  " 6b0.1.1.-7 6bc.2.1.-3k 6be.2.1.-3i 6jq.1.1.-5st 6ju.1.1.-6gv 6jv.1.1.-6di 6k2.1.1.s 6lc.g.1.g 6mb.1.1.1 792.q" +
  ".1.q 8ow.1c.1.1c 8rk.1.1.1 8rm.1.1.-8af 8rn.1.1.-2xy 8ro.1.1.-89z 8rr.3.2.1 8rx.1.1.-8bg 8ry.1.1.-8al 8rz.1.1." +
  "-8bj 8s0.1.1.-8bi 8s2.1.1.1 8s5.1.1.1 8se.2.1.-8cf 8sg.1e.2.1 8vf.2.2.1 8vm.1.1.1 wu8.n.2.1 ww0.e.2.1 x0i.7.2." +
  "1 x0y.v.2.1 x2x.2.2.1 x31.1.1.-r9g x32.5.2.1 x3f.1.1.1 x3h.1.1.-wmg x3k.2.2.1 x3q.a.2.1 x4a.1.1.-wn8 x4b.1.1.-" +
  "wnj x4c.1.1.-wnf x4d.1.1.-wn5 x4e.1.1.-wn8 x4g.1.1.-wlu x4h.1.1.-wmi x4i.1.1.-wlx x4j.1.1.ps x4k.8.2.1 x50.1.1" +
  ".-1c x51.1.1.-wn7 x52.1.1.-raw x53.2.2.1 x5c.1.1.1 x5i.2.2.1 x6d.1.1.1 xv4.28.1.-tzk 1ee9.q.1.w 1fcw.14.1.14 1" +
  "fhs.10.1.14 1fn4.b.1.13 1fng.f.1.13 1fnw.7.1.13 1fo4.2.1.13 1h1c.1f.1.1s 1jfk.w.1.w 20cg.w.1.w 2olc.y.1.y"

const FOLD_MULTI =
  "67:37.37 8g:2x.lj 95:jg.32 ds:2y.lo pc:qh.lk.ld q8:qt.lk.ld 13b:12d.136 61i:2w.mp 61j:38.lk 61k:3b.lm 61l:3d.l" +
  "m 61m:2p.ji 61q:37.37 66o:qt.lv 66q:qt.lv.lc 66s:qt.lv.ld 66u:qt.lv.n6 680:64g.qh 681:64h.qh 682:64i.qh 683:64" +
  "j.qh 684:64k.qh 685:64l.qh 686:64m.qh 687:64n.qh 688:64g.qh 689:64h.qh 68a:64i.qh 68b:64j.qh 68c:64k.qh 68d:64" +
  "l.qh 68e:64m.qh 68f:64n.qh 68g:65c.qh 68h:65d.qh 68i:65e.qh 68j:65f.qh 68k:65g.qh 68l:65h.qh 68m:65i.qh 68n:65" +
  "j.qh 68o:65c.qh 68p:65d.qh 68q:65e.qh 68r:65f.qh 68s:65g.qh 68t:65h.qh 68u:65i.qh 68v:65j.qh 68w:674.qh 68x:67" +
  "5.qh 68y:676.qh 68z:677.qh 690:678.qh 691:679.qh 692:67a.qh 693:67b.qh 694:674.qh 695:675.qh 696:676.qh 697:67" +
  "7.qh 698:678.qh 699:679.qh 69a:67a.qh 69b:67b.qh 69e:67k.qh 69f:q9.qh 69g:q4.qh 69i:q9.n6 69j:q9.n6.qh 69o:q9." +
  "qh 69u:67o.qh 69v:qf.qh 69w:q6.qh 69y:qf.n6 69z:qf.n6.qh 6a4:qf.qh 6aa:qh.lk.lc 6ab:qh.lk.ld 6ae:qh.n6 6af:qh." +
  "lk.n6 6aq:qt.lk.lc 6ar:qt.lk.ld 6as:qp.lv 6au:qt.n6 6av:qt.lk.n6 6b6:67w.qh 6b7:qx.qh 6b8:r2.qh 6ba:qx.n6 6bb:" +
  "qx.n6.qh 6bg:qx.qh 1dkw:2u.2u 1dkx:2u.2x 1dky:2u.30 1dkz:2u.2u.2x 1dl0:2u.2u.30 1dl1:37.38 1dl2:37.38 1dlf:12s" +
  ".12u 1dlg:12s.12d 1dlh:12s.12j 1dli:132.12u 1dlj:12s.12l"

// Decoded once at import, after the tables they read.

/** The start of each run in PRINTABLE_RUNS. */
const PRINTABLE_STARTS = (() => {
  const lengths = PRINTABLE_RUNS.split(",")
  const starts = new Int32Array(lengths.length)
  let cp = 0
  for (let i = 0; i < lengths.length; i++) {
    starts[i] = cp
    cp += parseInt(lengths[i]!, 36)
  }
  return starts
})()

/** Each code point whose casefold differs from it, mapped to its casefold. */
const FOLDS = (() => {
  const folds = new Map<number, string>()
  for (const run of FOLD_RUNS.split(" ")) {
    const [start, count, step, delta] = run.split(".").map((part) => parseInt(part, 36))
    for (let cp = start!, i = 0; i < count!; cp += step!, i++) folds.set(cp, String.fromCodePoint(cp + delta!))
  }
  for (const entry of FOLD_MULTI.split(" ")) {
    const [cp, to] = entry.split(":") as [string, string]
    folds.set(parseInt(cp, 36), String.fromCodePoint(...to.split(".").map((part) => parseInt(part, 36))))
  }
  return folds
})()

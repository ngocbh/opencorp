/** Polls `cond` every 5 ms until it holds; throws after `ms`. */
export async function until(cond: () => boolean, ms = 2000) {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(5)) if (Date.now() > end) throw new Error("timed out")
}

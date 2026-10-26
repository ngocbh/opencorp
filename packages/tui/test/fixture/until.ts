/** Polls `cond` every 5 ms until it holds; throws after `ms`. `cond` may be async (a request to the office). */
export async function until(cond: () => boolean | Promise<boolean>, ms = 2000) {
  for (const end = Date.now() + ms; !(await cond()); await Bun.sleep(5)) if (Date.now() > end) throw new Error("timed out")
}

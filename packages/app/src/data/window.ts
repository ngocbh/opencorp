export type CostWindow = "today" | "7d" | "30d"
const DAY = 86_400_000

/** The start of `w` as a Timestamp: local midnight for today, else 7 or 30 days back from `now`. */
export function since(w: CostWindow, now = new Date()) {
  if (w === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  return new Date(now.getTime() - (w === "7d" ? 7 : 30) * DAY).toISOString()
}

import path from "path"
import { abbreviateHome } from "../runtime"
import { useOffice } from "./office"
import { useRoute } from "./route"
import { useTuiPaths } from "./runtime"

/** Formats paths relative to the open session's folder (else the office cwd), with home as `~`. */
export function usePathFormatter() {
  const paths = useTuiPaths()
  const office = useOffice()
  const route = useRoute()
  const base = () => {
    const id = route.data.type === "session" ? route.data.sessionID : undefined
    return office.state.sessions.find((s) => s.id === id)?.cwd || office.cwd
  }
  return {
    format: (input?: string) => formatPath(input, base(), paths.home),
  }
}

function formatPath(input: string | undefined, base: string, home: string) {
  if (typeof input !== "string" || !input) return ""

  const absolute = path.isAbsolute(input) ? input : path.resolve(base, input)
  const relative = path.relative(base, absolute)

  if (!relative) return "."
  if (relative !== ".." && !relative.startsWith(".." + path.sep)) return relative
  return abbreviateHome(absolute, home)
}

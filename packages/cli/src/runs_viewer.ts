// The daemon reads Run Logs' node views on a worker thread it starts from `runs_viewer.js` beside the bundle
// (`threadEntry("runs_viewer")`). This file is the fourth compile entry that puts it there, so it must stay at
// `src/runs_viewer.ts`.
import "@opencorp/office/runtime/runs/view_thread"

// The daemon runs the run index on a worker thread it starts from `runs_indexer.js` beside the bundle
// (`threadEntry("runs_indexer")`). This file is the third compile entry that puts it there, so it must stay at
// `src/runs_indexer.ts`.
import "@opencorp/office/runs/index_thread"

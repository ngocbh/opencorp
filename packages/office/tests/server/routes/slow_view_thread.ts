/** The office's viewer thread, holding each replay for `workerData.holdMs` before it starts, synchronously, as a long
 *  replay holds its thread: for the tests that check the office's own thread stays free meanwhile. */
import { parentPort, workerData } from "node:worker_threads"
import { serve } from "../../../src/runtime/runs/view_thread.ts"

const held = new Int32Array(new SharedArrayBuffer(4))
serve({
  on: (event, fn) =>
    parentPort!.on(event, (message) => {
      Atomics.wait(held, 0, 0, workerData.holdMs)
      fn(message)
    }),
  postMessage: (reply) => parentPort!.postMessage(reply),
})

import { describe, expect, test } from "bun:test"

import { threadProcessProbeSource } from "../../../src/infra/owned-subprocess-backend.js"
import { unixProcessIdentity } from "../../../src/infra/process-container.js"

/** A pid no process holds: pid_max on every supported platform is far below it. */
const FREE_PID = 2_000_000_000

// Windows gives the probe no kernel surface, so it answers nothing there and
// its caller asks signal zero instead.
describe.skipIf(process.platform === "win32")("thread process probe", () => {
  test("identifies a process from inside a Worker built from the probe's source, as the kernel does on this thread", async () => {
    const { imports, expression } = threadProcessProbeSource()
    const source = `${imports} const probe = ${expression}; postMessage([probe.identify(${process.pid}), probe.identify(${FREE_PID})])`
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
    const worker = new Worker(url)
    try {
      const answers = await new Promise<unknown>((resolve, reject) => {
        worker.addEventListener("message", (event: MessageEvent) => { resolve(event.data) })
        worker.addEventListener("error", (event) => { reject(new Error(event.message)) })
      })

      // libproc answers on macOS and /proc on Linux, in the Worker and here alike.
      const self = unixProcessIdentity(process.pid)
      expect(self.kind).toBe("process")
      expect(answers).toEqual([self, { kind: "absent" }])
    } finally {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
  })
})

import { connectPersistentProcessBridge } from "../../../src/infra/persistent-process-bridge.js"

declare const self: {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  postMessage(message: unknown, transfer: readonly unknown[]): void
}

self.addEventListener("message", (event: MessageEvent) => {
  const data: unknown = event.data
  if (typeof data !== "object" || data === null || !("port" in data) || !(data.port instanceof MessagePort) || !("launch" in data) || typeof data.launch !== "boolean") return
  const client = connectPersistentProcessBridge(data.port, { requestDeadlineMs: 1_000 })
  void (async () => {
    if (data.launch) {
      const launched = await Promise.all(Array.from({ length: 16 }, (_, index) => client.launch(["worker-record", String(index)])))
      const launchValues = launched.map((record, index) => record.command[1] === String(index) ? record.pid : -1)
      self.postMessage({ kind: "launched", launchedId: launched[0]?.id, values: launchValues }, [])
      return
    }
    const records = await client.list()
    const reads = await Promise.all(records.map((record) => client.read(record.id, "stdout", 0, 1)))
    self.postMessage({
      kind: "complete",
      counts: [records.length],
      values: reads.map((read) => read.data[0] ?? -1),
    }, [])
    client.close()
  })().catch((error: unknown) => {
    self.postMessage({ kind: "failed", error: error instanceof Error ? error.message : String(error) }, [])
    client.close()
  })
})

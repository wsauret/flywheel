import { connectOwnedProcessBridge } from "../../src/infra/owned-process-bridge.js"

/** Worker end of an owned-process bridge, for the integration test that proves
 *  a container launched inside a Worker is owned by the main thread's guardian
 *  and ends with the generation that served the bridge. It launches locally,
 *  exactly as the runtime worker does, reports the pid it got, and reports
 *  when its lifetime ends. */

declare const self: {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  postMessage(message: unknown): void
}

self.addEventListener("message", (event: MessageEvent) => {
  const data: unknown = event.data
  if (typeof data !== "object" || data === null || !("ownership" in data) || !("command" in data)) return
  const port = data.ownership
  const command = data.command
  if (!(port instanceof MessagePort) || !Array.isArray(command)) return
  const ownership = connectOwnedProcessBridge({ port })
  ownership.lifetime.addEventListener("abort", () => { self.postMessage({ kind: "ended" }) }, { once: true })
  void ownership.launcher.spawnOwned(command.map(String)).then(
    (owned) => { self.postMessage({ kind: "launched", pid: owned.pid, token: owned.token }) },
    (err: unknown) => { self.postMessage({ kind: "failed", error: String(err) }) },
  )
})

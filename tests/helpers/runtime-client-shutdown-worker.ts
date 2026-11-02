const BRIDGE_FRAME_VERSION = 1

function isFrame(value: unknown): value is { readonly kind: string; readonly id?: number } {
  return typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string"
}

function connectOwnership(port: MessagePort): void {
  let requestId = 0
  let terminationRequestId: number | undefined
  port.addEventListener("message", (event: MessageEvent) => {
    const frame = event.data
    if (!isFrame(frame)) return
    if (frame.kind === "terminate") {
      requestId++
      terminationRequestId = requestId
      port.postMessage({ v: BRIDGE_FRAME_VERSION, kind: "guardian-pid", id: terminationRequestId })
      return
    }
    if (frame.kind === "guardian-pid" && frame.id === terminationRequestId) {
      port.postMessage({ v: BRIDGE_FRAME_VERSION, kind: "terminated" })
    }
  })
  port.start()
  requestId++
  port.postMessage({ v: BRIDGE_FRAME_VERSION, kind: "guardian-pid", id: requestId })
}

globalThis.addEventListener("message", (event: MessageEvent) => {
  const value: unknown = event.data
  if (typeof value !== "object" || value === null || !("flywheel" in value)) return
  if (value.flywheel === "runtime.init" && "ownership" in value && value.ownership instanceof MessagePort
    && "maintenanceOwnership" in value && value.maintenanceOwnership instanceof MessagePort) {
    connectOwnership(value.ownership)
    connectOwnership(value.maintenanceOwnership)
    return
  }
  if (value.flywheel === "shutdown") globalThis.postMessage({ flywheel: "shutdown-done" })
})

globalThis.postMessage([0])

import type { CapabilityRequest, HostMessage, ViewMessage } from "../../src/protocol/client/editor-host.js"
import { mutationTypeExposure } from "../../src/protocol/client/editor-protocol-coverage.js"
import type { ClientHandle, HostCapabilities } from "../src/host.js"
import { mountClient } from "../src/index.js"
import { postMessageSocketLayer, ViewBridge } from "./post-message-socket.js"
import "./vscode-theme.css"
import { editorInputReloadStorage } from "../src/client/input-reload-storage.js"
import { editorClientReplacement } from "./client-replacement.js"

/** The editor host shell. It has no UI of its own: it wires the client to
 *  the extension host over `postMessage` and mounts it. Everything a person
 *  sees is the client, the same bundle the local page and the phone render.
 *
 *  This file ships with the runtime, not with the extension: the extension
 *  loads it from the runtime's build directory. So the extension that mounts
 *  it can be older than it, and the page states the host contract version the
 *  extension was built for and the identity of the bundle it mounted; the
 *  client checks the one at mount and offers the other at every attach. */

const root = document.querySelector<HTMLElement>("#root")
if (!root) throw new Error("the host page has no #root")

// oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: native VS Code state is decoded by the checkpoint storage adapter
declare function acquireVsCodeApi(): { postMessage(message: ViewMessage): void; getState(): unknown; setState(value: unknown): void }
const vscode = acquireVsCodeApi()

const bridge = new ViewBridge((message) => vscode.postMessage(message))

/** Capability calls settle from the host's `capability.result`, matched by id. */
let nextRequest = 1
const pendingRequests = new Map<number, { resolve: () => void; reject: (cause: Error) => void }>()
function request(payload: CapabilityRequest): Promise<void> {
  const requestId = nextRequest
  nextRequest += 1
  return new Promise<void>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject })
    vscode.postMessage({ type: "capability", requestId, request: payload })
  })
}

let hostCommandIds = new Set<string>()
let handle: ClientHandle | undefined
const generation = Number(root.dataset.pageGeneration)
const scope = `editor:${root.dataset.inputScope ?? ""}`

const capabilities: HostCapabilities = {
  keyboardShortcuts: true,
  releaseOnPageHide: true,
  canMutate: (type) => mutationTypeExposure(type) !== "omitted",
  writeClipboardText: (text) => request({ name: "writeClipboardText", text }),
  openChanges: (target) => request({ name: "openChanges", target }),
  openFile: (path, executionCwd) => request({ name: "openFile", path, executionCwd }),
  openExternal: (url) => request({ name: "openExternal", url }),
  replacement: editorClientReplacement(request, Number(root.dataset.hostContract), generation),
  // Only the extension can start the runtime; it answers once one listens.
  ensureRuntime: () => request({ name: "ensureRuntime" }),
  commands: {
    has: (id) => hostCommandIds.has(id),
    run: (id, ...args) => request({ name: "runCommand", id, args }),
  },
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data
  if (bridge.handle(message)) return
  switch (message.type) {
    case "hostCommands":
      hostCommandIds = new Set(message.ids)
      // Mounted only once the command list is present, so the client's
      // synchronous `has` never answers from an empty set during first paint.
      handle ??= mountClient(root, {
        surface: "editor",
        inputScope: scope,
        inputStorage: editorInputReloadStorage(vscode, scope),
        socket: postMessageSocketLayer(bridge),
        ...(root.dataset.clientIdentity === undefined ? {} : { clientIdentity: root.dataset.clientIdentity }),
        ...(root.dataset.hostContract === undefined ? {} : { hostContract: Number(root.dataset.hostContract) }),
        capabilities,
        ...(message.review === undefined ? {} : { review: message.review }),
        onSummary: (summary) => vscode.postMessage({ type: "summary", summary }),
        // oxlint-disable-next-line no-console -- boundary: the webview developer tools console is the only diagnostics sink this page has
        onDiagnostic: (detail, cause) => console.warn(detail, cause),
      })
      return
    case "capability.result": {
      const pending = pendingRequests.get(message.requestId)
      if (!pending) return
      pendingRequests.delete(message.requestId)
      if (message.ok) pending.resolve()
      else pending.reject(new Error(message.error))
      return
    }
    case "command":
      handle?.command(message.command)
      return
  }
})

vscode.postMessage({ type: "ready" })

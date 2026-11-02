import type { ChangesReviewTarget, ClientCommand, ClientSummary } from "./host-contract.js"

/** The messages between the editor's extension host and the client's webview.
 *
 *  The webview is the client. It holds the runtime connection, the ordered
 *  intake, and the session state; the extension host is a pipe and a set of
 *  editor capabilities. So this vocabulary carries three things and nothing
 *  else: opaque runtime bytes on numbered channels, requests for what only the
 *  editor can do, and the summary the client publishes for the status bar. No
 *  transcript state crosses here in either direction.
 *
 *  The two ends are built from different trees: the extension host from the
 *  extension package, the webview from the runtime's own build. This
 *  vocabulary is part of the host contract that `HOST_CONTRACT_VERSION` in
 *  `host-contract.ts` numbers. */

/** One call the client makes on an editor capability. Every variant names a
 *  thing the editor does with its own APIs and the client cannot. */
export type CapabilityRequest =
  | { readonly name: "openChanges"; readonly target: ChangesReviewTarget }
  /** Version-1 clients request replacement without a checkpoint handshake.
   *  Remove this transition after 2027-01-19. */
  | { readonly name: "reload" }
  /** Resolve a successor while the requesting page and bridge stay resident. */
  | { readonly name: "prepareReload"; readonly generation: number; readonly transactionId: number }
  /** Replace only the page whose preparation completed for this transaction. */
  | { readonly name: "commitReload"; readonly generation: number; readonly transactionId: number }
  | { readonly name: "openFile"; readonly path: string; readonly executionCwd: string }
  | { readonly name: "openExternal"; readonly url: string }
  | { readonly name: "writeClipboardText"; readonly text: string }
  | { readonly name: "runCommand"; readonly id: string; readonly args: readonly unknown[] }
  /** Find the runtime or start it again, the way the terminal's find-or-start
   *  does, and answer once one listens. The client's lane found nothing
   *  listening after it had been connected. */
  | { readonly name: "ensureRuntime" }

/** View to host. */
export type ViewMessage =
  /** The view is mounted and listening. The host answers with `hostCommands`,
   *  and the client mounts only after that, so `HostCommands.has` can be a
   *  synchronous lookup over a list that is already present. */
  | { readonly type: "ready" }
  | { readonly type: "socket.open"; readonly id: number }
  | { readonly type: "socket.data"; readonly id: number; readonly bytes: Uint8Array }
  | { readonly type: "socket.close"; readonly id: number }
  | { readonly type: "capability"; readonly requestId: number; readonly request: CapabilityRequest }
  | { readonly type: "summary"; readonly summary: ClientSummary }

/** Host to view. */
export type HostMessage =
  | { readonly type: "hostCommands"; readonly ids: readonly string[]; readonly review?: ChangesReviewTarget }
  | { readonly type: "socket.opened"; readonly id: number }
  | { readonly type: "socket.data"; readonly id: number; readonly bytes: Uint8Array }
  | { readonly type: "socket.closed"; readonly id: number; readonly error?: string }
  | { readonly type: "capability.result"; readonly requestId: number; readonly ok: true }
  | { readonly type: "capability.result"; readonly requestId: number; readonly ok: false; readonly error: string }
  | { readonly type: "command"; readonly command: ClientCommand }

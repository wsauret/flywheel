import type { Layer } from "effect"
import type { Socket } from "effect/socket"

import type { FrontendMutation } from "../../src/protocol/app-service-types.js"
import type { MachinePicker, MachinePickerSnapshot } from "../../src/protocol/modules/remote/machine-picker.js"
import type { ChangesReviewTarget, ClientCommand, ClientSummary } from "../../src/protocol/client/host-contract.js"
import type { InputReloadStorage } from "./client/input-reload-checkpoint.js"

/** The contract between the web client and whatever hosts it.
 *
 *  The client is one bundle. The VS Code extension mounts it in a webview and
 *  the phone app mounts it in a browser, and neither is a special case inside
 *  the client: everything that differs between them arrives through this object
 *  at mount. A host hands over a transport, the things it can do for the
 *  client, and a place to publish a summary; the client hands back a handle the
 *  host drives. Nothing in the client asks which host it is in.
 *
 *  The shapes that cross to a host built from another tree (the summary, the
 *  commands, the review target) live in `src/protocol/client/host-contract.ts`;
 *  this file holds only what a host hands the client at mount. */

/** Host commands the client may ask for by id.
 *
 *  Ids are the host's own vocabulary: the editor's command ids, which the
 *  runtime also names in session notices. `has` lets the client hide a row for
 *  a command this host does not carry rather than offer a dead control. */
interface HostCommands {
  has(id: string): boolean
  run(id: string, ...args: readonly unknown[]): Promise<void>
}

/** One tap on the way to installing the app, drawn by the client from a small
 *  glyph vocabulary so the host says which taps its platform needs without
 *  the client learning which platform it is on. */
export interface InstallStep {
  readonly glyph: "share" | "add-home" | "confirm" | "menu" | "install" | "dock"
  readonly label: string
}

/** How this page becomes an installed app. Present only while it runs in a
 *  browser tab: an installed app has nothing to guide. `browser` names the
 *  browser the steps are written for, so the person can see the guide is
 *  theirs. `canPrompt` means the host can open the platform's install prompt
 *  itself. `note` replaces the steps when the browser cannot install at all. */
export interface InstallGuide {
  readonly browser: string
  readonly steps: readonly InstallStep[]
  readonly canPrompt: boolean
  readonly note?: string
}

/** The relay client's picker snapshot and, while the page runs in a browser
 *  tab, the guide to installing it. */
export interface RemoteHostSnapshot extends MachinePickerSnapshot {
  readonly install?: InstallGuide
}

/** A host that reaches runtimes through a relay. The shared relay client
 *  (`relay-client.ts`) holds the device key and the pairings, watches which
 *  placements are online, and connects the client's socket to whichever one
 *  is selected; the host adds what only its platform has. The client renders
 *  the list and the pairing screen from this and never learns a key. */
export interface RemoteHostCapability extends MachinePicker<RemoteHostSnapshot> {
  /** Opens the camera and resolves with the first code it reads, or nothing if
   *  the person dismissed it. Present only where a camera exists. */
  readonly scan?: () => Promise<string | undefined>
  /** Opens the platform's install prompt. Present only while the snapshot's
   *  guide says the host can prompt; resolves with whether the person accepted. */
  readonly promptInstall?: () => Promise<boolean>
}

/** The `PushSubscriptionJSON` a browser hands out, as the runtime records it. */
export interface PushSubscriptionRecord {
  readonly endpoint: string
  readonly expirationTime: number | null
  readonly keys: { readonly p256dh: string; readonly auth: string }
}

/** A host that can receive Web Push while the client is closed. The client
 *  asks on a user gesture, hands the subscription to the runtime, and shows
 *  the permission state; the host owns the service worker and the browser
 *  prompt. */
export interface PushHostCapability {
  state(): NotificationPermission | "unavailable"
  /** The host platform's steps for changing a blocked permission. */
  readonly settingsInstructions?: string
  current(): Promise<(PushSubscriptionRecord & { readonly applicationServerKey?: string; readonly runtimeId?: string }) | undefined>
  /** Prompts if needed and subscribes under the runtime's public key. Nothing
   *  when the person declined. */
  subscribe(applicationServerKey: string, runtimeId?: string): Promise<PushSubscriptionRecord | undefined>
  unsubscribe(): Promise<void>
  readonly onChange?: (listener: () => void) => () => void
}

/** What this host can do for the client. Every entry is optional, and the
 *  client degrades by absence: a path is a link when the host can open files
 *  and plain text when it cannot. */
export interface HostCapabilities {
  /** The mutations this host exposes; absence admits the complete protocol. */
  readonly canMutate?: (type: FrontendMutation["type"]) => boolean
  /** Writes text to the clipboard owned by this device. */
  readonly writeClipboardText?: (text: string) => Promise<void>
  /** Mounts the same runtime-backed Changes content in the editor area. */
  readonly openChanges?: (target: ChangesReviewTarget) => Promise<void>
  /** Opens a workspace path in the host's editor. Paths in a transcript are
   *  relative to where the session executes, so the execution directory rides
   *  along for the host to contain the path under (ARCH-DIRECTORIES-007). */
  readonly openFile?: (path: string, executionCwd: string) => Promise<void>
  /** Opens a URL outside the client. */
  readonly openExternal?: (url: string) => Promise<void>
  readonly commands?: HostCommands
  readonly remote?: RemoteHostCapability
  readonly push?: PushHostCapability
  /** Loads the client again from the runtime that serves it. A host whose page
   *  is a document reloads it; the editor mounts its webview again. Absent, the
   *  client reloads the document itself. */
  readonly replacement?: {
    prepare(): Promise<void>
    commit(): Promise<void>
  }
  /** Finds the runtime or starts it again, when the lane found nothing
   *  listening after it had been connected. The editor asks its extension,
   *  which runs the runtime's own find-or-start. Absent, the client only
   *  reconnects. */
  readonly ensureRuntime?: () => Promise<void>
  /** The host has a keyboard that takes the client's chords, so the client
   *  offers its Keyboard shortcuts reference. */
  readonly keyboardShortcuts?: true
}

export interface ClientHost {
  /** The host names its surface for diagnostic reports. Test hosts may omit it. */
  readonly surface?: "web" | "phone" | "editor"
  /** Stable project/placement identity, never the served bundle identity. */
  readonly inputScope?: string | (() => string)
  readonly inputStorage?: InputReloadStorage
  readonly review?: ChangesReviewTarget
  /** Opens this session before a saved reading place. The session owner resolves
   *  unlisted ids through detail and falls back when the session is missing. */
  readonly initialSessionId?: string
  readonly initialAttention?: boolean
  /** The transport to the runtime, built afresh on every attach. */
  readonly socket: Layer.Layer<Socket.Socket>
  /** The identity of the client bundle this page loaded, as the page states
   *  it. The client offers it at every attach and the runtime refuses one that
   *  is not its own. Absent only for a page built together with its runtime. */
  readonly clientIdentity?: string
  /** The `HOST_CONTRACT_VERSION` the host was built for, as the page states
   *  it. Absent means the host and the client come from one tree. */
  readonly hostContract?: number
  readonly capabilities: HostCapabilities
  readonly onSummary?: (summary: ClientSummary) => void
  readonly onDiagnostic?: (message: string, detail?: unknown) => void
}

export interface ClientHandle {
  command(command: ClientCommand): void
  dispose(): void
}

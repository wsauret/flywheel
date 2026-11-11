import { Schema } from "effect"
import { defineProtocolDomain, defineProtocolModule, defineProtocolMutation } from "../protocol-module.js"
import type { RuntimePosition } from "../runtime-ui-protocol-types.js"

/** What the runtime publishes about its remote reachability: whether this
 *  account has paired devices, whether this placement holds a relay control
 *  channel, and how many remote clients are attached. One view, replaced
 *  whole on every change. */
export type RemoteConnectionState = "off" | "connecting" | "connected" | "reconnecting"

/** The relay attachment as a person reads it: attached or not, never the
 *  transport's own state. A lost attachment says so with its reason; the
 *  machine is already reattaching on its own. */
function relayReading(connection: RemoteConnectionState): string {
  switch (connection) {
    case "connected": return "attached"
    case "off": return "off"
    case "connecting": return "not attached yet"
    case "reconnecting": return "not attached; the relay dropped the machine"
  }
}

interface RemotePairedDeviceView {
  readonly id: string
  readonly label: string
  readonly pairedAt: number
  /** Whether this device registered a Web Push subscription. */
  readonly notifies: boolean
  /** Whether this device holds a channel to this placement right now. */
  readonly attached: boolean
}

/** The `PushSubscriptionJSON` a browser hands out, as the runtime stores it. */
export interface RemotePushSubscription {
  readonly endpoint: string
  readonly expirationTime: number | null
  readonly keys: { readonly p256dh: string; readonly auth: string }
}

/** An open pairing window. `code` is the URL the QR code carries, and it is
 *  the whole credential until `expiresAt`. */
export interface RemotePairingWindowView {
  readonly windowId: string
  readonly code: string
  readonly expiresAt: number
}

export interface RuntimeRemoteView {
  readonly relayUrl: string
  readonly connection: RemoteConnectionState
  readonly devices: readonly RemotePairedDeviceView[]
  readonly attachedClients: number
  readonly pairing: RemotePairingWindowView | null
  /** What keeps remote access from working, with its cause: the account's
   *  relay service for asleep projects while it could not start, and the last
   *  control-channel refusal or failure until the next attach succeeds. */
  readonly lastError: string | null
  /** The runtime's VAPID public key (raw P-256, base64url), which a device
   *  subscribes to push with. Null until the identity exists. */
  readonly pushPublicKey: string | null
  /** Projects this account service has opened and can open again. */
  readonly projects: readonly RemoteProjectView[]
  /** Present only when this runtime owns installed-system service registration. */
  readonly processInitiation?: "on" | "off" | "unavailable"
  /** The account's name as logind states it, present only on Linux while
   *  Process initiation is on and lingering is still off for the account
   *  after registration asked logind to turn it on: the
   *  service then stops at the account's last logout, and each client shows
   *  `lingerNotice` under Process initiation. A client of an earlier release
   *  ignores the field. */
  readonly lingerOffFor?: string
}

interface RemoteProjectView {
  readonly placementId: string
  readonly projectRoot: string
  readonly displayPath: string
  readonly projectLabel: string
  readonly lastAttachedAt: number
  readonly state: "open" | "asleep"
}

interface RuntimeRemoteSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly remote: RuntimeRemoteView
}

type RemotePatchPayload = { readonly kind: "remote.changed"; readonly remote: RuntimeRemoteView }

export type RemoteMutationResult =
  | { readonly kind: "committed" }
  | { readonly kind: "rejected"; readonly message: string }

const RuntimePositionSchema = Schema.Number
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const RuntimeRemoteViewSchema: Schema.Codec<RuntimeRemoteView> = Schema.Struct({
  relayUrl: Schema.String,
  connection: Schema.Literals(["off", "connecting", "connected", "reconnecting"]),
  devices: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, pairedAt: Schema.Number, notifies: Schema.Boolean, attached: Schema.Boolean })),
  attachedClients: NonNegativeInt,
  pairing: Schema.NullOr(Schema.Struct({ windowId: Schema.String, code: Schema.String, expiresAt: Schema.Number })),
  lastError: Schema.NullOr(Schema.String),
  pushPublicKey: Schema.NullOr(Schema.String),
  projects: Schema.Array(Schema.Struct({ placementId: Schema.String, projectRoot: Schema.String, displayPath: Schema.String, projectLabel: Schema.String, lastAttachedAt: Schema.Number, state: Schema.Literals(["open", "asleep"]) })),
  processInitiation: Schema.optional(Schema.Literals(["on", "off", "unavailable"])),
  lingerOffFor: Schema.optional(Schema.String),
})
const RemotePushSubscriptionSchema = Schema.Struct({ endpoint: Schema.String, expirationTime: Schema.NullOr(Schema.Number), keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String }) })
const RuntimeRemoteSnapshotResultSchema: Schema.Codec<RuntimeRemoteSnapshotResult> = Schema.Struct({ snapshotPosition: RuntimePositionSchema, remote: RuntimeRemoteViewSchema })
const RemotePatchPayloadSchema: Schema.Codec<RemotePatchPayload> = Schema.Struct({ kind: Schema.Literal("remote.changed"), remote: RuntimeRemoteViewSchema })
const RemoteMutationResultSchema: Schema.Codec<RemoteMutationResult> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("committed") }),
  Schema.Struct({ kind: Schema.Literal("rejected"), message: Schema.String }),
])


export const remoteDomain = defineProtocolDomain({
  domain: "remote",
  scope: "workspace",
  delivery: "latest-collapsible",
  content: "whole-value",
  snapshot: { query: "remoteSnapshot", result: RuntimeRemoteSnapshotResultSchema, deadline: "control" },
  patch: RemotePatchPayloadSchema,
  view: { snapshot: (result) => result.remote, patch: (payload) => payload.remote },
  // The relay drops a machine that stops answering, and every attachment
  // with it (PI-REMOTE-004).
  unanswered: (view) => ({
    ...view,
    connection: view.connection === "connected" ? "reconnecting" : view.connection,
    attachedClients: 0,
    devices: view.devices.map((device) => device.attached ? { ...device, attached: false } : device),
  }),
})
export const remoteCursor = () => ({ scope: "workspace", domain: remoteDomain.domain } as const)
export const REMOTE_SURFACE = "remote"
export const REMOTE_COMMAND = "remote"
/** The command's one name, which its surface also heads with. */
export const REMOTE_COMMAND_NAME = "Remote access"
/** The line that every view of a pairing code shows with it, because a phone
 *  that already has Flywheel on its Home Screen pairs by scanning the code
 *  from the app's Machines list, not with the camera (PI-REMOTE-034). */
export const PAIR_FROM_INSTALLED_APP = "If Flywheel is on your phone's Home Screen, open it, open Machines, and tap Scan a code."

/** A disabled module publishes no retained device or reachability state. */
export const EMPTY_REMOTE_VIEW: RuntimeRemoteView = {
  relayUrl: "", connection: "off", devices: [], attachedClients: 0,
  pairing: null, lastError: null, pushPublicKey: null, projects: [],
}
const mutation = { result: RemoteMutationResultSchema, policy: "lossless", editor: "omitted", refuse: (message: string): RemoteMutationResult => ({ kind: "rejected", message }) } as const
const open = { kind: "surface", id: REMOTE_SURFACE } as const
export const remoteProtocol = defineProtocolModule({
  id: "remote",
  domains: [remoteDomain],
  mutations: [
    defineProtocolMutation({ ...mutation, type: "remote.pair.open", fields: {} }),
    defineProtocolMutation({ ...mutation, type: "remote.pair.cancel", fields: {} }),
    defineProtocolMutation({ ...mutation, type: "remote.device.revoke", fields: { deviceId: Schema.String } }),
    defineProtocolMutation({ ...mutation, type: "remote.device.rename", fields: { deviceId: Schema.String, label: Schema.NonEmptyString } }),
    defineProtocolMutation({ ...mutation, type: "remote.push.subscribe", fields: { deviceId: Schema.String, subscription: RemotePushSubscriptionSchema } }),
    defineProtocolMutation({ ...mutation, type: "remote.push.unsubscribe", fields: { deviceId: Schema.String } }),
    defineProtocolMutation({ ...mutation, type: "remote.project.forget", fields: { placementId: Schema.String } }),
    defineProtocolMutation({ ...mutation, type: "remote.process_initiation.set", fields: { enabled: Schema.Boolean } }),
  ],
  rows: {
    settings: (read) => {
      const view = read(remoteDomain)
      return view === undefined ? [] : [{ id: "remote", label: REMOTE_COMMAND_NAME, value: `${view.devices.length} paired`, hint: "Pair devices and manage access to this machine", action: open }]
    },
    status: (read) => {
      const view = read(remoteDomain)
      return view === undefined ? [] : [
        { id: "remote-relay", label: "Remote relay", value: relayReading(view.connection), action: open },
        { id: "remote-devices", label: "Paired devices", value: `${view.devices.length} paired, ${view.attachedClients} attached`, action: open },
      ]
    },
  },
  composer: {
    status: (read, surface = "terminal") => {
      if (surface === "webview") return []
      const view = read(remoteDomain)
      if (!view || (view.devices.length === 0 && view.pairing === null)) return []
      if (view.pairing !== null) return [{ id: "remote", text: "pairing", action: open }]
      if (view.attachedClients > 0) return [{ id: "remote", text: `${view.attachedClients} remote`, suffix: { text: "✓", tone: "success" as const }, action: open }]
      if (view.connection === "connected") return [{ id: "remote", text: "remote control", suffix: { text: "✓", tone: "success" as const }, action: open }]
      return view.connection === "off" ? [] : [{ id: "remote", text: "remote control…", action: open }]
    },
  },
})

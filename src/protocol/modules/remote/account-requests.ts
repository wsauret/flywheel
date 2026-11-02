import { Schema } from "effect"

/** What `flywheel remote` asks the account service on an account attach that
 *  opens no project (`AccountAttach` intent `module`). A pairing window opens
 *  on the machine placement and closes when the request leaves. `relayUrl`
 *  pairs through another relay than the store names, and the store keeps it
 *  once a device pairs. */
const RemoteAccountRequestSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("remote.pair.open"), relayUrl: Schema.optionalKey(Schema.NonEmptyString) }),
  Schema.Struct({ type: Schema.Literal("remote.device.revoke"), deviceId: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("remote.project.forget"), projectRoot: Schema.NonEmptyString }),
])
export type RemoteAccountRequest = typeof RemoteAccountRequestSchema.Type

/** The account service's answers. A revoke or a forget gets one `result`. A
 *  pairing gets its window as `pairing`, a `relay` answer at each change of
 *  the machine placement's attachment, and then `paired` with the device's
 *  label, `expired` when the window closed with no device, or `stopped` when
 *  the service stopped first, as it does when it restarts with new settings
 *  or the module turns off. */
const RemoteAccountAnswerSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("result"), kind: Schema.Literal("committed") }),
  Schema.Struct({ type: Schema.Literal("result"), kind: Schema.Literal("rejected"), message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("pairing"), code: Schema.String, expiresAt: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("relay"), connection: Schema.Literals(["off", "connecting", "connected", "reconnecting"]), lastError: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("paired"), label: Schema.String }),
  Schema.Struct({ type: Schema.Literal("expired") }),
  Schema.Struct({ type: Schema.Literal("stopped") }),
])
export type RemoteAccountAnswer = typeof RemoteAccountAnswerSchema.Type

/** Strict: the request arrives at the service from a client of the same lane. */
export const decodeRemoteAccountRequest = Schema.decodeUnknownSync(RemoteAccountRequestSchema, { onExcessProperty: "error" })
export const decodeRemoteAccountAnswer = Schema.decodeUnknownSync(RemoteAccountAnswerSchema)

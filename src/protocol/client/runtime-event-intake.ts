import { Schema } from "effect"
import type { RuntimeEventFrame } from "../app-service-types.js"
import type { RuntimeClientDiagnostic } from "../runtime-client-diagnostics.js"
import { RuntimeCursorDescriptorSchema } from "../runtime-client-diagnostics.js"
import { RuntimeCursorIdentitySchema } from "../runtime-cursor-schemas.js"
import {
  RuntimeEventFrameSchema,
  RuntimeUiPatchPayloadSchema,
} from "../runtime-protocol-schemas.js"
import { stringDiscriminatorLiterals } from "../schema-union.js"

const OuterEventSchema = Schema.Struct({ type: Schema.String })
const PatchHeaderSchema = Schema.Struct({
  type: Schema.Literal("patch"),
  patch: Schema.Struct({
    cursor: RuntimeCursorDescriptorSchema,
    payload: Schema.Struct({ kind: Schema.String }),
  }),
})

const supportedEventTypes = new Set(stringDiscriminatorLiterals(RuntimeEventFrameSchema, "type"))
const supportedPayloadKinds = new Set(stringDiscriminatorLiterals(RuntimeUiPatchPayloadSchema, "kind"))
const supportedCursorDomains = new Map<string, ReadonlySet<string>>(
  RuntimeCursorIdentitySchema.members.map((member) => [
    member.fields.scope.literal,
    new Set(member.fields.domain.members.map((domain) => domain.literal)),
  ]),
)

const decodeOuterEvent = Schema.decodeUnknownSync(OuterEventSchema)
const decodePatchHeader = Schema.decodeUnknownSync(PatchHeaderSchema)
const decodeCursorIdentity = Schema.decodeUnknownSync(RuntimeCursorIdentitySchema)
const decodeFrame = Schema.decodeUnknownSync(RuntimeEventFrameSchema)

type RuntimeEventIntakeResult =
  | { readonly kind: "frame"; readonly frame: RuntimeEventFrame }
  | { readonly kind: "unsupported"; readonly diagnostic: RuntimeClientDiagnostic }

/** Decode one event-lane value without letting a future discriminated variant end the stream.
 * Unsupported variants return metadata only. Malformed known frames throw.
 * The caller owns diagnostic delivery and ordinary cursor-gap recovery. */
export function decodeRuntimeEventFrame(input: unknown): RuntimeEventIntakeResult {
  const outer = decodeOuterEvent(input)
  if (!supportedEventTypes.has(outer.type)) {
    return { kind: "unsupported", diagnostic: { kind: "unsupported_event", eventType: outer.type } }
  }
  if (outer.type !== "patch") {
    return { kind: "frame", frame: decodeFrame(input) }
  }

  const header = decodePatchHeader(input)
  const domains = supportedCursorDomains.get(header.patch.cursor.scope)
  if (domains === undefined || !domains.has(header.patch.cursor.domain)) {
    return {
      kind: "unsupported",
      diagnostic: {
        kind: "unsupported_patch",
        cursor: header.patch.cursor,
        payloadKind: header.patch.payload.kind,
      },
    }
  }

  decodeCursorIdentity(header.patch.cursor)
  if (!supportedPayloadKinds.has(header.patch.payload.kind)) {
    return {
      kind: "unsupported",
      diagnostic: {
        kind: "unsupported_patch",
        cursor: header.patch.cursor,
        payloadKind: header.patch.payload.kind,
      },
    }
  }
  return { kind: "frame", frame: decodeFrame(input) }
}

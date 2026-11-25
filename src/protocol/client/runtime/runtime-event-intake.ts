import { Schema } from "effect"
import { isRecord } from "../../../infra/record.js"
import type { RuntimeEventFrame } from "../../runtime/app-service-types.js"
import type { RuntimeClientDiagnostic } from "../../runtime/runtime-client-diagnostics.js"
import { RuntimeCursorIdentitySchema } from "../../rpc/runtime-cursor-schemas.js"
import {
  RuntimeEventFrameSchema,
  RuntimeUiPatchPayloadSchema,
} from "../../rpc/runtime-protocol-schemas.js"
import { stringDiscriminatorLiterals } from "../../rpc/schema-union.js"

const supportedEventTypes = new Set(stringDiscriminatorLiterals(RuntimeEventFrameSchema, "type"))
const supportedPayloadKinds = new Set(stringDiscriminatorLiterals(RuntimeUiPatchPayloadSchema, "kind"))
const supportedCursorDomains = new Map<string, ReadonlySet<string>>(
  RuntimeCursorIdentitySchema.members.map((member) => [
    member.fields.scope.literal,
    new Set(member.fields.domain.members.map((domain) => domain.literal)),
  ]),
)

const decodeFrame = Schema.decodeUnknownSync(RuntimeEventFrameSchema)

type RuntimeEventIntakeResult =
  | { readonly kind: "frame"; readonly frame: RuntimeEventFrame }
  | { readonly kind: "unsupported"; readonly diagnostic: RuntimeClientDiagnostic }

/** Decode one event-lane value without letting a future discriminated variant end the stream.
 * Unsupported variants return metadata only. Malformed known frames throw.
 * The caller owns diagnostic delivery and ordinary cursor-gap recovery.
 *
 * The discriminators are read as plain properties, so a frame pays one schema
 * decode. A value whose discriminators are missing or are not strings names no
 * variant, and the full decode refuses it. */
export function decodeRuntimeEventFrame(input: unknown): RuntimeEventIntakeResult {
  const type = isRecord(input) ? input["type"] : undefined
  if (typeof type === "string" && !supportedEventTypes.has(type)) {
    return { kind: "unsupported", diagnostic: { kind: "unsupported_event", eventType: type } }
  }
  const unsupported = type === "patch" && isRecord(input) ? unsupportedPatch(input["patch"]) : undefined
  return unsupported ?? { kind: "frame", frame: decodeFrame(input) }
}

function unsupportedPatch(patch: unknown): RuntimeEventIntakeResult | undefined {
  if (!isRecord(patch) || !isRecord(patch["cursor"]) || !isRecord(patch["payload"])) return undefined
  const { scope, domain, sessionId, workflowId } = patch["cursor"]
  const payloadKind = patch["payload"]["kind"]
  if (typeof scope !== "string" || typeof domain !== "string" || typeof payloadKind !== "string") return undefined
  if (supportedCursorDomains.get(scope)?.has(domain) === true && supportedPayloadKinds.has(payloadKind)) return undefined
  return {
    kind: "unsupported",
    diagnostic: {
      kind: "unsupported_patch",
      cursor: {
        scope,
        domain,
        ...(typeof sessionId === "string" ? { sessionId } : {}),
        ...(typeof workflowId === "string" ? { workflowId } : {}),
      },
      payloadKind,
    },
  }
}

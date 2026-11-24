import { Schema, type SchemaAST } from "effect"
import { RuntimeEventFrameSchema } from "../../src/protocol/rpc/runtime-protocol-schemas.js"
import type { RuntimeUiPatch } from "../../src/protocol/runtime/runtime-ui-protocol-types.js"

/** Decodes `patch` as a client reads it: inside the event frame that carries
 *  it on the wire. Throws when the frame schema refuses the patch. */
export function decodeRuntimeUiPatch(patch: unknown, options?: SchemaAST.ParseOptions): RuntimeUiPatch {
  const frame = Schema.decodeUnknownSync(RuntimeEventFrameSchema, options)({ type: "patch", patch })
  if (frame.type !== "patch") throw new Error(`Expected a patch frame, got ${frame.type}`)
  return frame.patch
}

/** Encodes `patch` as the runtime writes it: inside the event frame that
 *  carries it on the wire. Throws when the frame schema refuses the patch. */
export function encodeRuntimeUiPatch(patch: RuntimeUiPatch): unknown {
  const frame = Schema.encodeUnknownSync(RuntimeEventFrameSchema)({ type: "patch", patch })
  if (frame.type !== "patch") throw new Error(`Expected a patch frame, got ${frame.type}`)
  return frame.patch
}

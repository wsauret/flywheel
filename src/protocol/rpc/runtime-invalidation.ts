import type { RuntimeUiPatch, RuntimeUiPatchPayload } from "../runtime/runtime-ui-protocol-types.js"

/** Guards for the `runtime.invalidate` directive. Each one narrows the payload
 *  union of every domain, so they sit above the domain payload types. */

export function isRuntimeInvalidationPayload(payload: RuntimeUiPatchPayload): payload is Extract<RuntimeUiPatchPayload, { readonly kind: "runtime.invalidate" }> {
  return payload.kind === "runtime.invalidate"
}

/** A workspace runtime directive repairs every resident cursor, not only the runtime domain. */
export function isGlobalRuntimeInvalidation(patch: RuntimeUiPatch): boolean {
  return patch.cursor.scope === "workspace" && patch.cursor.domain === "runtime" && isRuntimeInvalidationPayload(patch.payload)
}

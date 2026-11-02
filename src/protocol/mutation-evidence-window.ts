import type { MutationFilesResult, MutationPatchWindowResult } from "./mutation-evidence-protocol-types.js"
import type { SessionChangesResult } from "./session-changes-protocol-types.js"

type EvidenceResult = MutationFilesResult | MutationPatchWindowResult | SessionChangesResult
type AvailableResult = Exclude<EvidenceResult, { readonly kind: "unavailable" }>

export function fitMutationEvidenceWindow(result: MutationFilesResult, maxBytes: number, measure: (result: EvidenceResult) => number): MutationFilesResult
export function fitMutationEvidenceWindow(result: MutationPatchWindowResult, maxBytes: number, measure: (result: EvidenceResult) => number): MutationPatchWindowResult
export function fitMutationEvidenceWindow(result: SessionChangesResult, maxBytes: number, measure: (result: EvidenceResult) => number): SessionChangesResult
export function fitMutationEvidenceWindow(result: EvidenceResult, maxBytes: number, measure: (result: EvidenceResult) => number): EvidenceResult
/** Keep the longest prefix of a selected page that fits its caller's complete encoded response.
 * Reject a budget that cannot carry metadata and one remaining item or byte.
 * The last measure call is always the returned window, so the callback may retain its encoded frame. */
export function fitMutationEvidenceWindow(result: EvidenceResult, maxBytes: number, measure: (result: EvidenceResult) => number): EvidenceResult {
  if (measure(result) <= maxBytes) return result
  if ("kind" in result && result.kind === "unavailable") throw new Error("Mutation evidence maxBytes cannot fit response metadata")
  // An encoded page grows with its item count, so the largest fitting prefix is found by bisection.
  let fits = 0
  let fails = itemCount(result)
  while (fails - fits > 1) {
    const middle = Math.floor((fits + fails) / 2)
    if (measure(prefix(result, middle)) <= maxBytes) fits = middle
    else fails = middle
  }
  if (fits === 0) throw new Error(tooSmall(result))
  const window = prefix(result, fits)
  measure(window)
  return window
}

function itemCount(window: AvailableResult): number {
  return "files" in window ? window.files.length : window.servedBytes
}

function tooSmall(window: AvailableResult): string {
  if ("status" in window) return "Session changes maxBytes cannot fit response metadata and a file"
  if ("files" in window) return "Mutation evidence maxBytes cannot fit a file descriptor"
  return "Mutation evidence maxBytes cannot fit response metadata and one byte"
}

function prefix(window: AvailableResult, count: number): AvailableResult {
  if ("status" in window) return { ...window, files: window.files.slice(0, count), nextOffset: window.offset + count }
  if ("files" in window) return { ...window, files: window.files.slice(0, count), nextOffset: window.offset + count }
  const bytes = atob(window.base64).slice(0, count)
  return { ...window, servedBytes: bytes.length, base64: btoa(bytes), nextOffset: window.offset + bytes.length }
}

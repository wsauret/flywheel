import type { RuntimeQuery } from "../../protocol/app-service-types.js"
import { RUNTIME_READ_DOMAINS } from "../../protocol/runtime-protocol-schemas.js"
import { PROTOCOL_MODULE_DOMAINS } from "../../protocol/modules.js"
import {
  classifyRuntimeUiPatch,
  cursorKey,
  isRuntimeInvalidationPayload,
  runtimePatchContent,
  type RuntimeCursorIdentity,
  type RuntimeCursorState,
  type RuntimePatchClassification,
  type RuntimePosition,
  type RuntimeUiDomain,
  type RuntimeUiPatch,
  type RuntimeUiPatchInput,
} from "../../protocol/runtime-ui-protocol-types.js"

/** What one read takes its position from, and which baselines it voids.
 *  A cursor anchor reports that cursor's last publication. A workspace anchor
 *  reports the global published watermark and names every domain whose
 *  cursors the read's answer seeds; it can name none. */
export type RuntimeReadAnchor =
  | { readonly kind: "cursor"; readonly cursor: RuntimeCursorIdentity }
  | { readonly kind: "workspace"; readonly domains: readonly RuntimeUiDomain[] }

/** The anchor of a query that the read-domain table covers. */
export function runtimeReadAnchor(query: RuntimeQuery | RuntimeQuery["type"]): RuntimeReadAnchor {
  const type = typeof query === "string" ? query : query.type
  if (typeof query !== "string" && "workflowId" in query) {
    const domain = PROTOCOL_MODULE_DOMAINS.find((entry) => entry.snapshot.query === type)
    if (domain?.scope === "workflow") return { kind: "cursor", cursor: { scope: "workflow", domain: domain.domain, workflowId: query.workflowId } }
  }
  return { kind: "workspace", domains: RUNTIME_READ_DOMAINS[type] }
}

/** The runtime-owned publication authority. Only `publish` mints positions.
 *  `Published` is `RuntimeUiPatch` when every publication mints one, and
 *  includes `undefined` when publish-on-change can decline an equal repeat. */
export interface RuntimeUiPatchSequencer<Published extends RuntimeUiPatch | undefined = RuntimeUiPatch | undefined> {
  /** The position a read reports, so a resnapshot is anchored, not guessed.
   *  The read changes no chain. It voids the publish-on-change baselines of
   *  the cursors it seeds, in the same synchronous call, so the next value
   *  on each of them publishes. */
  snapshotPosition(anchor: RuntimeReadAnchor): RuntimePosition
  /** Stamps `position` and `prevPosition` onto a publisher's input and
   *  advances the named cursor. A declined repeat returns `undefined`, mints
   *  no position, and leaves the cursor's chain where it was. */
  publish(input: RuntimeUiPatchInput): Published
  classify(patch: RuntimeUiPatch, against: RuntimeCursorState): RuntimePatchClassification
}

export interface RuntimeUiPatchSequencerOptions {
  /** Declines a whole-value patch equal to the last one published on its
   *  cursor when no read of the cursor's domain came after that publication.
   *  Only a bus whose every reader holds what it last received may set it. */
  readonly publishOnChange?: boolean
}

/** Only publication advances the global position and the named cursor's chain.
 * Snapshot reads observe either that cursor's last publication or the global
 * published watermark. They never allocate cursor state or change any chain,
 * so one client's read cannot disturb another client's ordered intake.
 *
 * A declined repeat is safe for every receiver: the cursor's next publication
 * still names the last position delivered on it as `prevPosition`, and a
 * receiver holds that position or a later read of it. */
export function createRuntimeUiPatchSequencer(): RuntimeUiPatchSequencer<RuntimeUiPatch>
export function createRuntimeUiPatchSequencer(options: RuntimeUiPatchSequencerOptions): RuntimeUiPatchSequencer
export function createRuntimeUiPatchSequencer(options: RuntimeUiPatchSequencerOptions = {}): RuntimeUiPatchSequencer {
  let next: RuntimePosition = 0
  const chainFrom = new Map<string, RuntimePosition>()
  // Per domain, the hash of each cursor's last publication when that
  // publication states a whole value. Keyed by domain first, so a read
  // voids a whole domain at once.
  const baselines = new Map<RuntimeUiDomain, Map<string, number | bigint>>()

  function snapshotPosition(anchor: RuntimeReadAnchor): RuntimePosition {
    if (anchor.kind === "cursor") {
      const key = cursorKey(anchor.cursor)
      baselines.get(anchor.cursor.domain)?.delete(key)
      return chainFrom.get(key) ?? 0
    }
    for (const domain of anchor.domains) baselines.delete(domain)
    return next
  }

  /** Records the cursor's new baseline, or reports that the input repeats it. */
  function repeatsBaseline(input: RuntimeUiPatchInput, key: string): boolean {
    const domain = input.cursor.domain
    if (isRuntimeInvalidationPayload(input.payload) || runtimePatchContent(domain) !== "whole-value") {
      baselines.get(domain)?.delete(key)
      return false
    }
    // The same encoding as the auth publication baseline. No whole-value view
    // holds a Map, a Set, binary data, a bigint, or a Date.
    const hash = Bun.hash(JSON.stringify(input.payload))
    const cursors = baselines.get(domain) ?? new Map<string, number | bigint>()
    if (cursors.get(key) === hash) return true
    cursors.set(key, hash)
    baselines.set(domain, cursors)
    return false
  }

  function publish(input: RuntimeUiPatchInput): RuntimeUiPatch | undefined {
    const key = cursorKey(input.cursor)
    if (options.publishOnChange && repeatsBaseline(input, key)) return undefined
    const prevPosition = chainFrom.get(key) ?? 0
    const position = ++next
    chainFrom.set(key, position)
    return { cursor: input.cursor, position, prevPosition, payload: input.payload }
  }

  return { snapshotPosition, publish, classify: classifyRuntimeUiPatch }
}

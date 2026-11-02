import { Schema } from "effect"
import { errorMessage } from "./error-message.js"
import type { StoredFact } from "./event-store-types.js"
import { InvariantViolation } from "./invariant.js"
import { TOOL_CONTENT_REFERENCE_FACT_DEFINITIONS } from "./runtime-fact-types.js"
import {
  chatEntryToolContentReferences,
  resolveToolContentReference,
  TOOL_TEXT_SITES,
  type ContentResolver,
  type ToolContentReference,
  type ToolTextSite,
} from "./tool-content.js"
import type { ToolOutcome } from "./tool-outcome.js"

// The reference-capable stored versions (tool output dedup). Hydration is
// their only reader: it lowers versions 2 and 4 to inline versions 1 and 3,
// so projections never receive ordinary tool-text references.
const STORED_REFERENCE_VERSIONS = TOOL_CONTENT_REFERENCE_FACT_DEFINITIONS.map((definition) => ({
  type: definition.type,
  version: definition.version,
  decode: Schema.decodeUnknownSync(definition.payload, { onExcessProperty: "error" }),
}))

/** The reference-capable definition that `fact` is stored at, or undefined
 *  for any other type or version. */
function storedReferenceVersion(fact: StoredFact): typeof STORED_REFERENCE_VERSIONS[number] | undefined {
  return STORED_REFERENCE_VERSIONS.find(({ type, version }) => type === fact.type && version === fact.version)
}

/** The sites of `fact` that hold a reference. */
function referenceSites(fact: StoredFact, type: keyof typeof TOOL_TEXT_SITES): (ToolTextSite & { readonly text: ToolContentReference })[] {
  return TOOL_TEXT_SITES[type](fact.payload).flatMap((site) => typeof site.text === "string" ? [] : [{ ...site, text: site.text }])
}

/** Every tool-content reference one stored fact holds: the references at the
 *  `TOOL_TEXT_SITES` of a reference-capable tool fact version, and the
 *  toolResult reference parts of `chat.entries.appended`. A reader that loads
 *  content for a page asks for these rows and no others. A malformed site
 *  holds no reference here, because its hydration reports it. */
export function storedToolContentReferences(fact: StoredFact): ToolContentReference[] {
  if (fact.type === "chat.entries.appended") return chatEntryToolContentReferences(fact.payload)
  const stored = storedReferenceVersion(fact)
  return stored === undefined ? [] : referenceSites(fact, stored.type).map(({ text }) => text)
}

/** Lower one stored fact to its inline shape. A version-2 or version-4 tool
 *  result/output row comes back as a version-1 or version-3 copy whose
 *  references at its `TOOL_TEXT_SITES` are resolved to exact, sha256-verified
 *  text; every other fact returns unchanged (so the map is idempotent). Failed
 *  resolution and a malformed stored payload both throw the canonical
 *  InvariantViolation. */
export function hydrateToolContentFact(fact: StoredFact, toolContent: ContentResolver): StoredFact {
  const stored = storedReferenceVersion(fact)
  if (stored === undefined) return fact
  decodeStoredPayload(fact, stored.decode)
  const inlined = referenceSites(fact, stored.type).map((site) => [site.field, site.replace(resolveReference(fact, toolContent, site.text))])
  return { ...fact, version: fact.version === 4 ? 3 : 1, payload: { ...fact.payload, ...Object.fromEntries(inlined) } }
}

function resolveReference(fact: StoredFact, toolContent: ContentResolver, reference: ToolContentReference): string {
  return resolveToolContentReference(toolContent, fact.sessionId, reference, {
    eventType: fact.type,
    eventPosition: fact.position,
    aggregateId: fact.aggregateId,
  })
}

/** The call that a reference-capable tool fact names, and the outcome that a
 *  result fact records, decoded strictly from its stored version without
 *  resolving any content, or undefined for every other fact. A reader that
 *  needs only which call a fact names, or how a call ended, loads no tool
 *  content through this. */
export function storedToolCallIdentity(fact: StoredFact): { readonly toolUseId: string; readonly parentToolUseId?: string; readonly modelRequestId?: string; readonly outcome?: ToolOutcome } | undefined {
  const stored = storedReferenceVersion(fact)
  if (stored === undefined) return undefined
  const payload = decodeStoredPayload(fact, stored.decode)
  const { toolUseId, parentToolUseId, modelRequestId } = payload
  return {
    toolUseId,
    ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
    ...(modelRequestId === undefined ? {} : { modelRequestId }),
    ...("outcome" in payload ? { outcome: payload.outcome } : {}),
  }
}

function decodeStoredPayload<T>(fact: StoredFact, decode: (value: unknown) => T): T {
  try {
    return decode(fact.payload)
  } catch (err) {
    throw new InvariantViolation(
      {
        kind: "schema-mismatch",
        eventType: fact.type,
        eventPosition: fact.position,
        aggregateId: fact.aggregateId,
        detail: `version ${fact.version} (${fact.id}): ${errorMessage(err)}`,
      },
      { cause: err },
    )
  }
}

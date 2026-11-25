import type { EventStoreWriteItem, FactQuery, FoldEvidenceRequest } from "../../../infra/substrate/store/event-store-types.js"
import type { SessionContentNodeRow, SessionContentReference } from "../../../infra/substrate/session-content.js"
import type { ToolContentReference } from "../../../infra/substrate/runtime-facts/tool-content.js"
import type { ProjectStateSessionCommand } from "./project-state-sessions.js"

/** The operations a project state client asks of the state Worker, in their
 *  canonical in-memory shape. The request codec and the payload codec both
 *  read them, so they live below both. */

interface ProjectStateFactPageRequest {
  readonly kind: "facts.page"
  readonly query: FactQuery
  readonly upperPosition?: number
  readonly content?: "eager" | "deferred"
  readonly afterPosition?: number
  readonly maxRows: number
  readonly maxBytes: number
  readonly tolerant?: boolean
  /** Asks for the fold evidence of `query` with the page (ARCH-SUBSTRATE-046). */
  readonly evidence?: FoldEvidenceRequest
}

export interface ProjectStateContentReference {
  readonly sessionId: string
  readonly reference: ToolContentReference
  readonly fact: {
    readonly eventType: string
    readonly eventPosition: number
    readonly aggregateId: string
  }
}

export type ProjectStateControlOperation =
  | { readonly kind: "position.capture" }
  | { readonly kind: "facts.latest-position"; readonly type: string }
  | { readonly kind: "facts.latest-payload"; readonly aggregateId: string; readonly type: string }
  | { readonly kind: "facts.latest-by-types"; readonly aggregateId: string; readonly types: readonly string[] }
  | { readonly kind: "facts.slice"; readonly query: FactQuery; readonly tolerant?: boolean; readonly maxRows: number; readonly maxBytes: number }
  | { readonly kind: "in-flight.read"; readonly sessionId: string; readonly kinds: readonly string[]; readonly keyPrefix?: string }
  | { readonly kind: "in-flight.sessions"; readonly inFlightKind: string }
  | { readonly kind: "in-flight.profile"; readonly inFlightKind: string; readonly profileId: string }
  | { readonly kind: "aggregate.count"; readonly aggregateId: string }
  | { readonly kind: "aggregate.sequence"; readonly aggregateId: string }
  | ProjectStateFactPageRequest
  | { readonly kind: "content.page"; readonly references: readonly ProjectStateContentReference[]; readonly offset?: number; readonly maxRows: number; readonly maxBytes: number }
  | { readonly kind: "content.stage"; readonly sessionId: string; readonly nodes: readonly SessionContentNodeRow[] }
  | { readonly kind: "content.node"; readonly sessionId: string; readonly sha256: string; readonly maxBytes: number }
  | { readonly kind: "content.range"; readonly sessionId: string; readonly reference: SessionContentReference; readonly offset: number; readonly length: number; readonly maxBytes: number }
  | { readonly kind: "append"; readonly item: EventStoreWriteItem }
  | { readonly kind: "append.batch"; readonly items: readonly EventStoreWriteItem[] }
  | { readonly kind: "maintenance.prune"; readonly aggregateId: string; readonly eventType: string }
  | { readonly kind: "maintenance.prune-keyed"; readonly aggregateId: string; readonly eventType: string; readonly payloadKey: string }
  /** Startup maintenance's store upkeep, which the sole writer runs in
   *  bounded steps: one chunk of one retired family, or the retired indexes. */
  | { readonly kind: "maintenance.prune-retired"; readonly eventType: string }
  | { readonly kind: "maintenance.drop-retired-indexes" }
  /** Idle reclaim's store upkeep, in the same bounded steps: one page of
   *  superseded rows of one family, or one incremental-vacuum step. */
  | { readonly kind: "maintenance.prune-superseded"; readonly eventType: string; readonly positions: readonly number[] }
  | { readonly kind: "maintenance.incremental-vacuum"; readonly pages: number }
  | { readonly kind: "maintenance.finalized-checkpoints"; readonly afterRowid: number; readonly throughRowid: number; readonly evidencePositions: readonly number[] }
  | { readonly kind: "session.control"; readonly command: ProjectStateSessionCommand }

export type ProjectStateExecutionOperation =
  | { readonly kind: "generation.admit"; readonly projectId: string; readonly generation: number }
  | { readonly kind: "execution.operation"; readonly projectId: string; readonly generation: number; readonly operation: ProjectStateControlOperation }
  | { readonly kind: "generation.close"; readonly projectId: string; readonly generation: number }
  /** `interruptedSessionIds` names the sessions a person was interrupting
   *  when the account ended the generation to stop them; their recovery
   *  records the person's interrupt instead of an unexpected exit. */
  | { readonly kind: "generation.recover"; readonly projectId: string; readonly generation: number; readonly interruptedSessionIds?: readonly string[] }

export type ProjectStateOperation = ProjectStateControlOperation | ProjectStateExecutionOperation

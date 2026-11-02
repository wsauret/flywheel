import type { EffortSchema } from "../infra/workflow-types.js"
import type { AccessProviderCandidate, ModelUnavailableMissing } from "../infra/llm/access-provider.js"

/** The one seat vocabulary: every model assignment addresses a role. The
 *  role id is open text because roles are user- and workflow-defined; the
 *  config layer owns which ids exist. */
export type ModelSelectionSlot = { kind: "role"; roleId: string }

export interface RuntimeSessionModelPlanQuery {
  readonly sessionId: string
  readonly slots: readonly ModelSelectionSlot[]
}

/** An inspection snapshot, not a request reservation or a guarantee of provider availability. */
export interface RuntimeSessionModelPlanResult {
  readonly sessionId: string
  readonly profile: { readonly persistedId: string; readonly effectiveId: string }
  readonly assignments: readonly ModelAssignmentRow[]
  readonly plans: readonly (
    | { readonly kind: "available"; readonly model: string; readonly candidates: readonly (AccessProviderCandidate & { readonly wireModelId: string })[] }
    | { readonly kind: "unavailable"; readonly model: string; readonly reason: string; readonly missing: ModelUnavailableMissing }
  )[]
}

export type ModelSelectionEffort = typeof EffortSchema.Type

export interface ModelAssignmentPatch {
  model?: string | null
  effort?: ModelSelectionEffort | null
}

/** Capability rank of a model within its family. `default` means the role
 *  default rather than a rank of its own. */
export type ModelTier = "default" | "powerful" | "mid" | "cheap"

export interface ModelAssignmentRow {
  slot: ModelSelectionSlot
  label: string
  model: string
  effort: ModelSelectionEffort
  modelSource: "explicit" | "default" | "inherited"
  matchesInheritedPair: boolean
  /** Authored model skipped by resolution. It is context, never a picker choice. */
  savedModel?: string
}

export interface ModelOptionRow {
  slot: ModelSelectionSlot
  model: string | null
  label: string
  tier?: ModelTier
  selectable: boolean
  current?: boolean
  inherit?: boolean
  efforts: readonly ModelSelectionEffort[]
  effort: ModelSelectionEffort
  /** Effective model selected by an inherit row. Display labels are presentation only. */
  inheritModel?: string
  /** This model is the role default for the slot; selecting it at the default
   *  effort clears the config entry so the seat floats with future changes. */
  roleDefault?: boolean
  reason?: string
  /** Each provider that can serve the model once, in first-appearance resolution order for this query's profile. */
  providers: readonly ModelOptionProvider[]
  cost?: {
    input: number
    output: number
    cacheRead?: number
  }
  catalogProvenance?: "first-party" | "first-party-cached" | "models-dev-live" | "models-dev-archive" | "models-dev-bundled" | "static"
}

/** One provider in a model's resolution order. */
export interface ModelOptionProvider {
  /** The full name, such as "ChatGPT Subscription". */
  readonly name: string
  /** The compact name, such as "ChatGPT". */
  readonly shortName: string
  /** This provider would serve a request for the model at the moment the query ran. At most one provider of a row
   *  serves, and none does when no provider can serve the model then. */
  readonly serving: boolean
}

export interface EffortOptionRow {
  slot: ModelSelectionSlot
  effort: ModelSelectionEffort | null
  label: string
  selectable: boolean
  current?: boolean
  inherit?: boolean
}

export type RuntimeModelAssignmentScope = { readonly kind: "defaults" } | { readonly kind: "session"; readonly sessionId: string }

/** Scope for writes. The compound member applies the write to the global
 *  defaults and mirrors it into the named session's role snapshot, so the
 *  modal's "new sessions and this tab" promise is one operation with one
 *  failure envelope owned by orchestration. */
export type RuntimeModelAssignmentWriteScope =
  | RuntimeModelAssignmentScope
  | { readonly kind: "defaults-and-session"; readonly sessionId: string }

export interface RuntimeModelAssignmentsQuery {
  readonly scope: RuntimeModelAssignmentScope
  readonly slots: readonly ModelSelectionSlot[]
}

export interface RuntimeModelOptionsQuery {
  readonly scope: RuntimeModelAssignmentScope
  readonly slot: ModelSelectionSlot
}

export interface RuntimeEffortOptionsQuery {
  readonly scope: RuntimeModelAssignmentScope
  readonly slot: ModelSelectionSlot
  readonly model: string | null
}

export interface RuntimeSaveModelEffortMutation {
  readonly scope: RuntimeModelAssignmentWriteScope
  readonly slot: ModelSelectionSlot
  readonly model: string | null
  readonly effort: ModelAssignmentPatch["effort"]
}

export interface RuntimeResetModelAssignmentsMutation {
  readonly scope: RuntimeModelAssignmentWriteScope
  readonly slots: readonly ModelSelectionSlot[]
}

export interface RuntimeSaveModelEffortResult {
  readonly label: string
  readonly warning?: string
  /** True when a compound-scope save was mirrored into the session snapshot. */
  readonly mirrored?: boolean
}

export interface RuntimeResetModelAssignmentsResult {
  readonly rows: readonly ModelAssignmentRow[]
  /** Set when a compound-scope reset updated defaults but not the session. */
  readonly warning?: string
  /** True when a compound-scope reset was mirrored into the session snapshot. */
  readonly mirrored?: boolean
}

export interface RuntimeGlobalDefaultRolesResult {
  readonly chat?: {
    readonly model: string
    readonly effort: ModelSelectionEffort
  }
}

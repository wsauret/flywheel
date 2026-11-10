import type { RuntimeChatDefault, RuntimeExecutorState, RuntimeServiceState, SessionCatalogRow, SessionCatalogSnapshot } from "./app-service-types.js"
import type { SessionDetailPatchPayload } from "./session-detail-protocol-types.js"
import type { CommandCatalogPatchPayload } from "./command-catalog-protocol-types.js"
import type { BudgetPatchPayload } from "./budget-protocol-types.js"
import type { OutputPatchPayload } from "./output-protocol-types.js"
import type { QuestionPatchPayload } from "./question-protocol-types.js"
import type { RolePatchPayload } from "./role-protocol-types.js"
import type { StatusPatchPayload } from "./status-protocol-types.js"
import type { UpdatePatchPayload } from "./update-protocol-types.js"
import type { ModulePatchPayload } from "./module-protocol-types.js"
import type { AuthPatchPayload } from "./auth-status-protocol-types.js"
import type { RuntimeConfigPatchPayload } from "./runtime-config-protocol-types.js"
import type { GitAiAttributionPatchPayload } from "./git-ai-attribution-protocol-types.js"
import type { GitPatchPayload } from "./git-protocol-types.js"
import type { CommandUsagePatchPayload } from "./command-usage-protocol-types.js"
import type { ChangesPatchPayload } from "./session-changes-protocol-types.js"
import type { BackgroundPatchPayload } from "./background-index-protocol-types.js"
import { isProtocolModuleDomain, protocolDomain, type ProtocolModuleDomainName, type ProtocolModulePatchPayload, type ProtocolModuleSessionDomain, type ProtocolModuleWorkspaceDomain, type ProtocolModuleWorkflowDomain } from "./modules.js"

/** The runtime/TUI protocol's own ordering authority. A `RuntimePosition` is
 *  minted by the runtime's patch sequencer, never by a
 *  patch publisher and never by a transport. Transport request/stream/RPC ids
 *  are correlation only and must not be used as replay positions. */
export type RuntimePosition = number

/** Domains the runtime publishes UI patches for. Session-scoped domains carry a
 *  real session id; workspace-scoped domains carry none, so a runtime-wide
 *  stream never smuggles a fake session id. The kernel states its domains
 *  here; a module states its own in its protocol home and the registry in
 *  `modules.ts` composes them in. */
export const KERNEL_SESSION_DOMAINS = ["session", "session_detail", "output", "status", "budget", "question", "roles", "auth", "changes", "background"] as const
export const KERNEL_WORKSPACE_DOMAINS = ["runtime", "auth", "commands", "updates", "modules", "config", "gitAiAttribution", "git", "commandUsage", "chat_default", "executor", "service"] as const
type RuntimeKernelDomain = (typeof KERNEL_SESSION_DOMAINS)[number] | (typeof KERNEL_WORKSPACE_DOMAINS)[number]
type RuntimeSessionScopedDomain = (typeof KERNEL_SESSION_DOMAINS)[number] | ProtocolModuleSessionDomain
type RuntimeWorkspaceScopedDomain = (typeof KERNEL_WORKSPACE_DOMAINS)[number] | ProtocolModuleWorkspaceDomain
export type RuntimeUiDomain = RuntimeSessionScopedDomain | RuntimeWorkspaceScopedDomain | ProtocolModuleWorkflowDomain

export interface RuntimeSessionCursorIdentity {
  readonly scope: "session"
  readonly domain: RuntimeSessionScopedDomain
  readonly sessionId: string
}

interface RuntimeWorkspaceCursorIdentity {
  readonly scope: "workspace"
  readonly domain: RuntimeWorkspaceScopedDomain
}

export interface RuntimeWorkflowCursorIdentity {
  readonly scope: "workflow"
  readonly domain: ProtocolModuleWorkflowDomain
  readonly workflowId: string
}
export type RuntimeCursorIdentity = RuntimeSessionCursorIdentity | RuntimeWorkspaceCursorIdentity | RuntimeWorkflowCursorIdentity

/** What a publisher hands the sequencer. It carries cursor identity and the
 *  domain payload, but never `position`/`prevPosition`: the single publish path
 *  mints those so no publisher can invent local ordering. */
export interface RuntimeUiPatchInput {
  readonly cursor: RuntimeCursorIdentity
  readonly payload: RuntimeUiPatchPayload
}

/** Why a `runtime.invalidate` voids a client's resident state. `overflow`
 * dropped patches on a healthy stream, so an after-edge replay repairs it.
 * `reconnect_required` is a workspace transport loss. `protocol_violation` is
 * a client-detected wire schema decode failure: the client and worker disagree
 * on the patch vocabulary, which is a producer bug no reconnect can heal. It
 * is log-only: not fatal and not user-actionable, so the UI ignores it.
 * `rebase` announces a new absolute coordinate baseline for a cursor (a
 * reactivated session's shell rebases block indexes onto the durable fold), so
 * the resident window itself is void, not just its tail. */
export type RuntimeInvalidationReason = "overflow" | "reconnect_required" | "protocol_violation" | "rebase"

/** What an ordered patch carries. The `session` cursor publishes one full
 * catalog row per changed session. The six statistics (`totalCost`,
 * `totalBilledCost`, `totalTokens`, `contextPercent`, `durationMs`, and
 * `diffStats`) are sparse: when omitted, the client preserves its resident
 * value. All other optional metadata replaces wholesale. A bare removal names
 * a gone session. Other cursors carry their domain payloads. */
export type RuntimeUiPatchPayload =
  | { readonly kind: "runtime.invalidate"; readonly reason: RuntimeInvalidationReason }
  | { readonly kind: "session.added"; readonly row: SessionCatalogRow }
  | { readonly kind: "session.updated"; readonly row: SessionCatalogRow }
  | { readonly kind: "session.removed" }
  | SessionDetailPatchPayload
  | { readonly kind: "chat_default.changed"; readonly chatDefault: RuntimeChatDefault }
  | { readonly kind: "executor.changed"; readonly executor: RuntimeExecutorState }
  | { readonly kind: "service.changed"; readonly service: RuntimeServiceState }
  | OutputPatchPayload
  | StatusPatchPayload
  | BudgetPatchPayload
  | QuestionPatchPayload
  | RolePatchPayload
  | AuthPatchPayload
  | CommandCatalogPatchPayload
  | UpdatePatchPayload
  | ModulePatchPayload
  | RuntimeConfigPatchPayload
  | GitAiAttributionPatchPayload
  | GitPatchPayload
  | CommandUsagePatchPayload
  | ChangesPatchPayload
  | BackgroundPatchPayload
  | ProtocolModulePatchPayload
/** An ordered patch as it leaves the publish path. The sequencer mints `position`;
 * `prevPosition` is this cursor's last published position, or zero for its first
 * patch. A receiver must cover that predecessor, not hold it exactly. */
export interface RuntimeUiPatch {
  readonly cursor: RuntimeCursorIdentity
  readonly position: RuntimePosition
  readonly prevPosition: RuntimePosition
  readonly payload: RuntimeUiPatchPayload
}

/** One read of a session-scoped domain for several sessions at one published
 *  watermark. Every requested id is answered, `null` when the session has no
 *  view. Coverage is the requested ids, never the whole cursor family. */
export interface RuntimeSessionViewEntry<View> {
  readonly sessionId: string
  readonly view: View | null
}
export interface RuntimeSessionViewsResult<View> {
  readonly snapshotPosition: RuntimePosition
  readonly views: readonly RuntimeSessionViewEntry<View>[]
}

/** The session catalog snapshot as it leaves the app-service boundary: the projection's
 *  serializable rows plus the global published `snapshotPosition` watermark.
 *  The rows cover the session family through that position. */
export interface RuntimeUiSnapshot extends SessionCatalogSnapshot {
  readonly snapshotPosition: RuntimePosition
  /** The runtime's own build version, distinct from any client's, so a client
   *  can show which Flywheel it is attached to. */
  readonly runtimeVersion: string
  /** Code identity of the connected runtime process: a build id or source snapshot digest, null when unknown. */
  readonly runtimeBuildId: string | null
  /** The directory that owns this workspace's durable project state, as the
   *  runtime opened it (ARCH-DIRECTORIES-001). Project identity only: it says nothing about
   *  where any session's tools execute. */
  readonly projectRoot: string
  readonly chatDefault: RuntimeChatDefault
  /** What a person should know about the process that runs this project's
   *  sessions; the `executor` workspace domain carries each change. */
  readonly executor: RuntimeExecutorState
  /** What a person should know about the account service that serves this
   *  project; the `service` workspace domain carries each change. */
  readonly service: RuntimeServiceState
}

/** How the receiver must treat an ordered patch.
 *  - `applied`: in order; advance the cursor.
 *  - `stale`: position already passed; idempotent no-op.
 *  - `gap`: prevPosition exceeds the held position, or the cursor
 *    identity does not match this stream; force resnapshot rather than dropping
 *    the live delta. */
export type RuntimePatchClassification = "applied" | "stale" | "gap"

/** A receiver's state for one ordered stream. `heldPosition` is the covered
 * prefix from an authoritative snapshot or applied patches, not necessarily
 * the last publication on this cursor. */
export interface RuntimeCursorState {
  readonly cursor: RuntimeCursorIdentity
  readonly heldPosition: RuntimePosition
}

/** Workspace reads observe the global published watermark; the response's data
 * determines which domain or requested cursors it covers. Cursor reads observe
 * one stream's last publication, or zero. A client keys its reads by this
 * scope; the runtime's read anchor also names every domain the read seeds. */
export type RuntimeSnapshotScope =
  | { readonly kind: "workspace"; readonly domain: RuntimeUiDomain }
  | { readonly kind: "cursor"; readonly cursor: RuntimeCursorIdentity }

export type RuntimeDeliveryPolicy = "durable-resnapshot" | "latest-collapsible" | "query-only"

/** What one patch of a domain states.
 *  - `whole-value`: the cursor's whole value, so applying the payload twice
 *    equals applying it once. A sparse total merge qualifies, because it is
 *    idempotent. The public bus does not publish an equal repeat.
 *  - `change`: an edit, a fold step, or a signal with no value, so every
 *    patch publishes. */
export type RuntimePatchContent = "whole-value" | "change"

/** A domain's delivery policy and patch content. The newest latest-collapsible
 *  patch supersedes any it overtook, which is true only when it states a whole
 *  value, so the type admits no other pairing. */
export type RuntimeDomainDelivery =
  | { readonly delivery: "latest-collapsible"; readonly content: "whole-value" }
  | { readonly delivery: "durable-resnapshot" | "query-only"; readonly content: RuntimePatchContent }

const collapsible = { delivery: "latest-collapsible", content: "whole-value" } as const
const durableWholeValue = { delivery: "durable-resnapshot", content: "whole-value" } as const
const durableChange = { delivery: "durable-resnapshot", content: "change" } as const

/** One delivery row per kernel domain. The `satisfies` clause is the
 *  compile-time gate: a new kernel domain fails this record (and therefore the
 *  build) until it declares how its patches are delivered and what each one
 *  states. A module domain declares both in its protocol home, where the same
 *  completeness rule holds. */
const RUNTIME_DELIVERY_POLICY = {
  // Each row carries its sparse totals, and added and updated differ by kind.
  session: durableWholeValue,
  session_detail: durableWholeValue,
  // A signal with no value: a client reads the summary again on each one.
  changes: durableChange,
  // Each patch states one row of the index or its removal, not the whole
  // index, so a client that missed one reads the index again.
  background: durableChange,
  output: durableChange,
  status: collapsible,
  budget: durableWholeValue,
  question: durableWholeValue,
  // The web client reads a roles patch as a signal that the session's
  // metadata changed and reads its model assignments again, so an equal
  // repeat still carries news.
  roles: durableChange,
  runtime: { delivery: "query-only", content: "change" },
  // One patch carries providers and the complete effective-profile view.
  auth: collapsible,
  // A roster patch carries the whole roster, so the newest supersedes any it
  // overtook and a client that missed one needs no resnapshot.
  commands: collapsible,
  // One patch carries the whole update view (state plus effective policy), so
  // the newest supersedes any it overtook.
  updates: collapsible,
  // One patch carries the complete selection and the derived Workflows mode, so
  // the newest supersedes any it overtook.
  modules: collapsible,
  config: collapsible,
  gitAiAttribution: collapsible,
  // One patch carries the whole repository view.
  git: collapsible,
  // One patch carries every count.
  commandUsage: collapsible,
  chat_default: collapsible,
  // One patch carries the whole executor state.
  executor: collapsible,
  // One patch carries the whole service state.
  service: collapsible,
} as const satisfies { readonly [D in RuntimeKernelDomain]: RuntimeDomainDelivery }

export function runtimeDeliveryPolicy(domain: RuntimeUiDomain): RuntimeDeliveryPolicy {
  return isProtocolModuleDomain(domain) ? protocolDomain(domain).delivery : RUNTIME_DELIVERY_POLICY[domain].delivery
}

export function runtimePatchContent(domain: RuntimeUiDomain): RuntimePatchContent {
  return isProtocolModuleDomain(domain) ? protocolDomain(domain).content : RUNTIME_DELIVERY_POLICY[domain].content
}

type RuntimeQueryOnlyUiDomain = { [D in RuntimeKernelDomain]: (typeof RUNTIME_DELIVERY_POLICY)[D]["delivery"] extends "query-only" ? D : never }[RuntimeKernelDomain]

/** The client-side obligation the delivery policies impose (2026-07-08 audit,
 *  finding M7): every domain that publishes ordered patches must have a live
 *  client intake, so the TUI's construction site declares one binding per
 *  domain and checks the record against this type. A new domain fails
 *  compilation until it is bound to a receiver - or, for `query-only` domains
 *  with no live stream, explicitly opts out. The stale-pane failure mode is a
 *  missing binding; the omission must be a build error, not a runtime gap. */
export type RuntimeDomainIntakeBindings =
  & { readonly [D in Exclude<RuntimeKernelDomain, RuntimeQueryOnlyUiDomain>]: object }
  & { readonly [D in RuntimeQueryOnlyUiDomain]: object | "query-only" }
  & { readonly [D in ProtocolModuleDomainName]: object }

export function isRuntimeInvalidationPayload(payload: RuntimeUiPatchPayload): payload is Extract<RuntimeUiPatchPayload, { readonly kind: "runtime.invalidate" }> {
  return payload.kind === "runtime.invalidate"
}

/** A workspace runtime directive repairs every resident cursor, not only the runtime domain. */
export function isGlobalRuntimeInvalidation(patch: RuntimeUiPatch): boolean {
  return patch.cursor.scope === "workspace" && patch.cursor.domain === "runtime" && isRuntimeInvalidationPayload(patch.payload)
}

/** The string identity of one ordered stream. Both the mint side and every
 * receiver key their held position by this, so workspace-scoped domains never
 * need a fake session id. */
export function cursorKey(cursor: RuntimeCursorIdentity): string {
  return cursor.scope === "session" ? `${cursor.domain}:${cursor.sessionId}` : cursor.scope === "workflow" ? `${cursor.domain}:workflow:${cursor.workflowId}` : `${cursor.domain}:workspace`
}

export function sessionCursor(sessionId: string): RuntimeSessionCursorIdentity {
  return { scope: "session", domain: "session", sessionId }
}

/** The cursor of one session-scoped domain, typed by the domain name so a
 *  receiver built from a registry entry keys its stream exactly. */
export function sessionDomainCursor<D extends RuntimeSessionScopedDomain>(domain: D, sessionId: string): RuntimeSessionCursorIdentity & { readonly domain: D } {
  return { scope: "session", domain, sessionId }
}

export function workspaceDomainCursor<D extends RuntimeWorkspaceScopedDomain>(domain: D): RuntimeWorkspaceCursorIdentity & { readonly domain: D } {
  return { scope: "workspace", domain }
}

/** The pure protocol rule both sides share, stateless over the receiver's held
 *  position so it lives with the protocol types rather than the sequencer's
 *  mint-side state. A receiver (the TUI caches) applies it against the position
 *  it currently holds:
 *  - cursor-identity mismatch -> `gap` (cross-domain/cross-session delivery)
 *  - position already passed   -> `stale` (idempotent no-op)
 *  - prevPosition above held   -> `gap` (an uncovered predecessor)
 *  - otherwise                  -> `applied` */
export function classifyRuntimeUiPatch(patch: RuntimeUiPatch, against: RuntimeCursorState): RuntimePatchClassification {
  if (cursorKey(patch.cursor) !== cursorKey(against.cursor)) return "gap"
  if (patch.position <= against.heldPosition) return "stale"
  if (patch.prevPosition > against.heldPosition) return "gap"
  return "applied"
}

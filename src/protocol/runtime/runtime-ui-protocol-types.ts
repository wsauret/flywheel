import type { RuntimeChatDefault, RuntimeExecutorState, RuntimeServiceState, SessionCatalogRow, SessionCatalogSnapshot } from "./app-service-types.js"
import type { SessionDetailPatchPayload } from "../session/session-detail-protocol-types.js"
import type { CommandCatalogPatchPayload } from "../commands/command-catalog-protocol-types.js"
import type { BudgetPatchPayload } from "../session/budget-protocol-types.js"
import type { OutputPatchPayload } from "../transcript/output-protocol-types.js"
import type { QuestionPatchPayload, WaitingSessionsPatchPayload } from "../session/question-protocol-types.js"
import type { RolePatchPayload } from "../auth/role-protocol-types.js"
import type { StatusPatchPayload } from "../session/status-protocol-types.js"
import type { UpdatePatchPayload } from "./update-protocol-types.js"
import type { ModulePatchPayload } from "./module-protocol-types.js"
import type { AuthPatchPayload } from "../auth/auth-status-protocol-types.js"
import type { RuntimeConfigPatchPayload } from "../settings/runtime-config-protocol-types.js"
import type { GitAiAttributionPatchPayload } from "../git/git-ai-attribution-protocol-types.js"
import type { GitPatchPayload } from "../git/git-protocol-types.js"
import type { CommandUsagePatchPayload } from "../commands/command-usage-protocol-types.js"
import type { ChangesPatchPayload } from "../session/session-changes-protocol-types.js"
import type { BackgroundPatchPayload } from "../session/background-index-protocol-types.js"
import type { SettlementPatchPayload } from "../session/chat-settlement-protocol-types.js"
import type { ProtocolModulePatchPayload, ProtocolModuleSessionDomain, ProtocolModuleWorkspaceDomain, ProtocolModuleWorkflowDomain } from "../modules.js"

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
export const KERNEL_WORKSPACE_DOMAINS = ["runtime", "auth", "commands", "updates", "modules", "config", "gitAiAttribution", "git", "commandUsage", "chat_default", "executor", "service", "settlement", "waitingSessions"] as const
export type RuntimeKernelDomain = (typeof KERNEL_SESSION_DOMAINS)[number] | (typeof KERNEL_WORKSPACE_DOMAINS)[number]
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
 * `reconnect_required` is a workspace transport loss.
 * `rebase` announces a new absolute coordinate baseline for a cursor (a
 * reactivated session's shell rebases block indexes onto the durable fold), so
 * the resident window itself is void, not just its tail. */
export type RuntimeInvalidationReason = "overflow" | "reconnect_required" | "rebase"

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
  | WaitingSessionsPatchPayload
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
  | SettlementPatchPayload
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

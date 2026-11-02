import { createBackgroundIndexIntake, type BackgroundIndexView } from "./create-background-index.js"
import type { Accessor } from "solid-js"
import { batch, createEffect, createMemo, createSignal, untrack } from "solid-js"
import type { BackoffOptions } from "../../infra/backoff.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import type { ToolStreamingText } from "../../infra/output-blocks.js"
import type { OutputView } from "../../protocol/output-protocol-types.js"
import type { OutputTranscriptCache, OutputTranscriptView } from "../transcript-store/output-transcript-cache-types.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { BudgetView } from "../../protocol/budget-protocol-types.js"
import type { PendingQuestionView } from "../../protocol/question-protocol-types.js"
import { noticeText, selectPrimarySessionNotice, sessionNoticeChannel, type SessionNotice } from "../../infra/session-notice.js"
import { createToastPresenter } from "../utils/toast-presenter.js"
import type { RuntimeChatDefault, SessionCatalogError, SessionCatalogRow, SessionInputMode, SessionRow, AttachedRuntimeClient, RuntimeClient, RuntimeHealth, RuntimeStartupStatus, FrontendOutputBlock } from "../../protocol/app-service-types.js"
import type { RoleAssignmentView } from "../../protocol/role-protocol-types.js"
import type { ActiveBackgroundCommandView, StatusView } from "../../protocol/status-protocol-types.js"
import type { UpdateStatusView } from "../../protocol/update-protocol-types.js"
import type { RuntimeModulesView } from "../../protocol/module-protocol-types.js"
import { runtimeConfigCursor, type RuntimeConfigMutation, type RuntimeConfigMutationResult, type RuntimeConfigPatchPayload, type RuntimeConfigSnapshotResult, type RuntimeConfigView } from "../../protocol/runtime-config-protocol-types.js"
import { gitAiAttributionCursor, type GitAiAttributionPatchPayload, type GitAiAttributionStatus, type RuntimeGitAiAttributionSnapshotResult } from "../../protocol/git-ai-attribution-protocol-types.js"
import { gitCursor, type GitPatchPayload, type GitView, type RuntimeGitSnapshotResult } from "../../protocol/git-protocol-types.js"
import type { RuntimeIdentity } from "../../protocol/client/runtime-identity.js"
import type { ChatSubmissionWindow } from "../../protocol/client/chat-submissions.js"
import type { CommandCatalogReadiness } from "../../protocol/client/slash-route.js"
import { commandUsageCursor, type CommandUsagePatchPayload, type CommandUsageView, type RuntimeCommandUsageSnapshotResult } from "../../protocol/command-usage-protocol-types.js"
import type { BuiltInCommandDescriptor, OffCommandDescriptor } from "../../protocol/command-catalog-protocol-types.js"
import type { SessionLifecycleState } from "../../orchestration/session/types.js"
import type { RuntimeDomainIntakeBindings, RuntimeUiPatch } from "../../protocol/runtime-ui-protocol-types.js"
import { runtimeSnapshotScopeKey } from "../../protocol/client/family-intake.js"
import { childCardStatus, type ChildCardStatus } from "../../protocol/client/session-controls.js"
import { runtimeHealth as deriveRuntimeHealth } from "../../protocol/client/runtime-health.js"
import { createOrderedPatchReceiver } from "./create-ordered-patch-receiver.js"
import { createOutputTranscriptCache } from "../transcript-store/create-output-transcript-cache.js"
import { createBudgetCache } from "./create-budget-cache.js"
import { createModuleDomainIntakes, ensureModuleSessionDomains, type ModuleDomainIntakes } from "./create-module-domain-intakes.js"
import { createQuestionCache } from "./create-question-cache.js"
import { useQuestionPages } from "./use-question-pages.js"
import { createUpdateStatusCache } from "./create-update-status-cache.js"
import { createModuleCache } from "./create-module-cache.js"
import { createCommandCatalog } from "./create-command-catalog.js"
import { createSessionCatalog } from "./create-session-catalog.js"
import { createStatusCache } from "./create-status-cache.js"
import { createAuthStatusCache } from "./create-auth-status-cache.js"
import { createRoleCache } from "./create-role-cache.js"
import { createRuntimeHealth } from "./create-runtime-health.js"
import { createRuntimeStartupStatus } from "./create-runtime-startup-status.js"
import { createBackgroundHydration } from "./create-background-hydration.js"
import { RESIDENT_BLOCK_BUDGET } from "../output-window/output-window-scroll.js"
import { sessionLoadFailure } from "./session-load-failure.js"
import { withSnapshotHydrationLimit } from "./snapshot-hydration-limit.js"
import { createTranscriptVisibilityRefresh } from "./create-transcript-visibility-refresh.js"
import { createSessionChangesIntake, type SessionChangesView } from "./create-session-changes.js"
import { createSessionDetailCache, createSessionSurface, type SessionDetailCache, type SessionSurface, type SessionSurfaceOptions } from "./create-session-surface.js"
import { isEmptyNewChat } from "../session-empty-state.js"
import type { SpinnerStatusSource } from "./create-spinner-status.js"

// The terminal-title prefix is a TUI concern with exactly one consumer.
const TERMINAL_TITLE_BASE = "flywheel"

interface StreamingToolTextById {
  [toolUseId: string]: ToolStreamingText
}

export type AgentState = "idle" | "active"

export type ForegroundTarget =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "pending"; readonly key: string }

/** Pure reactive state: signals and derived memos. */
export interface ShellSignals {
  spinnerStatusSource: SpinnerStatusSource
  sessionChanges: Accessor<SessionChangesView | undefined>
  /** The background index of the session the background modal shows. */
  backgroundIndex: BackgroundIndexView
  agentState: Accessor<AgentState>
  /** Whether the foreground session has something an Interrupt cuts now:
   *  a running turn or agent, or a park on background work. Escape, the
   *  prompt hint, and every Interrupt control read this one rule. */
  interruptible: Accessor<boolean>
  activeSubagentCount: Accessor<number>
  /** True while the foreground runner is parked waiting on background work
   *  (an explicit wait on a backgrounded command, or subagents at park time).
   *  Drives the same prompt-bar "Waiting" status as active subagents. */
  waitingOnBackgroundWork: Accessor<boolean>
  /** Active background commands projected for the foreground session. */
  activeBackgroundCommands: Accessor<readonly ActiveBackgroundCommandView[]>
  /** The single foreground transcript read surface OutputWindow renders. Live
   *  deltas and derived-history range reads both write into this one transcript store. */
  outputTranscript: Accessor<OutputTranscriptView>
  /** Per-session output from the transcript store. Undefined until the first
   *  output patch; a session with no output cannot be blocked. */
  outputView: (sessionId: string) => OutputView | undefined
  /** Undefined until the session's first status snapshot or patch. */
  statusView: (sessionId: string) => StatusView | undefined
  /** Undefined until the session's first budget snapshot or patch. */
  budgetView: (sessionId: string) => BudgetView | undefined
  /** Every module domain in the protocol registry, by domain name. A module's
   *  terminal home reads its own through a `DomainReader`; the shell names none. */
  modules: ModuleDomainIntakes
  /** The sole blocked-state authority: a resident question is unanswered by the
   *  server's own filter. This cache never evicts, so background indicators survive
   *  transcript eviction. */
  questionView: (sessionId: string) => PendingQuestionView | undefined
  /** Session role assignments from the ordered roles cache. */
  roleView: (sessionId: string) => RoleAssignmentView | undefined
  /** Starts following ordered role cursors in one batched snapshot. */
  ensureRoleViews: (sessionIds: readonly string[]) => void
  /** Starts following the role and status cursors of the children that
   *  cards show, each in one batched snapshot. */
  ensureChildViews: (sessionIds: readonly string[]) => void
  /** What a child waits on for its card, read from its status, with the
   *  session whose transcript shows the card as its parent. */
  childStatus: (childSessionId: string, parentSessionId: string) => ChildCardStatus
  /** Whether the runtime answers this terminal. Recovery is never a state
   *  here; only a fault, which the shell shows with its remedy. */
  runtimeHealth: Accessor<RuntimeHealth>
  /** Blocking startup work or startup failure, for the pre-ready viewport.
   *  Null once the runtime connects. */
  startupStatus: Accessor<RuntimeStartupStatus | null>
  /** The runtime-owned complete provider and effective-profile view. */
  auth: Accessor<RuntimeAuthView | undefined>
  /** The runtime's update state and effective auto-install policy, from the
   *  one workspace projection. Undefined until its first snapshot; the shell
   *  keeps no copy of the policy. */
  updateStatus: Accessor<UpdateStatusView | undefined>
  /** The runtime's optional-capability selection, the derived Workflows mode,
   *  and any configuration error, from the one workspace projection. Undefined
   *  until its first snapshot; the shell holds no selection of its own. */
  moduleSelection: Accessor<RuntimeModulesView | undefined>
  runtimeConfig: Accessor<RuntimeConfigView | undefined>
  gitAiAttribution: Accessor<GitAiAttributionStatus | undefined>
  /** Reads the branch for a session, or the project directory before its row is known. */
  branch(sessionId?: string): string | undefined
  /** Slash token -> lifetime use count, account-global, as the runtime publishes it. */
  commandUsage: Accessor<ReadonlyMap<string, number>>
  /** Built-in command metadata contributed by enabled capability modules. */
  builtInCommands: Accessor<readonly BuiltInCommandDescriptor[]>
  /** Commands that only a turned-off module provides, for their refusal only. */
  offCommands: Accessor<readonly OffCommandDescriptor[]>
  /** The catalog publication the rendered built-in roster came from. */
  commandCatalogRevision: Accessor<number>
  sessionCatalogRows: Accessor<readonly SessionCatalogRow[]>
  sessionCatalogErrors: Accessor<readonly SessionCatalogError[]>
  /** The rows the Sessions list shows: every catalog row except the
   *  foreground's empty new chat, which its tab already stands for. */
  listedSessions: Accessor<readonly SessionCatalogRow[]>
  /** How many sessions the Sessions list shows. */
  sessionCount: Accessor<number>
  /** The account projection's exact resolved assignment for a new chat. */
  chatDefault: Accessor<RuntimeChatDefault>
  /** The serving backend's identity, from the attach and then each snapshot. */
  runtimeIdentity: Accessor<RuntimeIdentity | undefined>
  /** True after the first complete session catalog snapshot is applied. */
  catalogReady: Accessor<boolean>
  streamingToolText: Accessor<Readonly<StreamingToolTextById>>
  sessionNotices: Accessor<readonly SessionNotice[]>
  /** Progress notices for the spinner status line. */
  statusNotice: Accessor<SessionNotice | null>
  sessionShortTitle: Accessor<string>
  foregroundId: Accessor<string | undefined>
  foregroundTarget: Accessor<ForegroundTarget | undefined>
  setForegroundTarget: (value: ForegroundTarget | undefined) => void
  setForegroundId: (value: string | undefined) => void
  /** Write count of the foreground authority. It advances on every write,
   *  including a same-value one, so an asynchronous caller that captured it at
   *  dispatch can tell "still my selection" from "the user chose again". */
  foregroundRevision: Accessor<number>
  /** The selected session's catalog row. Live rows carry current statistics;
   *  inactive rows retain their final durable statistics. */
  foregroundSummary: Accessor<SessionRow | null>
  /** The selected session's live status: whether a turn runs now. */
  foregroundStatus: Accessor<StatusView | undefined>
  sessionKind: Accessor<"chat" | "subagent" | "workflow-agent" | null>
  /** Canonical prompt-routing contract from the session catalog. It is
   *  available before the asynchronous detailed session view loads. */
  sessionInputMode: Accessor<SessionInputMode | null>
  sessionState: Accessor<SessionLifecycleState | null>
  /** The project directory the runtime opened. Project identity only. */
  projectRoot: Accessor<string>
  /** Execution directory of the selected session, from its own metadata, so an
   *  inactive or historical session reports where it actually ran. Null when no
   *  session is selected: the shell never substitutes its own directory. */
  sessionExecutionCwd: Accessor<string | null>
  pendingQuestion: Accessor<PendingQuestionView | undefined>
  compactionStartedAt: Accessor<number | null>
  /** Wall-clock now, ticked every second. Drives elapsed-time displays. */
  now: Accessor<number>
  /** Cumulative active time of the foreground session. Ticks while the
   *  active-clock anchor (streamingStartedAt) is set — streaming or parked
   *  waiting on subagents — and stays put when it is the user's turn. */
  elapsed: Accessor<number>
}

export interface ShellServices {
  startSessionChanges: () => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => void
  seedSessionCatalogRow: (row: SessionCatalogRow) => void
  startKnownEmptyTranscript: OutputTranscriptCache["startKnownEmpty"]

  /** The command layer's response to OutputWindow's onNearEdge: page the
   *  foreground transcript toward the approached edge. OutputWindow never pages
   *  itself - it is a render boundary that only signals the direction. */
  pageForegroundOutput: (direction: "older" | "newer") => void
  /** Re-reads the command catalog whole, after the runtime refused a stale revision. */
  refreshCommandCatalog: () => Promise<void>
  /** Whether the command catalog has arrived, for routing a slash command typed before it. */
  commandCatalogReadiness: CommandCatalogReadiness
  appService: Pick<RuntimeClient, "query" | "dispatch">
  createSessionSurface: (sessionId: Accessor<string | undefined>, options?: SessionSurfaceOptions) => SessionSurface
  /** Any session's resident transcript and disclosure intent, which a
   *  terminal hands to the build that replaces it. */
  transcripts: Pick<OutputTranscriptCache, "visibleRange" | "disclosures" | "setDisclosure" | "isCurrent">
  /** Any session's held detail row, for a reader that names a session no
   *  surface shows. */
  sessionDetails: Pick<SessionDetailCache, "retain" | "view">
}
export interface ShellState { readonly signals: ShellSignals; readonly services: ShellServices }


export interface RuntimeConfigCache {
  readonly view: Accessor<RuntimeConfigView | undefined>
  settlePublication(command: RuntimeConfigMutation, revision: number): Promise<boolean>
}

function publishedMutation(view: RuntimeConfigView | undefined, command: RuntimeConfigMutation, revision: number): boolean {
  if (view === undefined || view.revision < revision) return false
  // A reset commits several values under one revision; reaching it is the settlement.
  if (command.type === "config.reset") return true
  if (command.setting.id === "gitAiAttribution" || command.setting.id === "allowTrainingRoutes" || command.setting.id === "provider") {
    if (command.target?.kind !== "profile") return false
    const profile = view.values.profiles[command.target.profileId]
    const actual = command.setting.id === "provider"
      ? profile?.providers[command.setting.providerId]?.[command.setting.key]
      : profile?.[command.setting.id]
    return JSON.stringify(actual) === JSON.stringify(command.setting.desired)
  }
  if (command.setting.id === "module") return JSON.stringify(view.values.moduleSections[command.setting.section]?.[command.setting.key]) === JSON.stringify(command.setting.desired)
  return JSON.stringify(view.values[command.setting.id]) === JSON.stringify(command.setting.desired)
}

/** Dispatch one config CAS and settle only after its committed value is present in the shared protocol cache. */
export async function mutateRuntimeConfig(
  config: RuntimeConfigCache,
  appService: Pick<RuntimeClient, "dispatch">,
  command: RuntimeConfigMutation,
): Promise<RuntimeConfigMutationResult> {
  const result = await appService.dispatch(command)
  if (result.kind !== "committed" && result.kind !== "committed-with-durability-warning" && result.kind !== "committed-with-degraded-application") return result
  if (await config.settlePublication(command, result.revision)) return result
  return { kind: "disposed", message: "Configuration updates are unavailable." }
}

/** The one client-side RuntimeConfigView cache. Composition creates it before
 * providers so all settings consumers observe the same snapshot and patches. */
export function createRuntimeConfigCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }): RuntimeConfigCache {
  const [view, setView] = createSignal<RuntimeConfigView | undefined>()
  const cursor = runtimeConfigCursor()
  const scope = { kind: "cursor", cursor } as const
  let closed = false
  const receiver = createOrderedPatchReceiver<typeof scope, RuntimeConfigSnapshotResult, RuntimeUiPatch & { payload: RuntimeConfigPatchPayload }>({
    client: deps.appService,
    connectedScope: () => scope,
    accept(patch) {
      if (patch.cursor.scope !== "workspace" || patch.cursor.domain !== "config") return null
      if (patch.payload.kind === "runtime.invalidate") return { cursor, scope }
      return patch.payload.kind === "config.changed" ? { cursor, scope, patch: { ...patch, payload: patch.payload } } : null
    },
    scopeKey: runtimeSnapshotScopeKey,
    loadSnapshot: () => deps.appService.query({ type: "configSnapshot" }),
    applySnapshot(snapshot) { setView(snapshot.config); return { snapshotPosition: snapshot.snapshotPosition, cursors: [cursor] } },
    applyPayload(patch) { setView(patch.payload.config) },
    onDispose() { closed = true },
  })
  return {
    view,
    async settlePublication(command, revision) {
      if (publishedMutation(view(), command, revision)) return true
      if (closed) return false
      await receiver.resnapshot(scope)
      return !closed && publishedMutation(view(), command, revision)
    },
  }
}

function createGitAiAttributionCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }) {
  const [status, setStatus] = createSignal<GitAiAttributionStatus | undefined>()
  const cursor = gitAiAttributionCursor()
  const scope = { kind: "cursor", cursor } as const
  createOrderedPatchReceiver<typeof scope, RuntimeGitAiAttributionSnapshotResult, RuntimeUiPatch & { payload: GitAiAttributionPatchPayload }>({
    client: deps.appService,
    connectedScope: () => scope,
    accept(patch) {
      if (patch.cursor.scope !== "workspace" || patch.cursor.domain !== "gitAiAttribution") return null
      if (patch.payload.kind === "runtime.invalidate") return { cursor, scope }
      return patch.payload.kind === "gitAiAttribution.changed" ? { cursor, scope, patch: { ...patch, payload: patch.payload } } : null
    },
    scopeKey: runtimeSnapshotScopeKey,
    loadSnapshot: () => deps.appService.query({ type: "gitAiAttributionSnapshot" }),
    applySnapshot(snapshot) { setStatus(snapshot.status); return { snapshotPosition: snapshot.snapshotPosition, cursors: [cursor] } },
    applyPayload(patch) { setStatus(patch.payload.status) },
  })
  return { status }
}

function createGitCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }) {
  const [view, setView] = createSignal<GitView>({ directories: {} })
  const cursor = gitCursor()
  const scope = { kind: "cursor", cursor } as const
  createOrderedPatchReceiver<typeof scope, RuntimeGitSnapshotResult, RuntimeUiPatch & { payload: GitPatchPayload }>({
    client: deps.appService,
    connectedScope: () => scope,
    accept(patch) {
      if (patch.cursor.scope !== "workspace" || patch.cursor.domain !== "git") return null
      if (patch.payload.kind === "runtime.invalidate") return { cursor, scope }
      return patch.payload.kind === "git.changed" ? { cursor, scope, patch: { ...patch, payload: patch.payload } } : null
    },
    scopeKey: runtimeSnapshotScopeKey,
    loadSnapshot: () => deps.appService.query({ type: "gitSnapshot" }),
    applySnapshot(snapshot) { setView(snapshot.git); return { snapshotPosition: snapshot.snapshotPosition, cursors: [cursor] } },
    applyPayload(patch) { setView(patch.payload.git) },
  })
  return { view }
}

function createCommandUsageCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }) {
  const [counts, setCounts] = createSignal<ReadonlyMap<string, number>>(new Map())
  const apply = (usage: CommandUsageView) => setCounts(new Map(usage.uses.map((use) => [use.name, use.count])))
  const cursor = commandUsageCursor()
  const scope = { kind: "cursor", cursor } as const
  createOrderedPatchReceiver<typeof scope, RuntimeCommandUsageSnapshotResult, RuntimeUiPatch & { payload: CommandUsagePatchPayload }>({
    client: deps.appService,
    connectedScope: () => scope,
    accept(patch) {
      if (patch.cursor.scope !== "workspace" || patch.cursor.domain !== "commandUsage") return null
      if (patch.payload.kind === "runtime.invalidate") return { cursor, scope }
      return patch.payload.kind === "commandUsage.changed" ? { cursor, scope, patch: { ...patch, payload: patch.payload } } : null
    },
    scopeKey: runtimeSnapshotScopeKey,
    loadSnapshot: () => deps.appService.query({ type: "commandUsageSnapshot" }),
    applySnapshot(snapshot) { apply(snapshot.usage); return { snapshotPosition: snapshot.snapshotPosition, cursors: [cursor] } },
    applyPayload(patch) { apply(patch.payload.usage) },
  })
  return { counts }
}

export function createShellState(deps: {
  /** The protocol boundary. Migrated session-domain reads (lifecycle, notices,
   *  title, input mode) flow from its snapshot+patch cache; live and historical output
   *  share the one transcript store, and status/budget/workflow-view each use their own cache. */
  appService: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane" | "watchOutput">
  runtimeConfig: RuntimeConfigCache
  /** Wall-clock now, ticked once per second. Owned by the composition root so
   *  test setups can supply a static accessor and skip the tick-pool context. */
  now: Accessor<number>
  /** Project identity from the startup selection, which seeds the display until
   *  the runtime reports the project root it opened (ARCH-DIRECTORIES-009). */
  projectRoot: string
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => void
  /** Override the transcript recovery retry schedule at the composition boundary. */
  transcriptRecoveryBackoff?: BackoffOptions
  /** Receives adopted runtime blocks and their resident window for delivery confirmation. */
  onBlocksAdopted?: (sessionId: string, blocks: readonly FrontendOutputBlock[], window: ChatSubmissionWindow) => void
  onTranscriptChange?: Parameters<typeof createOutputTranscriptCache>[0]["onTranscriptChange"]
  /** The identity of the service the terminal's attach reached, which the
   *  welcome card shows before the first catalog snapshot. Never rejects. */
  attachedIdentity?: Promise<RuntimeIdentity | undefined>
}): ShellState {
  // Bulkhead: cache hydration fans out per session and must not occupy every
  // worker RPC slot; interactive calls stay unqueued (see snapshot-hydration-limit.ts).
  const toasts = createToastPresenter(deps.showToast)
  const hydration = withSnapshotHydrationLimit(deps.appService)
  /** Compile-time intake gate: every protocol cursor domain must bind to a live
   *  receiver or be explicitly query-only. New domains use a per-session cache
   *  or the transcript store rather than a bespoke hook. */
  const [foregroundTarget, writeForegroundTarget] = createSignal<ForegroundTarget | undefined>()
  const foregroundId = createMemo(() => {
    const target = foregroundTarget()
    return target?.kind === "session" ? target.sessionId : undefined
  })
  const [foregroundRevision, bumpForegroundRevision] = createSignal(0)
  // The sole foreground write path, so the revision cannot drift from the value.
  function setForegroundTarget(value: ForegroundTarget | undefined): void {
    batch(() => {
      bumpForegroundRevision((revision) => revision + 1)
      writeForegroundTarget(value)
    })
  }
  function setForegroundId(value: string | undefined): void {
    setForegroundTarget(value === undefined ? undefined : { kind: "session", sessionId: value })
  }

  const moduleIntakes = createModuleDomainIntakes({ appService: deps.appService, hydration })
  const sessionCatalog = createSessionCatalog({ appService: deps.appService, projectRoot: deps.projectRoot, attachedIdentity: deps.attachedIdentity })
  const intake = {
    changes: createSessionChangesIntake({ client: deps.appService, foregroundId }),
    background: createBackgroundIndexIntake({ client: deps.appService }),
    session: sessionCatalog,
    // ONE output store: the same transcript cache owns the live delta intake and the
    // derived-history range reads. There is no separate projector and no cross-store bridge --
    // a live snapshot/delta and a paged range both write the one block list it holds.
    output: createOutputTranscriptCache({
      appService: deps.appService,
      onBlocksAdopted: deps.onBlocksAdopted,
      onTranscriptChange: deps.onTranscriptChange,
      // A real millisecond clock, NOT deps.now (the 1s-ticked display clock):
      // the cache forwards `now` to the live intake's 16ms frame batching, and a
      // second-quantized clock broke its flush-when-idle fast path (and made
      // every cache read that touches `now` a reactive subscriber of the ticker).
      now: () => Date.now(),
      activeSessions: () => new Set(sessionCatalog.rows().filter((row) => row.lifecycleState === "active").map((row) => row.id)),
      includeThinkingContent: () => deps.runtimeConfig.view()?.values.showThinking ?? false,
      ...(deps.transcriptRecoveryBackoff ? { recoveryBackoff: deps.transcriptRecoveryBackoff } : {}),
    }),
    status: createStatusCache({ appService: hydration }),
    session_detail: createSessionDetailCache(hydration, deps.appService),
    budget: createBudgetCache({ appService: hydration }),
    question: createQuestionCache({ appService: hydration }),
    roles: createRoleCache({ appService: hydration }),
    runtime: createRuntimeHealth({ appService: deps.appService }),
    auth: createAuthStatusCache({
      appService: deps.appService,
      foregroundId,
    }),
    updates: createUpdateStatusCache({ appService: deps.appService }),
    modules: createModuleCache({
      appService: deps.appService,
    }),
    config: deps.runtimeConfig,
    commands: createCommandCatalog({ appService: deps.appService }),
    gitAiAttribution: createGitAiAttributionCache({ appService: deps.appService }),
    git: createGitCache({ appService: deps.appService }),
    commandUsage: createCommandUsageCache({ appService: deps.appService }),
    chat_default: sessionCatalog,
    executor: sessionCatalog,
    service: sessionCatalog,
    // Every module domain in the protocol registry, bound generically: a new
    // module domain needs no intake edit here, and a kernel domain still does.
    ...moduleIntakes,
  } satisfies RuntimeDomainIntakeBindings
  const { output: transcriptCache, status: statusCache, budget: budgetCache, question: questionCache, roles: roleCache, runtime: transportHealth, auth: authCache, updates: updateCache, modules: moduleCache, config, commands: commandCatalog, gitAiAttribution, git, commandUsage } = intake
  // The one rule for which sessions the Sessions list shows. The status line
  // counts these rows, so the count never includes a row the list hides.
  const listedSessions = createMemo(() => {
    const foreground = foregroundId()
    return sessionCatalog.rows().filter((row) => row.id !== foreground || !isEmptyNewChat(row, transcriptCache.view(row.id)))
  })
  const runtimeHealth = createMemo(() => deriveRuntimeHealth(transportHealth(), sessionCatalog.service(), sessionCatalog.executor()))

  let transcriptFailureForeground = ""
  createEffect(() => {
    const id = foregroundId() ?? ""
    if (id === transcriptFailureForeground) return
    transcriptFailureForeground = id
    // A new foreground is a new context: its first failure is news even when
    // its message matches the previous session's.
    toasts.reset("transcript.load_failed")
  })

  function showTranscriptFailure(sessionId: string, cause: unknown): void {
    if (sessionId !== untrack(foregroundId)) return
    toasts.present("transcript.load_failed", { message: extractErrorMessage(cause), variant: "error", duration: 7000 })
  }
  function showMountedTranscriptFailure(sessionId: string, cause: unknown): void {
    toasts.present("transcript.load_failed", { message: extractErrorMessage(cause), variant: "error", duration: 7000, dedupeKey: sessionId })
  }

  createTranscriptVisibilityRefresh({
    config: config.view,
    transcriptCache,
    onFailure: showTranscriptFailure,
  })

  const backgroundHydration = createBackgroundHydration({ transcriptCache, residentBlockBudget: RESIDENT_BLOCK_BUDGET })
  const sessionSurfaceDeps = {
    detailCache: intake.session_detail,
    appService: deps.appService,
    transcriptCache,
    statusCache,
    budgetCache,
    questionCache,
    row: sessionCatalog.row,
    catalogReady: sessionCatalog.catalogReady,
    now: deps.now,
    hydrateToHead: backgroundHydration.hydrateToHead,
    onTranscriptFailure: showTranscriptFailure,
  }
  const foregroundSurface = createSessionSurface(sessionSurfaceDeps, () => foregroundId())

  const foregroundSummary = foregroundSurface.summary
  const foregroundStatus = foregroundSurface.status

  createEffect(() => {
    const rows = sessionCatalog.rows()
    const activeIds = rows.filter((summary) => summary.lifecycleState === "active").map((summary) => summary.id)
    for (const cache of [statusCache, budgetCache, questionCache, roleCache]) cache.ensureMany(activeIds)
    const fgId = foregroundId()
    if (fgId) ensureModuleSessionDomains(moduleIntakes, fgId)
    if (fgId) roleCache.ensure(fgId)
  })

  // The desktop switch exists only while the module that claims it is in
  // force, so paging follows the module as well as the setting, as the web
  // client's `desktopNotificationsOn` does.
  const desktopPaging = createMemo(() => (deps.runtimeConfig.view()?.values.notificationsDesktop ?? false)
    && (moduleCache.view()?.modules.some((module) => module.effective && module.configSettings?.some((setting) => setting.control === "config-boolean" && !("section" in setting) && setting.setting === "notificationsDesktop")) ?? false))
  useQuestionPages({ client: deps.appService, row: sessionCatalog.row, enabled: desktopPaging })

  const loadFailure = () => {
    return sessionLoadFailure({
      foregroundId: foregroundId(),
      hasCatalogRow: (id) => sessionCatalog.row(id) !== undefined,
      loaded: foregroundSurface.loadResult(),
    })
  }

  // Unloadable foreground sessions are operational UI failures, not transcript content.
  // Surface each foreground failure once as a transient toast while suppressing repeated refetches.
  createEffect(() => {
    const message = loadFailure()
    if (!message) {
      toasts.reset("session.load_failed")
      return
    }
    toasts.present("session.load_failed", { message, variant: "error", duration: 7000, dedupeKey: `${foregroundId() ?? ""}\0${message}` })
  })

  const now = deps.now
  const elapsed = foregroundSurface.elapsed
  const streamingToolText = foregroundSurface.streamingToolText
  const outputTranscript = () => foregroundSurface.transcript
  const sessionNotices = () => foregroundSummary()?.notices ?? []
  const noticesOn = (channel: ReturnType<typeof sessionNoticeChannel>) =>
    sessionNotices().filter((notice) => sessionNoticeChannel(notice) === channel)
  const statusNotice = () => selectPrimarySessionNotice(noticesOn("status"))
  const toastNotices = () => noticesOn("toast")
  // A toast-channel notice is fire-once: showing it consumes it from the
  // store, so it cannot re-toast, linger, or reach a second surface.
  const toastedNoticeKeys = new Set<string>()
  createEffect(() => {
    const sessionId = foregroundId()
    if (!sessionId) return
    for (const notice of toastNotices()) {
      const key = `${notice.id}:${notice.updatedAt}`
      if (toastedNoticeKeys.has(key)) continue
      toastedNoticeKeys.add(key)
      deps.showToast({ message: noticeText(notice), variant: notice.severity, duration: 7000 })
      void deps.appService.dispatch({ type: "session.dismiss_notice", sessionId, scope: notice.scope })
    }
  })
  const toastedTranscriptFailures = new Set<string>()
  createEffect(() => {
    const sessionId = foregroundId()
    if (!sessionId) return
    const status = transcriptCache.visibleRange(sessionId)?.status
    if (status?.kind !== "unavailable") return
    const key = `${sessionId}:${status.notice.updatedAt}`
    if (toastedTranscriptFailures.has(key)) return
    toastedTranscriptFailures.add(key)
    deps.showToast({ message: noticeText(status.notice), variant: status.notice.severity, duration: 7000 })
  })


  const agentState = foregroundSurface.agentState
  const activeSubagentCount = foregroundSurface.activeSubagentCount
  const waitingOnBackgroundWork = foregroundSurface.waitingOnBackgroundWork
  const activeBackgroundCommands = foregroundSurface.activeBackgroundCommands
  const builtInCommands = commandCatalog.builtInCommands

  // Empty string means absent: the tab consumer falls back through `||`, so it
  // does not distinguish a missing shortTitle from an empty one.
  const sessionShortTitle = () => foregroundSummary()?.shortTitle ?? ""
  // Reactive terminal title: tracks foreground session description.
  // "New Chat" is the placeholder before a real title arrives; show base title instead.
  createEffect(() => {
    const desc = foregroundSummary()?.title ?? ""
    if (desc && desc !== "New Chat") {
      deps.setTerminalTitle(desc)
    } else {
      deps.setTerminalTitle(TERMINAL_TITLE_BASE)
    }
  })

  const pendingQuestion = foregroundSurface.pendingQuestion

  const sessionKind = foregroundSurface.sessionKind
  const sessionInputMode = () => foregroundSummary()?.inputMode ?? null
  const sessionState = foregroundSurface.sessionState
  const sessionExecutionCwd = () => foregroundSummary()?.executionCwd ?? null


  const compactionStartedAt = () => foregroundStatus()?.compactionStartedAt ?? null
  const spinnerStatusSource: SpinnerStatusSource = {
    sessionId: foregroundId,
    status: foregroundStatus,
    streamingOutputChars: foregroundSurface.streamingOutputChars,
    agentState,
    waitingOnBackgroundWork,
    parentSessionId: () => foregroundSummary()?.parentSessionId,
    compactionStartedAt,
    notice: statusNotice,
  }

  const signals = {
    spinnerStatusSource,
    agentState,
    interruptible: foregroundSurface.interruptible,
    activeSubagentCount,
    waitingOnBackgroundWork,
    activeBackgroundCommands,
    outputTranscript,
    outputView: transcriptCache.view,
    statusView: statusCache.view,
    budgetView: budgetCache.view,
    modules: moduleIntakes,
    questionView: questionCache.view,
    roleView: roleCache.view,
    ensureRoleViews: roleCache.ensureMany,
    ensureChildViews: (sessionIds: readonly string[]) => {
      roleCache.ensureMany(sessionIds)
      statusCache.ensureMany(sessionIds)
    },
    childStatus: (childSessionId: string, parentSessionId: string) => childCardStatus(statusCache.view(childSessionId), parentSessionId),
    runtimeHealth,
    startupStatus: createRuntimeStartupStatus({ appService: deps.appService }),
    sessionChanges: intake.changes.view,
    backgroundIndex: intake.background,
    auth: authCache.view,
    updateStatus: updateCache.view,
    moduleSelection: moduleCache.view,
    runtimeConfig: config.view,
    gitAiAttribution: gitAiAttribution.status,
    branch: (sessionId = foregroundId()) => {
      const row = sessionId === undefined ? undefined : sessionCatalog.row(sessionId) ?? intake.session_detail.view(sessionId)?.row
      return git.view().directories[row?.executionCwd ?? sessionCatalog.projectRoot()]?.branch
    },
    commandUsage: commandUsage.counts,
    builtInCommands,
    offCommands: commandCatalog.offCommands,
    commandCatalogRevision: commandCatalog.revision,
    sessionCatalogRows: sessionCatalog.rows,
    sessionCatalogErrors: sessionCatalog.errors,
    listedSessions,
    sessionCount: () => listedSessions().length,
    chatDefault: sessionCatalog.chatDefault,
    runtimeIdentity: sessionCatalog.runtimeIdentity,
    catalogReady: sessionCatalog.catalogReady,
    streamingToolText,
    sessionNotices,
    statusNotice,
    sessionShortTitle,
    foregroundId, setForegroundId, foregroundTarget, setForegroundTarget, foregroundRevision,
    foregroundSummary,
    foregroundStatus,
    sessionKind,
    sessionInputMode,
    sessionState,
    projectRoot: sessionCatalog.projectRoot,
    sessionExecutionCwd,
    pendingQuestion,
    compactionStartedAt,
    now,
    elapsed,
  }

  const services = {
    showToast: deps.showToast,
    seedSessionCatalogRow: sessionCatalog.seed,
    startKnownEmptyTranscript: transcriptCache.startKnownEmpty,
    pageForegroundOutput: foregroundSurface.pageOutput,
    refreshCommandCatalog: commandCatalog.refresh,
    commandCatalogReadiness: commandCatalog,
    startSessionChanges: intake.changes.start,
    appService: deps.appService,
    transcripts: transcriptCache,
    sessionDetails: intake.session_detail,
    createSessionSurface: (id: Accessor<string | undefined>, options?: SessionSurfaceOptions) => createSessionSurface(
      { ...sessionSurfaceDeps, onTranscriptFailure: showMountedTranscriptFailure },
      id,
      options,
    ),
  }

  return { signals, services }
}

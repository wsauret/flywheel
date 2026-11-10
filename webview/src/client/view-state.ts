import type { CommandUse } from "../../../src/protocol/command-usage-protocol-types.js"
import type { PendingQuestionView } from "../../../src/protocol/question-protocol-types.js"
import type { BuiltInCommandDescriptor, OffCommandDescriptor } from "../../../src/protocol/command-catalog-protocol-types.js"
import { effectiveSessionShortTitle, type FrontendActivity, type FrontendOutputBlock, type FrontendToolEntry, type FrontendToolStreamingText, type RuntimeHealth, type SessionCatalogError, type SessionRow } from "../../../src/protocol/app-service-types.js"
import type { TranscriptStatus, TranscriptStore } from "../../../src/protocol/client/transcript-store.js"
import type { ProcessStatus } from "../../../src/protocol/client/transcript-model.js"
import { undeliveredNotice, type LocalChatSubmission } from "../../../src/protocol/client/chat-submissions.js"
import type { HydratedOutputBlockBody } from "../../../src/protocol/transcript-protocol-types.js"
import type { RuntimeAuthStatusSnapshotResult } from "../../../src/protocol/auth-status-protocol-types.js"
import { isInterruptible, offeredSessionControls, replyWaitLabel, type OfferedSessionControls } from "../../../src/protocol/client/session-controls.js"
import type { RoleAssignmentView } from "../../../src/protocol/role-protocol-types.js"
import type { GitAiAttributionStatus } from "../../../src/protocol/git-ai-attribution-protocol-types.js"
import type { GitView } from "../../../src/protocol/git-protocol-types.js"
import type { UpdateStatusView } from "../../../src/protocol/update-protocol-types.js"
import { isWorkingStatus, type StatusView } from "../../../src/protocol/status-protocol-types.js"
import type { SessionChangesSnapshot } from "../../../src/protocol/client/session-changes.js"
import type { PanelSettings } from "./session-settings.js"
import type { DesktopPermission } from "./desktop-notifier.js"
import type { BudgetSummary } from "../../../src/protocol/client/host-contract.js"
import type { ProviderSummary } from "../../../src/protocol/client/provider-summary.js"
import type { ModuleDomainViews } from "./module-domain-views.js"
import type { RuntimeSession, SessionNoticeSummary } from "./session.js"

/** One frame of everything the client renders.
 *
 *  The reconciler (`RuntimeSession`) owns ordering, recovery, and session
 *  state, and publishes a change signal. This is the projection the components
 *  read: built whole on each signal, so the view never holds a second opinion
 *  about what is current, and cheap enough to rebuild per paint because every
 *  field is a reference into state the reconciler already holds. */
export interface ClientViewState {
  /** What the surface should be showing. Decided here, because this is the side
   *  that knows whether a runtime answered and whether a provider works; a view
   *  that inferred it from missing data would guess wrong while a read was
   *  still in flight and flash a setup screen at everyone. */
  readonly stage: "starting" | "needs_provider" | "ready"
  readonly providers: readonly ProviderSummary[]
  /** The auth snapshot behind the providers summary, absent until the first read. */
  readonly authStatus?: RuntimeAuthStatusSnapshotResult
  /** The built-in commands the runtime publishes, in publication order. */
  readonly builtInCommands: readonly BuiltInCommandDescriptor[]
  readonly offCommands: readonly OffCommandDescriptor[]
  readonly budget?: BudgetSummary
  /** The command panel's settings rows, absent until the first read lands. */
  readonly settings?: PanelSettings
  /** Whether this browser lets the page show desktop notifications. */
  readonly desktopPermission: DesktopPermission
  /** The runtime's update view (ARCH-PROTOCOL-043): its status, including a waiting
   *  replacement, and the auto-install policy. Absent until the first read. */
  readonly update?: UpdateStatusView
  /** Whether Git AI attribution can record in this runtime. */
  readonly gitAiAttribution?: GitAiAttributionStatus
  readonly notices: readonly SessionNoticeSummary[]
  readonly groups: { readonly [groupBlockId: string]: { readonly children: readonly FrontendToolEntry[]; readonly total: number } }
  /** Whether the runtime answers this page. A fault is the one thing shown. */
  readonly health: RuntimeHealth
  readonly status: TranscriptStatus
  /** The destination the pane shows a loading screen for, or the failure that
   *  stopped it opening, while it has nothing of the selected session to show:
   *  a new chat the runtime is creating, a session whose detail is still being
   *  read, or a transcript whose first read has not answered or failed. */
  readonly opening?: PaneOpening
  /** The name of the place the pane shows: the selected session's title, else
   *  what the person tapped to get there, such as "New chat". */
  readonly destinationName?: string
  /** The session Back returns to: the selected session's parent, else the
   *  session the person opened it from while its own row is unknown. */
  readonly parentSessionId?: string
  readonly unavailable?: string
  readonly sessionId?: string
  /** The selection's root chat, as `RuntimeSession.rootSessionId` states it. */
  readonly rootSessionId?: string
  readonly executionCwd?: string
  /** The catalog: every session the lists draw. */
  readonly sessions: readonly SessionSummary[]
  /** The newest known open time among waiting questions, absent when none are known. */
  readonly newestQuestionOpenedAt: number | undefined
  /** The question the open session waits on, from the durable question
   *  projection, absent when none waits. The dock shows it. */
  readonly pendingQuestion?: PendingQuestionView
  /** Children this client has opened, never listed; `summaryOf` reads them
   *  after the catalog. */
  readonly children: readonly SessionSummary[]
  roleAssignments(sessionId: string): RoleAssignmentView | undefined
  subscribeRoleAssignments(sessionId: string, listener: (view: RoleAssignmentView | undefined) => void): () => void
  /** Follows one session's status, for a child card that names what its child waits on. */
  subscribeStatus(sessionId: string, listener: (view: StatusView | undefined) => void): () => void
  readonly sessionErrors: readonly SessionCatalogError[]
  /** Every module domain's view: the workspace's, or the open session's for
   *  session scope, null where none has landed. */
  readonly modules: ModuleDomainViews
  readonly blocks: readonly FrontendOutputBlock[]
  /** Messages sent into the open session that the runtime has not shown back
   *  yet. The transcript shows them after `blocks`, as queued. */
  readonly localSubmissions: readonly LocalChatSubmission[]
  /** Absolute index of `blocks[0]`, or null while nothing is resident. */
  readonly startBlockIndex: number | null
  /** Changes when a read replaces the resident window outright. */
  readonly windowGeneration: number
  readonly streamingToolText: { readonly [toolUseId: string]: FrontendToolStreamingText }
  /** Full bodies fetched on demand, keyed by block id. A block whose wire form
   *  was truncated renders its preview plus what was omitted until one of these
   *  arrives. */
  readonly bodies: { readonly [blockId: string]: HydratedOutputBlockBody }
  /** Absolute count of transcript-visible messages in the selected session. */
  readonly visibleMessageCount: number
  readonly hasBefore: boolean
  readonly atTail: boolean
  readonly hasNewer: boolean
  /** Whether the selected transcript owner is present and readable. */
  readonly transcriptAvailable: boolean
  /** The selected status owner's final output cursor for the settled turn. */
  readonly settledOutputPosition: StatusView["settledOutputPosition"]
  /** The selected transcript owner's highest installed output cursor. */
  readonly appliedOutputPosition: number | null
  /** False while the pane shows a window that is not proven current: a
   *  window still on its first read, or a kept tail that has not merged on
   *  the open lane, such as a resident session the person returns to after
   *  the lane broke. Another client may have answered its question or
   *  resumed its run meanwhile, so the controls that rest on it wait. */
  readonly windowCurrent: boolean
  /** True while the agent is working, so the composer can show it and offer to
   *  interrupt rather than leaving the user guessing at a quiet screen. */
  readonly busy: boolean
  /** True while the selected session has something an Interrupt cuts: a
   *  running turn, or a park that waits on background work, which is still
   *  the agent's turn (`isInterruptible`). Escape and every Interrupt
   *  control read this, not `busy`. */
  readonly interruptible: boolean
  /** The runtime's own activity phase, so the live status row can say what the
   *  work is (thinking, generating, executing) instead of a generic "working". */
  readonly activity?: FrontendActivity
  readonly activityStartedAt?: number | null
  /** What the selected session waits on while it is parked on a reply,
   *  such as "Waiting on parent"; the status row shows it. */
  readonly waitingOn?: string
  /** Live process membership for transcript markers and process controls. */
  readonly processStatus?: ProcessStatus
  /** The selected session's active time, which a workflow's card header
   *  reads through `sessionActiveMs`, as the terminal does. */
  readonly activeTime?: Pick<StatusView, "accumulatedActiveMs" | "streamingStartedAt">
  /** The selected session's runtime-backed review, independent of transcript retention. */
  readonly changes: SessionChangesSnapshot | undefined
  readonly projectRoot?: string
  readonly runtimeVersion?: string
  readonly runtimeBuildId?: string | null
  readonly git: GitView
  /** The open session's branch, when its execution directory is on one. */
  readonly branch?: string
  /** Account-global slash-command use counts, ranked by the runtime. */
  readonly commandUsage: readonly CommandUse[]
  /** The model and effort the composer names: the running agent's in a workflow, or
   *  the chat's. Absent until the runtime has resolved a seat. */
  readonly activeModel?: { readonly model: string; readonly effort: string }
}

interface PaneOpening {
  /** Why it could not open. Absent while it is still opening. */
  readonly failure?: string
}

export interface SessionSummary {
  /** True when this chat is blocked on a question. */
  readonly awaitingAnswer?: boolean
  readonly notices?: SessionRow["notices"]
  readonly id: string
  /** The name the row leads with: the short title when the session has one. */
  readonly title: string
  /** The session's longer description, when it differs from the title. */
  readonly subtitle?: string
  /** The actual compact title, absent when the session has none. */
  readonly shortTitle?: string
  readonly kind: SessionRow["kind"]
  readonly lifecycleState: SessionRow["lifecycleState"]
  readonly active: boolean
  /** True while the session's runner is doing work, by the same rule the
   *  terminal's tab spinner uses. */
  readonly working: boolean
  /** ISO timestamp of the last change, for the list's time-ago column. */
  readonly lastUpdated: string
  readonly totalsLoading: boolean
  readonly totalCost?: number
  readonly priceUnavailable?: boolean
  /** The time the session worked, as its row recorded it; a header shows it
   *  once no runner reports active time (`sessionHeaderElapsedMs`). */
  readonly durationMs?: number
  readonly diffStats?: SessionRow["diffStats"]
  readonly parentSessionId?: string
  /** The parent's tool call this session answers; Stop terminates it. */
  readonly parentToolUseId?: string
  /** Who ended this child's run with Stop; a stopped child admits nothing. */
  readonly stoppedBy?: SessionRow["stoppedBy"]
  readonly runOutcome?: Extract<SessionRow, { kind: "subagent" }>["runOutcome"]
  /** The actions the runtime admits: always for a child, and for a listed
   *  session once its detail was read (a listing row admits no Resume). */
  readonly admittedActions?: SessionRow["admittedActions"]
  readonly workflowMembership?: Extract<SessionRow, { kind: "workflow-agent" }>["workflowMembership"]
}

/** The one read for a session by id: a listed session from the catalog, else
 *  a child this client has opened. */
export function summaryOf(state: Pick<ClientViewState, "sessions" | "children">, sessionId: string | undefined): SessionSummary | undefined {
  if (sessionId === undefined) return undefined
  return state.sessions.find((session) => session.id === sessionId) ?? state.children.find((session) => session.id === sessionId)
}

/** The two lists a frame carries: the catalog, and the children this client opened. */
interface SessionSummaryLists {
  readonly sessions: readonly SessionSummary[]
  readonly children: readonly SessionSummary[]
}

/** The readings a session's summary varies with between two catalog reads. */
interface SessionReading {
  readonly awaitingAnswer: boolean
  readonly working: boolean
}

/** One client's frame projection.
 *
 *  A frame is rebuilt on every publish, and a turn publishes many times a
 *  second. The session list keys its rows by identity, so a summary minted
 *  afresh each frame made every session row in every mounted list rebuild per
 *  token. Summaries therefore keep their identity while what they show holds:
 *  a row the catalog replaced for a reading the list does not draw, such as
 *  cost or tokens moving while a turn streams, yields the summary already
 *  held, and the list keeps its identity while every summary does. */
/** Whether `transcript`'s window is proven current (`windowCurrent`). A
 *  transcript that cannot open has no window to distrust. */
export function isWindowCurrent(transcript: Pick<TranscriptStore, "windowCurrent"> | undefined): boolean {
  return transcript === undefined || transcript.windowCurrent
}

/** The run controls the pane offers for `row`: the shared rule, with Resume
 *  held back while the window is not current (`windowCurrent`). */
export function offeredControls(state: Pick<ClientViewState, "interruptible" | "windowCurrent">, row: Parameters<typeof offeredSessionControls>[0]): OfferedSessionControls {
  const offered = offeredSessionControls(row, state.interruptible)
  return offered.primary === "resume" && !state.windowCurrent ? { ...offered, primary: null } : offered
}

export function createViewProjection(): (session: RuntimeSession) => ClientViewState {
  const held = new Map<string, { readonly row: SessionRow; readonly reading: SessionReading; readonly summary: SessionSummary }>()
  let sessions: readonly SessionSummary[] = []
  let children: readonly SessionSummary[] = []

  function summarize(session: RuntimeSession): SessionSummaryLists {
    const seen = new Set<string>()
    const listed = summarizeRows(session, session.sessions, seen)
    const opened = summarizeRows(session, session.children, seen)
    for (const id of held.keys()) if (!seen.has(id)) held.delete(id)
    if (listed !== undefined) sessions = listed
    if (opened !== undefined) children = opened
    return { sessions, children }
  }

  /** Summaries for one list of rows, or undefined when every summary and its
   *  place are what the list already holds. */
  function summarizeRows(session: RuntimeSession, rows: readonly SessionRow[], seen: Set<string>): readonly SessionSummary[] | undefined {
    let changed = false
    const next = rows.map((row) => {
      seen.add(row.id)
      const reading: SessionReading = {
        awaitingAnswer: session.pendingQuestions.has(row.id),
        working: isWorkingStatus(session.statuses.get(row.id)),
      }
      const current = held.get(row.id)
      if (current !== undefined && current.row === row && sameReading(current.reading, reading)) return current.summary
      const summary = toSummary(row, reading)
      if (current !== undefined && sameSummary(current.summary, summary)) {
        held.set(row.id, { row, reading, summary: current.summary })
        return current.summary
      }
      changed = true
      held.set(row.id, { row, reading, summary })
      return summary
    })
    const current = rows === session.sessions ? sessions : children
    if (!changed && next.length === current.length && next.every((summary, index) => summary === current[index])) return undefined
    return next
  }

  return (session) => buildViewState(session, summarize(session))
}

function outputPositionsOf(sessionId: string | undefined, transcript: TranscriptStore | undefined, status: StatusView | undefined): Pick<ClientViewState, "settledOutputPosition" | "appliedOutputPosition"> {
  return {
    settledOutputPosition: typeof status?.settledOutputPosition === "object" && status.settledOutputPosition !== null
      && transcript?.settledOutputRecovery === status.settledOutputPosition.recovery ? null : status?.settledOutputPosition ?? null,
    appliedOutputPosition: sessionId === undefined ? null : transcript?.view.appliedOutputPosition ?? null,
  }
}

function buildViewState(session: RuntimeSession, lists: SessionSummaryLists): ClientViewState {
  const transcript = session.transcript
  const status = session.sessionId === undefined ? undefined : session.statuses.get(session.sessionId)
  // Starting means there is nothing to show yet, not that the socket is down
  // right now. A lost connection after the first snapshot leaves the surface
  // exactly as the reader left it while the client reattaches on its own;
  // replacing the surface would throw away every open row and the scroll
  // position for a reattach that takes a second, and a fault gets one notice.
  const stage = session.projectRoot === undefined
    ? "starting" as const
    : session.providerSetup === "none"
      ? "needs_provider" as const
      : "ready" as const
  const blocks = transcript?.view.blocks ?? []
  const pendingQuestion = session.sessionId === undefined ? undefined : session.pendingQuestions.get(session.sessionId)
  const opening = paneOpening(session)
  const branch = sessionLocationOf(session).branch
  return {
    stage,
    providers: session.providers,
    ...(session.authStatus === undefined ? {} : { authStatus: session.authStatus }),
    builtInCommands: session.commands.builtInCommands,
    offCommands: session.commands.offCommands,
    notices: session.notices,
    groups: transcript?.view.groups ?? {},
    ...(session.budget === undefined ? {} : { budget: session.budget }),
    ...(session.settings === undefined ? {} : { settings: session.settings }),
    desktopPermission: session.desktopNotifier.permission(),
    ...(session.update === undefined ? {} : { update: session.update }),
    ...(session.gitAiAttribution === undefined ? {} : { gitAiAttribution: session.gitAiAttribution }),
    health: session.health,
    status: transcript?.status ?? "idle",
    ...(opening === undefined ? {} : { opening }),
    ...destinationOf(session, lists),
    ...(transcript?.unavailable === undefined ? {} : { unavailable: transcript.unavailable.message }),
    ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
    ...(session.rootSessionId === undefined ? {} : { rootSessionId: session.rootSessionId }),
    ...(session.executionCwd === undefined ? {} : { executionCwd: session.executionCwd }),
    sessions: lists.sessions,
    newestQuestionOpenedAt: session.pendingQuestions.size > 0 ? Math.max(...[...session.pendingQuestions.values()].map((question) => question.timestamp)) : undefined,
    ...(pendingQuestion === undefined ? {} : { pendingQuestion }),
    children: lists.children,
    roleAssignments: session.roleAssignments,
    subscribeRoleAssignments: session.subscribeRoleAssignments,
    subscribeStatus: session.subscribeStatus,
    sessionErrors: session.sessionErrors,
    modules: session.modules,
    blocks,
    localSubmissions: session.localSubmissions,
    startBlockIndex: transcript?.view.startBlockIndex ?? null,
    windowGeneration: transcript?.windowGeneration ?? 0,
    streamingToolText: transcript?.view.streamingToolText ?? {},
    bodies: transcript?.view.bodies ?? {},
    visibleMessageCount: transcript?.view.visibleMessageCount ?? 0,
    hasBefore: transcript?.view.hasBefore ?? false,
    atTail: transcript?.view.atTail ?? true,
    hasNewer: transcript?.view.hasNewer ?? false,
    transcriptAvailable: session.sessionId !== undefined && transcript !== undefined && transcript.status !== "unavailable" && transcript.status !== "recovery-failed",
    ...outputPositionsOf(session.sessionId, transcript, status),
    windowCurrent: isWindowCurrent(transcript),
    busy: session.busy,
    interruptible: isInterruptible(status),
    ...(session.activity === undefined ? {} : { activity: session.activity }),
    ...(status === undefined ? {} : { activityStartedAt: status.activityStartedAt }),
    ...waitingOnOf(status, summaryOf(lists, session.sessionId)?.parentSessionId),
    ...(status === undefined ? {} : { processStatus: status, activeTime: status }),
    changes: session.changes?.snapshot,
    ...(session.projectRoot === undefined ? {} : { projectRoot: session.projectRoot }),
    ...(session.runtimeVersion === undefined ? {} : { runtimeVersion: session.runtimeVersion }),
    ...(session.runtimeBuildId === undefined ? {} : { runtimeBuildId: session.runtimeBuildId }),
    git: session.git,
    ...(branch === undefined ? {} : { branch }),
    commandUsage: session.commandUsage,
    ...(session.activeModel === undefined ? {} : { activeModel: session.activeModel }),
  }
}

/** Names the open session's working location. A host label overrides only the project name. */
export function sessionLocationOf(state: Pick<ClientViewState, "executionCwd" | "projectRoot" | "git">, projectLabel?: string) {
  const directory = state.executionCwd ?? state.projectRoot
  const git = directory === undefined ? undefined : state.git.directories[directory]
  const name = (path: string | undefined) => path?.split(/[\\/]/).filter(Boolean).at(-1)
  return { directory, project: projectLabel ?? name(state.projectRoot), worktree: name(git?.worktreeRoot), branch: git?.branch }
}

function waitingOnOf(status: StatusView | undefined, parentSessionId: string | undefined): Pick<ClientViewState, "waitingOn"> {
  const label = replyWaitLabel(status, parentSessionId) ?? (status?.activity === "idle" && status.waitingOnBackgroundWork ? "Waiting" : undefined)
  return label === undefined ? {} : { waitingOn: label }
}

/** The name and parent of the place the pane shows: the selected session's
 *  own, else what the tap that moved there knew. */
function destinationOf(session: RuntimeSession, lists: SessionSummaryLists): Pick<ClientViewState, "destinationName" | "parentSessionId"> {
  const selected = summaryOf(lists, session.sessionId)
  const name = selected?.title ?? session.destination.label
  const parent = selected?.parentSessionId ?? session.destination.parentSessionId
  return {
    ...(name === undefined ? {} : { destinationName: name }),
    ...(parent === undefined ? {} : { parentSessionId: parent }),
  }
}

function paneOpening(session: RuntimeSession): PaneOpening | undefined {
  // The messages sent to a destination that cannot show yet are what the
  // person waits on there, so they show in place of the loading screen. A
  // destination that failed still says why, unless every message there
  // failed too and says why itself, for the person to edit and send again.
  const pending = session.opening
  const entries = session.localSubmissions
  if (entries.length > 0 && (pending?.failure === undefined || entries.every((entry) => undeliveredNotice(entry.delivery) !== undefined))) return undefined
  if (pending !== undefined) return pending.failure === undefined ? {} : { failure: pending.failure }
  const transcript = session.transcript
  const reading = session.sessionId !== undefined && (transcript === undefined || transcript.status === "idle" || transcript.status === "loading")
  return reading ? {} : undefined
}

function sameReading(left: SessionReading, right: SessionReading): boolean {
  return left.awaitingAnswer === right.awaitingAnswer && left.working === right.working
}

/** Field-equal summaries draw the same row. Every field is a primitive or a
 *  held reference except the line counts, which the catalog rebuilds per fold. */
function sameSummary(left: SessionSummary, right: SessionSummary): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.subtitle === right.subtitle
    && left.shortTitle === right.shortTitle
    && left.kind === right.kind
    && left.lifecycleState === right.lifecycleState
    && left.active === right.active
    && left.working === right.working
    && left.awaitingAnswer === right.awaitingAnswer
    && left.notices === right.notices
    && left.lastUpdated === right.lastUpdated
    && left.totalsLoading === right.totalsLoading
    && left.totalCost === right.totalCost
    && left.priceUnavailable === right.priceUnavailable
    && left.durationMs === right.durationMs
    && left.parentSessionId === right.parentSessionId
    && left.parentToolUseId === right.parentToolUseId
    && left.stoppedBy === right.stoppedBy
    && left.runOutcome === right.runOutcome
    && left.admittedActions === right.admittedActions
    && left.workflowMembership === right.workflowMembership
    && sameDiffStats(left.diffStats, right.diffStats)
}

function sameDiffStats(left: SessionSummary["diffStats"], right: SessionSummary["diffStats"]): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.added === right.added && left.modified === right.modified && left.removed === right.removed
}

function toSummary(row: SessionRow, detail: SessionReading): SessionSummary {
  const title = row.kind === "chat" ? effectiveSessionShortTitle(row.title, row.shortTitle) : row.shortTitle || row.title
  return {
    ...(detail.awaitingAnswer ? { awaitingAnswer: true } : {}),
    ...(row.notices === undefined ? {} : { notices: row.notices }),
    id: row.id,
    title,
    ...(row.shortTitle ? { shortTitle: row.shortTitle } : {}),
    ...(title !== row.title ? { subtitle: row.title } : {}),
    kind: row.kind,
    lifecycleState: row.lifecycleState,
    active: row.lifecycleState === "active",
    working: detail.working,
    lastUpdated: row.lastUpdated,
    totalsLoading: row.totalsLoading,
    ...(row.totalCost === undefined ? {} : { totalCost: row.totalCost }),
    ...(row.priceUnavailable === undefined ? {} : { priceUnavailable: row.priceUnavailable }),
    ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
    ...(row.diffStats === undefined ? {} : { diffStats: row.diffStats }),
    ...(row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId }),
    ...(row.parentToolUseId === undefined ? {} : { parentToolUseId: row.parentToolUseId }),
    ...(row.stoppedBy === undefined ? {} : { stoppedBy: row.stoppedBy }),
    ...(row.kind === "subagent" && row.runOutcome !== undefined ? { runOutcome: row.runOutcome } : {}),
    ...(row.admittedActions === undefined ? {} : { admittedActions: row.admittedActions }),
    ...(row.kind === "workflow-agent" ? { workflowMembership: row.workflowMembership } : {}),
  }
}

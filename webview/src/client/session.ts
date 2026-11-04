import type { ProjectFilesRequest, ProjectFilesResult, TranscriptSearchRequest, TranscriptSearchResult } from "../../../src/protocol/transcript-protocol-types.js"
import type { CommandUse } from "../../../src/protocol/command-usage-protocol-types.js"
import type { CommandOutcome } from "../../../src/protocol/command-catalog-protocol-types.js"
import { isActiveActivity, type ChildSessionRow, type FrontendActivity, type FrontendEvent, type FrontendMutation, type ProtocolChatAttachment, type RuntimeHealth, type RuntimeTransportHealth, type SessionCatalogError, type SessionCatalogRow, type SessionRow, type SessionTitlePatch } from "../../../src/protocol/app-service-types.js"
import type { AgentInputAnswer, PendingQuestionView } from "../../../src/protocol/question-protocol-types.js"
import type { RoleAssignmentView } from "../../../src/protocol/role-protocol-types.js"
import type { RuntimeAuthStatusSnapshotResult } from "../../../src/protocol/auth-status-protocol-types.js"
import type { UpdateStatusView } from "../../../src/protocol/update-protocol-types.js"
import { createWorkspaceStatusViews, WORKSPACE_STATUS_DOMAINS } from "./workspace-status-views.js"
import type { GitAiAttributionStatus } from "../../../src/protocol/git-ai-attribution-protocol-types.js"
import type { GitView } from "../../../src/protocol/git-protocol-types.js"
import type { BudgetSummary } from "../../../src/protocol/client/host-contract.js"
import type { ProviderSummary } from "../../../src/protocol/client/provider-summary.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { isLaneBreak } from "../../../src/protocol/client/cursor-intake.js"
import { runtimeHealth } from "../../../src/protocol/client/runtime-health.js"
import { UNKNOWN_COMMAND_NOTICE } from "../../../src/protocol/client/slash-route.js"
import { isGlobalRuntimeInvalidation } from "../../../src/protocol/runtime-ui-protocol-types.js"
import { createCommandRoster, type CommandRoster } from "./command-choices.js"
import { readWorkspaceSettings, type PanelSettings, type WorkspaceSettings } from "./session-settings.js"
import { browserDesktopNotifier, type DesktopNotifier } from "./desktop-notifier.js"
import type { TranscriptStore } from "../../../src/protocol/client/transcript-store.js"
import { createSessionCatalog } from "./session-catalog.js"
import { createWorkspaceReader } from "./session-workspace.js"
import { createHeldSessionDetails } from "../../../src/protocol/client/held-session-details.js"
import { createHeldRoles } from "./session-roles.js"
import { createSessionReadings } from "./session-readings.js"
import { createAuthMonitor } from "./auth-monitor.js"
import type { ProviderSetup } from "../../../src/protocol/client/provider-setup.js"
import { createModuleDomainMonitors, type ModuleDomainViews } from "./module-domain-views.js"
import { CHAT_SLOT, type ActiveModel } from "./active-model.js"
import type { SessionChangesController } from "../../../src/protocol/client/session-changes.js"
import { createResidentHolds } from "./session-holds.js"
import { isWindowCurrent } from "./view-state.js"
import { createResidency } from "../../../src/protocol/client/residency.js"
import { createResidentSession, trimResidentBodies, WEB_RESIDENT_SESSIONS, type ResidentSession, type SessionMemory } from "./session-residents.js"
import { createSeatReading, type SeatReading } from "./session-seat.js"
import { withDetailEvidence } from "../../../src/protocol/client/session-controls.js"
import { createSessionInput, NEW_CHAT_ENTRIES } from "./session-input.js"
import { openChat } from "../../../src/protocol/client/chat-open.js"
import { adoptedBlocks, type LocalChatSubmission, type LocalRecall, type UnsentChatSubmission } from "../../../src/protocol/client/chat-submissions.js"
import { createSessionNavigation, type SessionDestination, type SessionLink, type SessionMove } from "./session-navigation.js"
import { backgroundReads, createReadRetry } from "../../../src/protocol/client/background-reads.js"

/** What the page is looking at: one selected session, its transcript, and
 *  the catalog it was chosen from.
 *
 *  Session state is read from the protocol's catalog rather than tracked here.
 *  The runtime owns lifecycle, and a client that keeps its own copy of it
 *  eventually disagrees with the runtime about which sessions exist. So this
 *  holds a selection and the views of the sessions it keeps resident, and
 *  reads everything else.
 *
 *  The page keeps its eight most recently shown sessions resident
 *  (`session-residents.ts`), so a return shows what it kept at once and reads
 *  nothing (PI-REMOTE-008). The page's tabs are the root chats of those
 *  sessions: it holds their runners (ARCH-RUNTIME-023) and releases a root only when no
 *  resident session descends from it. */
/** One thing the runtime wants the user to know about the current session. */
export interface SessionNoticeSummary {
  readonly scope: string
  readonly severity: string
  readonly title: string
  readonly message: string
  readonly actionLabel?: string
  readonly actionCommand?: string
}

/** The scope of the pane's own notice, which says why the pane moved. The
 *  runtime raises no notice under the `client.` prefix, so a dismiss of this
 *  scope stays on this page. */
const PANE_NOTICE_SCOPE = "client.pane-move"

export interface RuntimeSession {
  ownsSubmission(id: string): boolean
  settleReturned(submissionIds: readonly string[]): void
  onTranscriptChange?(listener: (sessionId: string, change: import("../../../src/protocol/client/transcript-store.js").TranscriptChange) => void): () => void
  readonly changes: SessionChangesController | undefined
  /** The browser's notification surface, which pages the person when a
   *  session asks a question while the desktop notifications setting is on. */
  readonly desktopNotifier: DesktopNotifier
  readonly sessionId: string | undefined
  /** Counts pane moves, including a return to the same session after navigation. */
  readonly navigationVersion: number
  /** The chat at the top of the selection's parent chain, or undefined while
   *  a link of the chain is unknown. Work started for the selection, such as
   *  a workflow launch, names this chat as its origin, never a child. */
  readonly rootSessionId: string | undefined
  /** The place the last move took the pane: the name and parent the tap
   *  knew, until the session's own row says them. */
  readonly destination: SessionDestination
  /** The destination while the pane cannot show it yet, or undefined when
   *  there is nothing to wait for. */
  readonly opening: SessionDestination | undefined
  /** Model providers and whether any is usable. A panel that lets someone type
   *  a message with nothing connected has only one outcome, and it is a failure
   *  they cannot act on from where they are standing. */
  readonly providers: readonly ProviderSummary[]
  /** The whole auth snapshot the providers summary is cut from: accounts, the
   *  profile, paid-use consent, the settlement of the last login, and the
   *  position a consent write must echo. The sheets that manage providers
   *  read this; the panel reads the summary. */
  readonly authStatus: RuntimeAuthStatusSnapshotResult | undefined
  /** Whether a model provider can serve a send, by the one shared rule. */
  readonly providerSetup: ProviderSetup
  /** The runtime's command catalog as this client reads it. */
  readonly commands: CommandRoster
  /** Runs the built-in command `name` names, by id or alias, in `sessionId`.
   *  It executes in the runtime and answers an outcome for the caller to
   *  present; a session the outcome asks to focus is opened here, and a
   *  refused revision re-reads the roster. A name no published command owns
   *  answers the unknown-command notice and reaches no runtime. */
  invokeCommand(sessionId: string, name: string, args?: string): Promise<CommandOutcome>
  readonly sessions: readonly SessionCatalogRow[]
  /** Children this client has opened. A child is never a catalog row
   *  (ARCH-PROTOCOL-048): its row is read through `sessionDetail` when it is selected,
   *  and then follows its ordered `session_detail` patches. */
  readonly children: readonly ChildSessionRow[]
  /** Holds a visible card's detail without opening its runner. Releases at the last listener. */
  subscribeSessionDetail(sessionId: string, listener: (row: SessionRow | undefined) => void): () => void
  sessionDetail(sessionId: string): SessionRow | undefined
  /** Current role assignments for a child linked from a transcript card. */
  roleAssignments(sessionId: string): RoleAssignmentView | undefined
  /** Follows one child's ordered role reading until the returned release runs. */
  subscribeRoleAssignments(sessionId: string, listener: (view: RoleAssignmentView | undefined) => void): () => void
  /** Sessions whose metadata cannot be read. These remain catalog errors rather
   *  than synthetic rows because no lifecycle or kind is available. */
  readonly sessionErrors: readonly SessionCatalogError[]
  readonly transcript: TranscriptStore | undefined
  /** Whether the runtime answers this page; recovery is never a state here. */
  readonly health: RuntimeHealth
  readonly executionCwd: string | undefined
  /** True while the selected session is doing work. */
  readonly busy: boolean
  /** What the selected session is doing right now, as the runtime's own
   *  activity phase, or undefined before the first status read. */
  readonly activity: FrontendActivity | undefined
  /** The runtime's status view for every live session, by id. Fed by the
   *  status patches on the event stream and seeded whenever the catalog is
   *  read, so a session row can show work in progress without being selected. */
  readonly statuses: ReadonlyMap<string, StatusView>
  /** Follows one session's status, such as a child that a transcript card
   *  shows, until the returned release runs. */
  subscribeStatus(sessionId: string, listener: (view: StatusView | undefined) => void): () => void
  /** Spend and context pressure for the selected session, or undefined before
   *  the first turn has produced any. */
  readonly budget: BudgetSummary | undefined
  /** The command panel's settings snapshot, or undefined before the first read. */
  readonly settings: PanelSettings | undefined
  /** The runtime's update view, live on the workspace `updates` cursor, or
   *  undefined before the first read. */
  readonly update: UpdateStatusView | undefined
  /** Whether Git AI attribution can record in this runtime, live on the
   *  workspace `gitAiAttribution` cursor, or undefined before the first read. */
  readonly gitAiAttribution: GitAiAttributionStatus | undefined
  /** Re-reads the settings snapshot now, for after a mutation. */
  refreshSettings(): Promise<void>
  /** Notices raised against the selected session, and the pane's own notice
   *  when the pane moved without the person, such as off a session that
   *  another client deleted. */
  readonly notices: readonly SessionNoticeSummary[]
  /** The directory that owns this workspace's durable state (ARCH-DIRECTORIES-001). Project
   *  identity only; where a session's tools execute is `executionCwd`. */
  readonly projectRoot: string | undefined
  /** The runtime's own build version, from the session snapshot. */
  readonly runtimeVersion: string | undefined
  /** The runtime's build identifier; null when it names none, undefined before the first snapshot. */
  readonly runtimeBuildId: string | null | undefined
  /** Git metadata for the project and attached sessions' execution directories. */
  readonly git: GitView
  /** The model and effort of the seat in use: the running agent's while an
   *  agent of a workflow runs, otherwise the chat's. Undefined until read. */
  readonly activeModel: ActiveModel | undefined
  /** Account-global slash-command use counts, ranked by the runtime. */
  readonly commandUsage: readonly CommandUse[]
  /** Reports one dispatch of a slash command, so every client ranks by it. */
  recordCommandUse(name: string): Promise<void>
  /** The question each session waits on, by session id, from the durable
   *  question projection: the dock shows it, and a chat blocked on the user
   *  says so from the list rather than only from inside its own transcript. */
  readonly pendingQuestions: ReadonlyMap<string, PendingQuestionView>
  /** The row this page holds for a session: its catalog row, or the detail
   *  of a held child. Undefined for a session the page holds no row for. */
  row(sessionId: string): SessionRow | undefined
  /** What the page's surfaces left in a resident session, or undefined for a
   *  session the page does not keep. */
  memory(sessionId: string): SessionMemory | undefined
  /** Hears each move off a shown session just before the pane changes, while
   *  the pane still shows it, so a surface can leave its state in the
   *  session's memory for the return. */
  onLeave(listener: (sessionId: string, memory: SessionMemory) => void): () => void
  /** The view of every module domain in the protocol registry: a workspace
   *  domain's as the runtime publishes it, a session domain's for the open
   *  session, null where none has landed. Any chat may carry a session view,
   *  so each follows the selection itself rather than a session kind. */
  readonly modules: ModuleDomainViews
  /** Sends text and files. Into an open session the message is a local entry
   *  from this call until the runtime shows it back; a failed send rejects and
   *  leaves its entry in place, marked as not delivered. */
  send(text: string, attachments?: readonly ProtocolChatAttachment[]): Promise<void>
  /** The open session's sent messages the runtime has not shown back yet,
   *  oldest first. The array changes identity only when its entries change. */
  readonly localSubmissions: readonly LocalChatSubmission[]
  /** Up and a message's Edit control, by the rule every client shares
   *  (`ChatSubmissions.recallLocal`): a message that did not go through
   *  comes back for the composer to edit and send again, and a message that
   *  waits for the connection stays and says why. With no chat open, that is
   *  a first message whose new chat failed. Undefined when neither applies. */
  recallLocal(entryId?: string): LocalRecall | undefined
  /** The messages this page sent that the runtime has not answered, for the
   *  next page however this one goes away. A message that itself starts a
   *  new chat stays out: it never goes out again by itself. */
  unsent(): readonly UnsentChatSubmission[]
  /** Interrupts the open session, whatever its kind: a chat turn, a
   *  workflow agent, or a child's run. It keeps everything committed, and
   *  Resume continues it (PI-INTERACTION-043, PI-INTERACTION-044,
   *  PI-AGENT-020). Workflow targets select items or agents; omitted targets act on the whole workflow. */
  interrupt(targets?: readonly string[]): Promise<void>
  /** Continues the open session with no new message, using the same optional workflow targets as Interrupt. */
  resume(targets?: readonly string[]): Promise<void>
  /** Stops a session that answers a parent's tool call: the parent's
   *  `background.terminate` of that call. Stop is terminal and never resumes. */
  stop(sessionId: string): Promise<void>
  /** Moves to a new chat at once and creates it behind the move, or joins
   *  the creation that runs. A failure shows in the pending destination; it
   *  rejects only when the person has already left that destination, so the
   *  failure still reaches them. */
  openNew(): Promise<void>
  /** Moves to the new chat at once like `openNew`, and answers the created
   *  chat's id, or rejects with why the runtime could not create it. */
  newChat(): Promise<string>
  /** Moves the selection to `sessionId` at once. A session that is not listed
   *  shows as opening until its detail arrives, named and parented by `link`,
   *  what the tap knew; a failed open shows its cause, and selecting the same
   *  session again tries again. */
  select(sessionId: string, link?: SessionLink): Promise<void>
  /** Opens a session on the block a chat entry produced, as a search hit
   *  names it, and answers that block's identity for the view to mark. */
  openAround(sessionId: string, entryId: string): Promise<string | undefined>
  /** Ranked hits over the words of one session's transcript or every
   *  session's, from the runtime's index. */
  searchTranscripts(request: TranscriptSearchRequest): Promise<TranscriptSearchResult>
  projectFiles(request: ProjectFilesRequest): Promise<ProjectFilesResult>
  refreshAuth(): Promise<void>
  /** Updates the supplied session titles and preserves omitted fields. */
  rename(sessionId: string, patch: SessionTitlePatch): Promise<void>
  /** Removes a chat permanently. The runtime tombstones it; there is no undo,
   *  which is why every caller confirms first. */
  remove(sessionId: string): Promise<void>
  /** Tears down a chat's live runtime and keeps its record, the way closing a
   *  tab does. Idempotent by design in the runtime, so it never needs a
   *  confirmation. */
  close(sessionId: string): Promise<void>
  /** Clears one notice. A notice the client raised about the pane needs no
   *  session; a notice the runtime raised needs the session it names. */
  dismissNotice(sessionId: string | undefined, scope: string): Promise<void>
  /** Moves a chat in the list. `beforeSessionId` is the chat it should land in
   *  front of, or null to send it to the end. */
  reorder(sessionId: string, beforeSessionId: string | null): Promise<void>
  loadOlder(): Promise<boolean>
  answer(toolUseId: string, answers: { readonly [question: string]: AgentInputAnswer }): Promise<void>
  /** Withdraws a question the agent asked, letting the turn continue without an
   *  answer. */
  cancelQuestion(toolUseId: string): Promise<void>
  /** Summarises the conversation so far so a long one can keep going. */
  compact(): Promise<void>
  /** Stops one background task without interrupting the turn. */
  terminateBackground(toolUseId: string): Promise<void>
  /** Releases a foreground bash hold so the turn continues while the command
   *  keeps running. */
  detachBash(toolUseId: string): Promise<void>
  /** The message the runtime is holding for the next turn, if any. */
  recallQueued(): Promise<string | undefined>
  onChange(listener: () => void): () => void
  dispose(): void
}

export interface RuntimeSessionOptions {
  /** A replacement restores the unsent new-chat surface, not a default session. */
  readonly initialNewChat?: boolean
  readonly connection: RuntimeConnection
  /** The session a reloaded page or a direct address names. The first
   *  catalog opens it instead of the default, listed or not, through the one
   *  open path: a child shows as opening until its detail arrives, and an
   *  open that fails says why in the pane. The reload never shows another
   *  session on its way back. */
  readonly initialSessionId?: string
  readonly onDiagnostic?: (message: string, detail?: unknown) => void
  /** The browser's notification surface. The page's own browser when absent. */
  readonly notifier?: DesktopNotifier
  /** The messages the page this one replaced handed over unanswered. */
  readonly unsent?: readonly UnsentChatSubmission[]
}

export function createRuntimeSession(options: RuntimeSessionOptions): RuntimeSession {
  let restoredNewChat = options.initialNewChat === true
  const { connection } = options
  const listeners = new Set<() => void>()
  const transcriptListeners = new Set<(sessionId: string, change: import("../../../src/protocol/client/transcript-store.js").TranscriptChange) => void>()
  const diagnostic = options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }
  backgroundReads(connection).diagnose(options.onDiagnostic, connection.reportDiagnostic)

  const catalog = createSessionCatalog({
    connection,
  })
  const commands = createCommandRoster()
  let workspaceSettings: WorkspaceSettings | undefined
  let sessionId: string | undefined
  const leaveListeners = new Set<(sessionId: string, memory: SessionMemory) => void>()
  let transportHealth: RuntimeTransportHealth = connection.health
  let initialSessionId = options.initialSessionId
  let git: GitView = { directories: {} }
  let commandUsage: readonly CommandUse[] = []
  let disposed = false

  // Every resident's readers listen through the residency, which makes a
  // hidden one dormant when the lane breaks, so the shown session reads first.
  const residents = createResidency<ResidentSession>({
    capacity: WEB_RESIDENT_SESSIONS,
    lanes: connection,
    dormancy: true,
    onEvict: (resident) => resident.dispose(),
  })
  /** The shown session's resident views and the handle that keeps them. */
  let shown: { readonly id: string; readonly resident: ResidentSession; readonly handle: { release(): void } } | undefined
  const visible = (): ResidentSession | undefined => shown?.resident
  // The seat a new chat takes, which the defaults decide.
  const defaultsSeat = createSeatReading({ connection, sessionId: undefined, slot: () => CHAT_SLOT, changed: () => emit() })
  const currentSeat = (): SeatReading => visible()?.seat ?? defaultsSeat
  function invalidateSeats(): void {
    defaultsSeat.invalidate()
    for (const id of residents.ids()) residents.get(id)?.seat.invalidate()
  }

  const emit = (): void => {
    const transcript = visible()?.transcript
    const barrier = sessionId === undefined ? undefined : readings.statuses.get(sessionId)?.settledOutputPosition
    if (barrier !== undefined && barrier !== null && transcript?.view.atTail) {
      transcript.recoverSettlement(typeof barrier === "object" ? barrier.recovery : barrier)
    }
    for (const listener of listeners) listener()
  }
  const modules = createModuleDomainMonitors({ connection, onChange: emit })
  const readings = createSessionReadings({ connection, changed: emit })
  const roles = createHeldRoles({ connection })
  const { refreshStatus } = readings
  const failedDetails = new Set<string>()
  const detailListeners = new Map<string, Set<(row: SessionRow | undefined) => void>>()
  const detailRetry = createReadRetry(connection, "session detail", () => {
    children.refresh(failedDetails)
  })
  const children = createHeldSessionDetails({
    client: connection,
    onChange: (id) => {
      if (children.state(id)?.error !== undefined) failedDetails.add(id)
      else failedDetails.delete(id)
      if (failedDetails.size === 0) detailRetry.succeeded()
      for (const listener of detailListeners.get(id) ?? []) listener(children.detail(id))
      listedSource = undefined
      readings.reconcile([...catalog.rows, ...children.rows])
      // Before the holds are synced: a deleted child must hand the pane to
      // its parent, not release the root that the parent still needs.
      leaveGone()
      holds.evictGone()
      holds.sync()
      const selected = sessionId
      if (selected && children.detail(selected)) void children.hold(selected).then(() => {
        if (sessionId === selected) holds.sync()
      })
      emit()
    },
    onDiagnostic: (_message, cause) => detailRetry.failed(cause),
  })
  /** The catalog rows, each with its detail's evidence when this client has
   *  read it (`withDetailEvidence`); the catalog row stays the authority for
   *  the rest.
   *  Recomputed only when the catalog or a held detail changes, so the
   *  view's per-paint summaries keep their identity. */
  let listed: readonly SessionCatalogRow[] = []
  let listedSource: readonly SessionCatalogRow[] | undefined
  const listedRows = (): readonly SessionCatalogRow[] => {
    if (listedSource === catalog.rows) return listed
    listedSource = catalog.rows
    listed = catalog.rows.map((row) => withDetailEvidence(row, children.detail(row.id)))
    return listed
  }
  // A held detail counts for any session, a chat the catalog has not listed
  // yet among them.
  const rowOf = (id: string): SessionRow | undefined => listedRows().find((row) => row.id === id) ?? children.detail(id)
  const { submissions, ...input } = createSessionInput({
    connection, selected: () => sessionId, row: rowOf, refreshStatus, hold: children.hold, newChat: () => navigation.newChat(),
    created: (id) => id === sessionId && navigation.destination.created === true,
    position: (id) => { const store = residents.get(id)?.transcript; return store?.status === "ready" ? store.view.totalBlocks : undefined },
    providerSetup: () => auth.providerSetup,
    providerSetupKnown: () => auth.ready,
    ...(options.unsent === undefined ? {} : { unsent: options.unsent }),
  })
  submissions.subscribe(emit)
  const isListed = (id: string): boolean => catalog.rows.some((row) => row.id === id)
  const knows = (id: string): boolean => catalog.records(id) || children.has(id)
  /** The session a page opens with nothing else to open: the first live
   *  chat, else the first chat, never `gone`, a session the pane leaves
   *  before the catalog has dropped it. */
  const defaultSession = (gone?: string): string | undefined =>
    (catalog.rows.find((row) => row.id !== gone && row.lifecycleState === "active") ?? catalog.rows.find((row) => row.id !== gone))?.id
  /** Sessions this page is deleting. Their delete moves the pane itself, so
   *  the runtime's removal reaching this page first is not news to show. */
  const deleting = new Set<string>()
  /** Dispatches a catalog control and reads the catalog again. A refusal
   *  rejects with the runtime's words, so the control says why. */
  const settleCatalog = async (mutation: Extract<FrontendMutation, { readonly type: "session.rename" | "session.close" | "session.dismiss_notice" | "session.reorder" }>): Promise<void> => {
    const result = await connection.dispatch(mutation)
    if (!result.ok) throw new Error(result.error)
    await refreshCatalog()
  }
  /** Leaves the selected session once the runtime says it no longer has it,
   *  as after another client's delete: its held detail turned null, or the
   *  catalog dropped `unlisted`, its last catalog row, which is the only
   *  record of a chat whose detail never read. A row that became a catalog
   *  error is not dropped: the session is still there. A tap on a session
   *  that was already gone is not this move: that pane says it cannot find
   *  it. */
  function leaveGone(unlisted?: SessionRow): void {
    const gone = sessionId
    if (gone === undefined || catalog.records(gone) || deleting.has(gone)) return
    const last = children.lost(gone) ?? unlisted
    if (last === undefined) return
    options.onDiagnostic?.("selected session removed by the runtime", { sessionId: gone, parentSessionId: last.parentSessionId })
    navigation.leave(gone, last.parentSessionId ?? undefined, true)
  }
  const notifier = options.notifier ?? browserDesktopNotifier()
  const holds = createResidentHolds({
    connection, residents, children, rowOf,
    listed: (id) => catalog.records(id),
    known: knows,
    selected: () => sessionId,
    created: (id) => id === sessionId && navigation.destination.created === true,
    focusReady: shownTranscriptReady,
    passiveDetails: () => [...detailListeners.keys()],
    ...diagnostic,
  })
  const selectedRoot = (): string | undefined => (sessionId === undefined ? undefined : holds.rootOf(sessionId))
  /** Answers once the shown transcript is current on the open lane, so the
   *  hidden roots activate behind it rather than beside it. */
  function shownTranscriptReady(): Promise<void> {
    const ready = (): boolean => disposed || isWindowCurrent(visible()?.transcript)
    if (ready()) return Promise.resolve()
    return new Promise((resolve) => {
      const check = (): void => {
        if (!ready()) return
        listeners.delete(check)
        resolve()
      }
      listeners.add(check)
    })
  }

  async function holdSelection(next: string): Promise<void> {
    const requested = navigation.version
    const outcome = await children.hold(next)
    if (sessionId !== next) return
    holds.sync()
    navigation.settle(next, requested, outcome)
  }

  /** Opens `next` in the pane: a resident session shows what it kept, and
   *  any other becomes resident and reads. A session that is neither listed
   *  nor held yet opens as a destination in progress, named by `open.label`,
   *  until its detail arrives or its read fails. */
  function openTranscript(next: string | undefined, open: SessionMove = {}): void {
    restoredNewChat = false
    const left = shown
    if (left !== undefined && left.id !== next) for (const listener of leaveListeners) listener(left.id, left.resident.memory)
    navigation.moved(next, open)
    sessionId = next
    readings.select(next)
    shown = undefined
    if (next !== undefined) {
      const kept = residents.get(next) !== undefined
      const resident = residents.use(next, (lanes) => createResidentSession({
        connection, lanes, sessionId: next, roles,
        // A chat the runtime just created is empty, so its intro shows without a read.
        ...(open.created === true ? { knownEmpty: true } : {}),
        transcriptChanged(change, store) {
          for (const listener of transcriptListeners) listener(next, change)
          submissions.observe(next, adoptedBlocks(change), store.view)
          if (change.kind === "body" && store.view.bodies[change.blockId] !== undefined) trimResidentBodies(residents.ids().flatMap((id) => residents.get(id) ?? []), visible())
        },
        evidenceChanged: () => trimResidentBodies(residents.ids().flatMap((id) => residents.get(id) ?? []), visible()),
        changed: emit,
        ...diagnostic,
      }))
      shown = { id: next, resident, handle: residents.retain(next) }
      // A kept transcript decides whether this open reads it again, once the
      // retain has woken it; a new one reads when its lane opens.
      if (kept) void resident.transcript.open()
    }
    left?.handle.release()
    if (left !== undefined && left.id !== next) left.resident.show(false)
    defaultsSeat.show(next === undefined)
    shown?.resident.show(true)
    holds.evictGone()
    holds.sync()
    emit()
    // Every way a session opens passes here: a person's selection, the row a
    // page opens on load, and the chat a first message creates. Its detail
    // is the reader of admitted actions and their ordered replacements.
    if (next !== undefined) void holdSelection(next)
  }


  /** The catalog's rows before its latest change, so a change can tell
   *  that it dropped the selected session. */
  let catalogBefore: readonly SessionCatalogRow[] = []
  /** What follows the catalog changing, whether a snapshot or a patch moved
   *  it. A selection that no longer names a live session is a selection of
   *  nothing, not a stale pointer to keep rendering; with nothing selected the
   *  address the page opened on, else the first open session, else the first
   *  row, is opened. Per-row readings follow the catalog rather than riding
   *  with it: the list paints from the rows at once, and each row's status,
   *  budget, and question fill in behind it, read once on each lane and kept
   *  current by their own patches. */
  const unsubscribeCatalog = catalog.onChange(() => {
    if (disposed) return
    const unlisted = catalogBefore.find((row) => row.id === sessionId)
    catalogBefore = catalog.rows
    readings.reconcile([...catalog.rows, ...children.rows])
    leaveGone(unlisted)
    if (sessionId !== undefined && !knows(sessionId)) openTranscript(undefined)
    holds.evictGone()
    // A pending destination, a new chat or one that failed, stays until the
    // person leaves it; the catalog moving opens nothing in its place.
    if (sessionId === undefined && navigation.opening === undefined && !restoredNewChat) {
      // The address opens like any tap, even a child that no catalog lists:
      // it shows as opening until its detail answers, and a read that fails
      // says why there rather than opening another session in its place.
      // Only the runtime's answer that the session is gone opens the default
      // session, with a notice that says so.
      const preferred = initialSessionId ?? defaultSession()
      if (preferred) openTranscript(preferred, initialSessionId === undefined ? {} : { address: true })
    }
    initialSessionId = undefined
    emit()
  })

  const refreshCatalog = (): Promise<void> => catalog.resnapshot()

  /** Creates an empty chat, through any number of lost connections. The
   *  messages sent to the new chat while the runtime created it move to it,
   *  so they show there and retire there. */
  async function createChat(): Promise<string> {
    const created = await openChat(connection)
    submissions.move(NEW_CHAT_ENTRIES, created)
    return created
  }

  const navigation = createSessionNavigation({
    show: openTranscript,
    selected: () => sessionId,
    isListed,
    isHeld: (id) => children.detail(id) !== undefined,
    hold: children.hold,
    createChat,
    refreshCatalog,
    transcript: () => visible()?.transcript,
    fallback: defaultSession,
    emit,
    disposed: () => disposed,
  })

  const readWorkspace = createWorkspaceReader({ connection, isDisposed: () => disposed, changed: emit })

  const refreshGit = () => readWorkspace("git", () => connection.query({ type: "gitSnapshot" }), (snapshot) => { git = { directories: snapshot.git.directories } })
  const refreshCommandUsage = () => readWorkspace("command usage", () => connection.query({ type: "commandUsageSnapshot" }), (snapshot) => { commandUsage = snapshot.usage.uses })

  // The seat in use depends on which providers are usable, so a landed auth
  // patch reads it again; a read answers with the seat's own read beside it.
  const auth = createAuthMonitor({
    connection,
    changed: (source) => { if (source === "patch") invalidateSeats(); emit() },
  })
  const statusViews = createWorkspaceStatusViews({ connection, changed: emit })

  /** The workspace's settings rows, refreshed on each lane, on module and
   *  config patches, and after a mutation, never per keystroke or per
   *  switch. The compaction cap the budget gauge divides by rides them. */
  const refreshWorkspaceSettings = () => readWorkspace("settings", () => readWorkspaceSettings(connection), (next) => { workspaceSettings = next })
  /** Re-reads the panel's settings: the workspace's and the shown seat. */
  const refreshSettings = async (): Promise<void> => { await Promise.all([refreshWorkspaceSettings(), currentSeat().refresh()]) }
  /** The panel's settings, which keep their identity while neither half changed. */
  let settings: { readonly workspace: WorkspaceSettings; readonly seat: SeatReading["seat"]; readonly value: PanelSettings } | undefined
  function panelSettings(): PanelSettings | undefined {
    const workspace = workspaceSettings
    if (workspace === undefined) return undefined
    const { seat } = currentSeat()
    const kept = settings?.workspace === workspace && settings.seat === seat ? settings : { workspace, seat, value: { ...workspace, ...seat } }
    settings = kept
    return kept.value
  }

  const refreshCommands = () => readWorkspace("command catalog", () => connection.query({ type: "commandCatalog" }), (published) => commands.accept(published))

  const selectedActivity = (): FrontendActivity | undefined => (sessionId === undefined ? undefined : readings.statuses.get(sessionId)?.activity)

  /** Reads every workspace reading again, because the runtime may have
   *  changed any of them while this page could not hear it. The auth and
   *  update views read themselves. */
  // Each lane seeds the page, and nothing reads before the first lane opens.
  // A cold load opens the session its address names beside the catalog read,
  // not after it: the connection sends the transcript read first, and the
  // open reads the settings and the seat for that session itself.
  function seedWorkspace(): void {
    children.refresh()
    roles.refresh()
    // A seat may have changed while this page could not hear it: the shown
    // one reads now, a hidden one when it is shown.
    invalidateSeats()
    const known = initialSessionId
    if (known !== undefined && sessionId === undefined && navigation.opening === undefined) {
      initialSessionId = undefined
      openTranscript(known, { address: true })
    }
    for (const read of [refreshCatalog, refreshCommands, refreshWorkspaceSettings, refreshGit, refreshCommandUsage]) void read()
  }
  const stopLanes = connection.onLane(() => { if (!disposed) seedWorkspace() })

  const unsubscribe = connection.subscribe((event: FrontendEvent) => {
    if (disposed || event.type !== "patch") return
    if (isGlobalRuntimeInvalidation(event.patch)) {
      // A lane break reads nothing: the next lane reads everything.
      if (isLaneBreak(event.patch)) catalog.accept(event.patch)
      else seedWorkspace()
      return
    }
    if (event.patch.cursor.domain === "modules" || event.patch.cursor.domain === "config") {
      void refreshWorkspaceSettings()
      invalidateSeats()
      if (event.patch.cursor.domain === "modules") void refreshCommands()
      return
    }
    if (event.patch.cursor.domain === "auth" || WORKSPACE_STATUS_DOMAINS.has(event.patch.cursor.domain)) return
    if (event.patch.cursor.scope === "session" && event.patch.cursor.domain === "roles") {
      roles.accept(event.patch)
      return
    }
    if (event.patch.cursor.domain === "git") {
      void refreshGit()
      return
    }
    if (event.patch.cursor.domain === "commandUsage") {
      void refreshCommandUsage()
      return
    }
    if (event.patch.cursor.domain === "commands") {
      void refreshCommands()
      return
    }
    if (event.patch.cursor.domain === "executor" || event.patch.cursor.domain === "service") {
      catalog.accept(event.patch)
      return
    }
    const { patch } = event
    if (patch.cursor.domain === "session") {
      catalog.accept(patch)
      return
    }
    children.accept(patch)
  })

  const unsubscribeState = connection.onHealthChange((next) => {
    transportHealth = next
    emit()
  })

  // A page that took over messages its predecessor had not delivered opens
  // their chat now rather than on the first lane, which a connection that
  // stays down never opens: the messages stay queued in view while the page
  // attaches (PI-INTERACTION-024). The open is the address's open, so a
  // session the runtime no longer has opens the default chat and says so.
  const restored = initialSessionId ?? options.unsent?.[0]?.sessionId
  if (sessionId === undefined && restored !== undefined && options.unsent?.some((entry) => entry.sessionId === restored)) {
    initialSessionId = undefined
    openTranscript(restored, { address: true })
  }

  return {
    get changes() { return visible()?.changes },
    get desktopNotifier() { return notifier },
    get commands() { return commands },
    get projectRoot() { return catalog.projectRoot },
    get runtimeVersion() { return catalog.runtimeVersion },
    get runtimeBuildId() { return catalog.runtimeBuildId },
    get git() { return git },
    get commandUsage() { return commandUsage },
    get activeModel() { return currentSeat().activeModel },
    async recordCommandUse(name) {
      await connection.dispatch({ type: "command_usage.record", name })
    },
    get budget() { return readings.budgetSummary(workspaceSettings?.compactionThreshold ?? 0) },
    get settings() { return panelSettings() },
    get update() { return statusViews.update },
    get gitAiAttribution() { return statusViews.gitAiAttribution },
    refreshSettings,
    get pendingQuestions() { return readings.pendingQuestions },
    row: rowOf,
    get modules() { return modules.views(visible()?.modules) },
    memory: (target) => residents.get(target)?.memory,
    onLeave(listener) {
      leaveListeners.add(listener)
      return () => { leaveListeners.delete(listener) }
    },
    get notices() {
      const row = sessionId === undefined ? undefined : rowOf(sessionId)
      const moved = navigation.destination.notice
      return [...(moved === undefined ? [] : [{ scope: PANE_NOTICE_SCOPE, severity: "info", ...moved }]), ...(row?.notices ?? []).map((notice): SessionNoticeSummary => ({
        scope: notice.scope,
        severity: notice.severity,
        title: notice.title,
        message: notice.message,
        ...(notice.action?.label === undefined ? {} : { actionLabel: notice.action.label }),
        ...(notice.action?.command === undefined ? {} : { actionCommand: notice.action.command }),
      }))]
    },
    get providers() { return auth.providers },
    get authStatus() { return auth.status },
    get providerSetup() { return auth.providerSetup },
    get sessionId() { return sessionId },
    get navigationVersion() { return navigation.version },
    get rootSessionId() { return selectedRoot() },
    get destination() { return navigation.destination },
    get opening() { return navigation.opening },
    get sessions() { return listedRows() },
    get children() { return children.rows },
    sessionDetail: (id) => children.detail(id),
    subscribeSessionDetail(id, listener) {
      let subscribers = detailListeners.get(id)
      if (subscribers === undefined) { subscribers = new Set(); detailListeners.set(id, subscribers) }
      subscribers.add(listener)
      void children.holdSession(id)
      return () => {
        subscribers.delete(listener)
        if (subscribers.size === 0) detailListeners.delete(id)
        holds.sync()
      }
    },
    roleAssignments: (targetSessionId) => roles.get(targetSessionId),
    subscribeRoleAssignments: (targetSessionId, listener) => roles.subscribe(targetSessionId, listener),
    get sessionErrors() { return catalog.errors },
    get transcript() { return visible()?.transcript },
    get health() { return runtimeHealth(transportHealth, catalog.service, catalog.executor) },
    get executionCwd() { return sessionId === undefined ? undefined : rowOf(sessionId)?.executionCwd },
    get busy() { return isActiveActivity(selectedActivity()) },
    get activity() { return selectedActivity() },
    get statuses() { return readings.statuses },
    subscribeStatus: (targetSessionId, listener) => readings.subscribeStatus(targetSessionId, listener),
    ...input,
    get localSubmissions() { return submissions.pending(sessionId ?? NEW_CHAT_ENTRIES) },
    unsent: () => submissions.unsent().filter((entry) => entry.sessionId !== NEW_CHAT_ENTRIES),
    openNew: navigation.openNew,
    newChat: navigation.newChat,
    refreshAuth: auth.refresh,
    async invokeCommand(target, name, args) {
      const argument = args === undefined || args.length === 0 ? undefined : args
      const builtIn = commands.builtIn(name)
      if (!builtIn) return { kind: "unavailable", message: UNKNOWN_COMMAND_NOTICE }
      const outcome = await connection.dispatch({
        type: "command.invoke", id: builtIn.id, revision: builtIn.revision, sessionId: target,
        ...(argument === undefined ? {} : { argument }),
      })
      if (outcome.kind === "focus-session") { openTranscript(outcome.sessionId); await refreshCatalog() }
      else if (outcome.kind === "stale") await refreshCommands()
      return outcome
    },
    rename: (target, patch) => settleCatalog({ type: "session.rename", sessionId: target, ...patch }),
    async remove(target) {
      const parentSessionId = rowOf(target)?.parentSessionId ?? undefined
      deleting.add(target)
      try {
        const result = await connection.dispatch({ type: "session.delete", sessionId: target })
        // A refused delete leaves the session, its detail, and the pane as they were.
        if (!result.ok) throw new Error(result.error)
        children.forget(target)
        // The person may have moved on while the delete ran. Only a pane that
        // still shows the deleted session moves, by the same rule as a delete
        // that another client made, but with no notice: the person did this.
        if (target === sessionId) navigation.leave(target, parentSessionId, false)
      } finally { deleting.delete(target) }
      await refreshCatalog()
    },
    async close(target) {
      // A close removes a chat that holds nothing of the person's
      // (PI-INTERACTION-075). A pane that still shows it then moves as after
      // a delete, with no notice: the person did this.
      deleting.add(target)
      try {
        await settleCatalog({ type: "session.close", sessionId: target })
        if (target === sessionId && !catalog.records(target)) navigation.leave(target, undefined, false)
      } finally { deleting.delete(target) }
    },
    async dismissNotice(target, scope) {
      if (scope === PANE_NOTICE_SCOPE) { navigation.dismissNotice(); return }
      if (target !== undefined) await settleCatalog({ type: "session.dismiss_notice", sessionId: target, scope })
    },
    reorder: (target, beforeSessionId) => settleCatalog({ type: "session.reorder", sessionId: target, beforeSessionId }),
    select: navigation.select,
    async openAround(next, entryId) {
      // A search hit is a tap like any other: the pane moves to its session
      // at once, and the landing reads the new transcript behind the move.
      if (next !== sessionId) void navigation.select(next)
      return await visible()?.transcript.openAround(entryId)
    },
    searchTranscripts: (request) => connection.query({ type: "transcriptSearch", request }),
    projectFiles: (request) => connection.query({ type: "projectFiles", request }),
    async loadOlder() {
      return await visible()?.transcript.loadOlder() ?? false
    },
    ownsSubmission: submissions.ownsSubmission,
    settleReturned: submissions.settleReturned,
    onTranscriptChange(listener) { transcriptListeners.add(listener); return () => { transcriptListeners.delete(listener) } },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      readWorkspace.dispose()
      stopLanes()
      holds.dispose()
      auth.dispose()
      statusViews.dispose()
      unsubscribe()
      unsubscribeState()
      unsubscribeCatalog()
      submissions.dispose()
      catalog.dispose()
      children.dispose()
      detailRetry.dispose()
      roles.dispose()
      readings.dispose()
      residents.dispose()
      defaultsSeat.dispose()
      modules.dispose()
      listeners.clear()
      transcriptListeners.clear()
      leaveListeners.clear()
    },
  }
}


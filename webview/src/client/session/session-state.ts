import type { CommandUse } from "../../../../src/protocol/commands/command-usage-protocol-types.js"
import type { ChildSessionRow, FrontendActivity, RuntimeHealth, SessionCatalogError, SessionCatalogRow } from "../../../../src/protocol/runtime/app-service-types.js"
import type { PendingQuestionView } from "../../../../src/protocol/session/question-protocol-types.js"
import type { RoleAssignmentView } from "../../../../src/protocol/auth/role-protocol-types.js"
import type { RuntimeAuthStatusSnapshotResult } from "../../../../src/protocol/auth/auth-status-protocol-types.js"
import type { UpdateStatusView } from "../../../../src/protocol/runtime/update-protocol-types.js"
import type { GitAiAttributionStatus } from "../../../../src/protocol/git/git-ai-attribution-protocol-types.js"
import type { GitView } from "../../../../src/protocol/git/git-protocol-types.js"
import type { BudgetSummary } from "../../../../src/protocol/client/host/host-contract.js"
import type { ProviderSummary } from "../../../../src/protocol/client/providers/provider-summary.js"
import type { StatusView } from "../../../../src/protocol/session/status-protocol-types.js"
import type { BackgroundIndexState } from "../../../../src/protocol/client/work/background-index.js"
import type { TranscriptStore } from "../../../../src/protocol/client/chat/transcript/transcript-store.js"
import type { ProviderSetup } from "../../../../src/protocol/client/providers/provider-setup.js"
import type { SessionChangesController } from "../../../../src/protocol/client/session/changes/session-changes.js"
import type { LocalChatSubmission } from "../../../../src/protocol/client/chat/chat-submissions.js"
import type { CommandRoster } from "../commands/command-choices.js"
import type { PanelSettings } from "../session-settings.js"
import type { DesktopNotifier } from "../desktop-notifier.js"
import type { ModuleDomainViews } from "../domains/module-domain-views.js"
import type { ActiveModel } from "./residents/active-model.js"
import type { SessionDestination } from "./navigation/session-navigation.js"

/** One thing the runtime wants the user to know about the current session. */
export interface SessionNoticeSummary {
  readonly scope: string
  readonly severity: string
  readonly title: string
  readonly message: string
  readonly actionLabel?: string
  readonly actionCommand?: string
}

/** The state a runtime session publishes for the frame projection
 *  (`view-state.ts`) to read. `RuntimeSession` assembles it with the
 *  session's commands. */
export interface SessionState {
  readonly changes: SessionChangesController | undefined
  /** The browser's notification surface, which pages the person when a
   *  session asks a question while the desktop notifications setting is on. */
  readonly desktopNotifier: DesktopNotifier
  readonly sessionId: string | undefined
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
  readonly sessions: readonly SessionCatalogRow[]
  /** Children this client has opened. A child is never a catalog row
   *  (ARCH-PROTOCOL-048): its row is read through `sessionDetail` when it is selected,
   *  and then follows its ordered `session_detail` patches. */
  readonly children: readonly ChildSessionRow[]
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
  /** The question that the shown session, or a session the page keeps for
   *  a return, waits on, by its id, from the durable question projection,
   *  for the dock. A session that is only listed reads no question. */
  readonly pendingQuestions: ReadonlyMap<string, PendingQuestionView>
  /** Every session of the project that waits on a question, closed ones
   *  included (ARCH-PROTOCOL-068), with the time its docked question opened.
   *  Every waiting mark of a listed row reads this set, never a question read
   *  for the row. */
  readonly waitingSessions: ReadonlyMap<string, number>
  /** The background index of the shown session, which its resident views
   *  follow, or undefined while no session is shown. */
  readonly backgroundIndex: BackgroundIndexState | undefined
  /** The view of every module domain in the protocol registry: a workspace
   *  domain's as the runtime publishes it, a session domain's for the open
   *  session, null where none has landed. Any chat may carry a session view,
   *  so each follows the selection itself rather than a session kind. */
  readonly modules: ModuleDomainViews
  /** The open session's sent messages the runtime has not shown back yet,
   *  oldest first. The array changes identity only when its entries change. */
  readonly localSubmissions: readonly LocalChatSubmission[]
}

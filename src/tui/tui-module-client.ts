import type { Accessor, JSX } from "solid-js"
import type { LaunchModalRoute } from "../infra/launch-state.js"
import type { AgentGroupBlock } from "../infra/output-blocks.js"
import type { RuntimeClient, SessionCatalogRow, SessionRow } from "../protocol/app-service-types.js"
import type { ChildSessionViewerProps } from "./components/child-session-viewer.js"
import type { ModalContext, ViewerContext } from "./components/modal-stack.js"
import type { ModuleDomainIntakes } from "./hooks/create-module-domain-intakes.js"
import type { ShellSignals } from "./hooks/shell-state.js"
import type { AgentGroupBlockProps } from "./output-blocks/agent-group-block.js"
import type { ChildPlaces } from "./hooks/create-child-viewer-opener.js"
import type { BackgroundWorkTarget } from "../protocol/background-index-protocol-types.js"
import type { TurnFoldPresentation } from "../protocol/client/turn-folds.js"
import type { ChatModeHook } from "./hooks/use-chat-mode.js"
import type { QuestionDraftNamespace } from "./hooks/create-draft-cache.js"
import type { SessionShows } from "./hooks/use-open-session-runners.js"
/** The shell lends modules its ordinary child-body and navigation capabilities. */
export interface TuiModuleClientHost {
  readonly domains: ModuleDomainIntakes
  readonly client: Pick<RuntimeClient, "query" | "dispatch">
  readonly roleView: ShellSignals["roleView"]
  readonly ensureRoleViews: ShellSignals["ensureRoleViews"]
  readonly viewerLayer: ViewerContext
  /** The dialog layer, for a dialog over whatever the person has open. */
  readonly dialog: Pick<ModalContext, "push">
  readonly openChild: ChildPlaces["openChild"]
  readonly viewer: (sessionId: string) => Omit<ChildSessionViewerProps, "sessionId" | "input" | "onClose" | "showToast" | "active" | "focused">
  /** A session's titles as its catalog row holds them now, or undefined while no row is known. */
  readonly sessionTitles: (sessionId: string) => Pick<SessionCatalogRow, "id" | "title" | "shortTitle"> | undefined
  readonly navigateUri: (uri: string) => void
  readonly navigateSession: (sessionId: string) => Promise<void>
  readonly showToast: ChildSessionViewerProps["showToast"]
  /** Routes slash text typed in an agent view, as the chat composer does. */
  readonly dispatchCommand: (text: string) => Promise<boolean>
  /** The pending question of any chat, followed from the first read. */
  readonly question: ShellSignals["followQuestion"]
  readonly answerQuestion: ChatModeHook["answerQuestion"]
  readonly cancelQuestion: ChatModeHook["cancelQuestion"]
  /** The shell's question drafts, so a question keeps its input wherever it shows. */
  readonly questionDrafts: QuestionDraftNamespace
  /** Shows a chat outside its tab, as a view over another tab does (`SessionShows`). */
  readonly showSession: SessionShows["show"]
  /** Closes a chat as the Sessions list's close chat does: its work ends now as an interrupt the person can resume,
   *  and a tab that shows it goes. Rejects when the close fails. */
  readonly closeChat: (sessionId: string) => Promise<void>
}
/** The session a module keeps as the first tab (ARCH-PROTOCOL-034). */
export interface TuiFirstTab {
  /** Answers the session that a launch with nothing to restore opens, with
   *  its catalog row and whether this open created it, or undefined when the
   *  module names none. The row lets the launch show the tab without a read
   *  that waits for the executor. */
  open(): Promise<{ readonly sessionId: string; readonly row: SessionCatalogRow; readonly created: boolean } | undefined>
  /** The session whose tab stays first; undefined when there is none. It
   *  notifies only when it names another session. */
  readonly current: Accessor<string | undefined>
  /** The terminal title while this tab is in front, from the project's root directory; the tab's own title when
   *  unset. */
  readonly terminalTitle?: (projectRoot: string) => string
  /** How the tab presents this session's transcript; every other session and every other view of this one keep the
   *  ordinary rows. */
  readonly transcript?: TurnFoldPresentation
  /** True when this tab stands for the whole window, so the window does not teach tabs: while it is the only tab, the
   *  tab bar shows no tab and no new-tab control, only the stats and the divider; while it is in front, the composer
   *  names no new-tab, close-tab, or tab-switch key. Every tab key still works. */
  readonly hidesTabControls?: boolean
}

export interface TuiModuleClient {
  readonly provide: (children: () => JSX.Element) => JSX.Element
  readonly openUri: (uri: string) => Promise<boolean>
  readonly openTarget?: (target: BackgroundWorkTarget) => Promise<boolean>
  readonly openSession: (session: Pick<SessionRow, "id" | "kind">) => boolean | Promise<boolean>
  readonly restore: (route: LaunchModalRoute) => Promise<boolean>
  readonly activity?: { readonly matches: (block: AgentGroupBlock) => boolean; readonly render: (props: AgentGroupBlockProps) => JSX.Element }
  readonly firstTab?: TuiFirstTab
  /** Answers whether a session's tab or chat may close; it may ask the person first. */
  readonly closeGuard?: (sessionId: string) => Promise<boolean>
  readonly sessionNavigation?: TuiSessionNavigation
}

/** A module's part in the Sessions list (PI-LEAD-010). */
interface TuiSessionNavigation {
  /** The sessions that the list does not show, also to a search. */
  readonly hidden: Accessor<readonly string[]>
  /** The tab in front of which a chosen session opens through `open` instead of in its own tab; undefined when there is
   *  none. */
  readonly over: Accessor<string | undefined>
  readonly open: (sessionId: string) => void
}

import type { Accessor, JSX } from "solid-js"
import type { LaunchModalRoute } from "../infra/launch-state.js"
import type { AgentGroupBlock } from "../infra/output-blocks.js"
import type { RuntimeClient, SessionRow } from "../protocol/app-service-types.js"
import type { ChildSessionViewerProps } from "./components/child-session-viewer.js"
import type { ModalContext, ViewerContext } from "./components/modal-stack.js"
import type { ModuleDomainIntakes } from "./hooks/create-module-domain-intakes.js"
import type { ShellSignals } from "./hooks/shell-state.js"
import type { AgentGroupBlockProps } from "./output-blocks/agent-group-block.js"
import type { ChildPlaces } from "./hooks/create-child-viewer-opener.js"
import type { BackgroundWorkTarget } from "../protocol/background-index-protocol-types.js"
import type { ChatModeHook } from "./hooks/use-chat-mode.js"
import type { QuestionDraftNamespace } from "./hooks/create-draft-cache.js"
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
  readonly title: (sessionId: string) => string | undefined
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
}
/** The session a module keeps as the first tab (ARCH-PROTOCOL-034). */
export interface TuiFirstTab {
  /** Answers the session that a launch with nothing to restore opens, or
   *  undefined when the module names none. */
  open(): Promise<string | undefined>
  /** The session whose tab stays first; undefined when there is none. It
   *  notifies only when it names another session. */
  readonly current: Accessor<string | undefined>
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
}

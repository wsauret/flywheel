import type { JSX } from "solid-js"
import type { LaunchModalRoute } from "../infra/launch-state.js"
import type { AgentGroupBlock } from "../infra/output-blocks.js"
import type { RuntimeClient, SessionRow } from "../protocol/app-service-types.js"
import type { ChildSessionViewerProps } from "./components/child-session-viewer.js"
import type { ViewerContext } from "./components/modal-stack.js"
import type { ModuleDomainIntakes } from "./hooks/create-module-domain-intakes.js"
import type { ShellSignals } from "./hooks/shell-state.js"
import type { AgentGroupBlockProps } from "./output-blocks/agent-group-block.js"
import type { ChildPlaces } from "./hooks/create-child-viewer-opener.js"
import type { BackgroundWorkTarget } from "../protocol/background-index-protocol-types.js"
/** The shell lends modules its ordinary child-body and navigation capabilities. */
export interface TuiModuleClientHost {
  readonly domains: ModuleDomainIntakes
  readonly client: Pick<RuntimeClient, "query" | "dispatch">
  readonly roleView: ShellSignals["roleView"]
  readonly ensureRoleViews: ShellSignals["ensureRoleViews"]
  readonly viewerLayer: ViewerContext
  readonly openChild: ChildPlaces["openChild"]
  readonly viewer: (sessionId: string) => Omit<ChildSessionViewerProps, "sessionId" | "input" | "onClose" | "showToast" | "active" | "focused">
  readonly title: (sessionId: string) => string | undefined
  readonly navigateUri: (uri: string) => void
  readonly navigateSession: (sessionId: string) => Promise<void>
  readonly showToast: ChildSessionViewerProps["showToast"]
  /** Routes slash text typed in an agent view, as the chat composer does. */
  readonly dispatchCommand: (text: string) => Promise<boolean>
}
export interface TuiModuleClient {
  readonly provide: (children: () => JSX.Element) => JSX.Element
  readonly openUri: (uri: string) => Promise<boolean>
  readonly openTarget?: (target: BackgroundWorkTarget) => Promise<boolean>
  readonly openSession: (session: Pick<SessionRow, "id" | "kind">) => boolean | Promise<boolean>
  readonly restore: (route: LaunchModalRoute) => Promise<boolean>
  readonly activity?: { readonly matches: (block: AgentGroupBlock) => boolean; readonly render: (props: AgentGroupBlockProps) => JSX.Element }
}

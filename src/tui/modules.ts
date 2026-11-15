import { remoteTui } from "./modules/remote/index.js"
import { subscriptionUsageTui } from "./modules/subscription-usage/index.js"
import { experimentsTui } from "./modules/experiments/index.js"
import { mcpTui } from "./modules/mcp/index.js"
import { sideQuestionTui } from "./modules/side-question/index.js"
import { projectNotificationsTui } from "./modules/project-notifications/index.js"
import type { TuiErrorReportProps, TuiFaultNotice, TuiFaultNoticeHost, TuiModule } from "./tui-module.js"
import { workflowsTui } from "./modules/workflows/index.js"
import type { TuiFirstTab, TuiModuleClient, TuiModuleClientHost } from "./tui-module-client.js"
import { leadTui } from "./modules/lead/index.js"
import { bugReportsTui } from "./modules/bug-reports/index.js"
import type { RuntimeFaultCopy } from "../protocol/client/runtime-fault-copy.js"
import type { RuntimeHealth } from "../protocol/app-service-types.js"
import type { SessionNavigation } from "./hooks/use-session-modal-types.js"

/** The terminal client's module registry. The slot host renders strips,
 *  surfaces, and rows from this list alone, so a module's terminal presence is
 *  its home under `modules/<id>/` plus this one line. */
export const TUI_MODULES = [remoteTui, experimentsTui, mcpTui, sideQuestionTui, projectNotificationsTui, subscriptionUsageTui, workflowsTui, bugReportsTui, leadTui] as const satisfies readonly TuiModule[]

/** Composes the installed client contributions once, independent of admission to new work. */
export function createTuiModuleClients(host: TuiModuleClientHost): readonly TuiModuleClient[] {
  return TUI_MODULES.flatMap((module: TuiModule) => module.createClient ? [module.createClient(host)] : [])
}

const NO_FIRST_TAB: TuiFirstTab = { open: async () => undefined, current: () => undefined }

/** The first tab of the first client that names one. */
export function moduleFirstTab(clients: readonly TuiModuleClient[]): TuiFirstTab {
  return clients.find((client) => client.firstTab)?.firstTab ?? NO_FIRST_TAB
}

/** The terminal title that the first tab's module declares while that tab is in front; undefined for every other tab,
 *  which keeps its own title. */
export function moduleTerminalTitle(clients: readonly TuiModuleClient[], sessionId: string, projectRoot: string): string | undefined {
  const first = moduleFirstTab(clients)
  return sessionId === first.current() ? first.terminalTitle?.(projectRoot) : undefined
}

/** Every client's close guard, in registry order. */
export function moduleCloseGuards(clients: readonly TuiModuleClient[]): readonly ((sessionId: string) => Promise<boolean>)[] {
  return clients.flatMap((client) => client.closeGuard ? [client.closeGuard] : [])
}

/** The Sessions list's part of every client (`TuiSessionNavigation`), combined: the sessions that any of them hides,
 *  and the open of the client whose tab `foregroundId` names, or undefined for every other tab. */
export function moduleSessionNavigation(clients: readonly TuiModuleClient[]): SessionNavigation {
  const parts = clients.flatMap((client) => client.sessionNavigation ? [client.sessionNavigation] : [])
  return {
    hidden: () => new Set(parts.flatMap((part) => part.hidden())),
    openOver: (foregroundId) => foregroundId === undefined ? undefined : parts.find((part) => part.over() === foregroundId)?.open,
  }
}

/** Creates installed crash presenters under the fallback's Solid owner. */
export function createTuiErrorReports(props: TuiErrorReportProps) {
  return TUI_MODULES.flatMap((module: TuiModule) => module.errorReport ? [module.errorReport(props)] : [])
}

/** Composes installed fault presenters over the account-owned health state. */
export function tuiFaultNotice(notice: RuntimeFaultCopy, health: RuntimeHealth, host: TuiFaultNoticeHost): TuiFaultNotice {
  return TUI_MODULES.reduce<TuiFaultNotice>((current, module: TuiModule) => module.faultNotice?.(current, health, host) ?? current, notice)
}

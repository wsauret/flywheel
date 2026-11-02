import { remoteTui } from "./modules/remote/index.js"
import { subscriptionUsageTui } from "./modules/subscription-usage/index.js"
import { experimentsTui } from "./modules/experiments/index.js"
import { mcpTui } from "./modules/mcp/index.js"
import { sideQuestionTui } from "./modules/side-question/index.js"
import { projectNotificationsTui } from "./modules/project-notifications/index.js"
import type { TuiErrorReportProps, TuiFaultNotice, TuiFaultNoticeHost, TuiModule } from "./tui-module.js"
import { workflowsTui } from "./modules/workflows/index.js"
import type { TuiModuleClient, TuiModuleClientHost } from "./tui-module-client.js"
import { bugReportsTui } from "./modules/bug-reports/index.js"
import type { RuntimeFaultCopy } from "../protocol/client/runtime-fault-copy.js"
import type { RuntimeHealth } from "../protocol/app-service-types.js"

/** The terminal client's module registry. The slot host renders strips,
 *  surfaces, and rows from this list alone, so a module's terminal presence is
 *  its home under `modules/<id>/` plus this one line. */
export const TUI_MODULES = [remoteTui, experimentsTui, mcpTui, sideQuestionTui, projectNotificationsTui, subscriptionUsageTui, workflowsTui, bugReportsTui] as const satisfies readonly TuiModule[]

/** Composes the installed client contributions once, independent of admission to new work. */
export function createTuiModuleClients(host: TuiModuleClientHost): readonly TuiModuleClient[] {
  return TUI_MODULES.flatMap((module: TuiModule) => module.createClient ? [module.createClient(host)] : [])
}

/** Creates installed crash presenters under the fallback's Solid owner. */
export function createTuiErrorReports(props: TuiErrorReportProps) {
  return TUI_MODULES.flatMap((module: TuiModule) => module.errorReport ? [module.errorReport(props)] : [])
}

/** Composes installed fault presenters over the account-owned health state. */
export function tuiFaultNotice(notice: RuntimeFaultCopy, health: RuntimeHealth, host: TuiFaultNoticeHost): TuiFaultNotice {
  return TUI_MODULES.reduce<TuiFaultNotice>((current, module: TuiModule) => module.faultNotice?.(current, health, host) ?? current, notice)
}

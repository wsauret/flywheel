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
import { reclaimStorageTui } from "./modules/reclaim-storage/index.js"
import type { RuntimeFaultCopy } from "../protocol/client/runtime-fault-copy.js"
import type { RuntimeHealth, SessionRow } from "../protocol/runtime/app-service-types.js"
import type { BackgroundWorkTarget } from "../protocol/session/background-index-protocol-types.js"
import type { LaunchModalRoute } from "../infra/launch-state.js"
import type { JSX } from "solid-js"

/** The terminal client's module registry. The slot host renders strips,
 *  surfaces, and rows from this list alone, so a module's terminal presence is
 *  its home under `modules/<id>/` plus this one line. */
export const TUI_MODULES = [remoteTui, experimentsTui, mcpTui, sideQuestionTui, projectNotificationsTui, subscriptionUsageTui, workflowsTui, bugReportsTui, reclaimStorageTui] as const satisfies readonly TuiModule[]

/** Composes the installed client contributions once, independent of admission to new work. */
export function createTuiModuleClients(host: TuiModuleClientHost): readonly TuiModuleClient[] {
  return TUI_MODULES.flatMap((module: TuiModule) => module.createClient ? [module.createClient(host)] : [])
}

/** The shell's one way into the module clients: each open goes to the clients
 *  in registry order and settles true at the first client that handles it,
 *  false when none does. `provide` nests every client's context around a
 *  tree, the first client outermost. */
export function moduleNavigation(clients: readonly TuiModuleClient[]) {
  async function first(open: (client: TuiModuleClient) => Promise<boolean> | undefined): Promise<boolean> {
    for (const client of clients) if (await open(client)) return true
    return false
  }
  return {
    openUri: (uri: string) => first((client) => client.openUri(uri)),
    openTarget: (target: BackgroundWorkTarget) => first((client) => client.openTarget?.(target)),
    openSession: (session: Pick<SessionRow, "id" | "kind">) => first((client) => client.openSession(session)),
    restore: (route: LaunchModalRoute) => first((client) => client.restore(route)),
    provide: (children: () => JSX.Element): JSX.Element => clients.reduceRight((inner, client) => () => client.provide(inner), children)(),
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

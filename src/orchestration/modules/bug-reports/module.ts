import { BUG_REPORT_COMMAND, BUG_REPORT_COMMAND_NAME, BUG_REPORT_SURFACE, bugReportsProtocol } from "../../../protocol/modules/bug-reports.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../modules.js"
import { bugReportsService, createBugReportsService } from "./service.js"

export const bugReportsModule = {
  id: "bug-reports", dependencies: [], availability: { kind: "available" }, host: "account",
  service: { handle: bugReportsService, create: (services) => createBugReportsService({ ...services.directories, enabled: services.enabled, ...(services.readFaultReport === undefined ? {} : { readFaultReport: services.readFaultReport }) }) },
  protocol: moduleProtocol({
    contract: bugReportsProtocol,
    create: (services) => ({
      serve: { "bugReport.failed": async ({ source }) => services.modules.get(bugReportsService)?.failedReport(source) ?? null },
      mutate: {
        "bugReport.submit": async (input) => {
          if (!services.enabled()) return { ok: false, kind: "disabled", error: "Bug reports are turned off." }
          const service = services.modules.get(bugReportsService)
          return service ? service.submit({ ...input, sessionId: input.sessionId ?? null }) : { ok: false, kind: "unavailable", error: "Bug reports are unavailable." }
        },
      },
      dispose() {},
    }),
  }),
  contributions: [
    {
      domain: "accountServices", id: "bug-reports",
      value: { configuration: () => null, create: (options) => createBugReportsService({ userDataRoot: options.userDataRoot, enabled: () => true }) },
    },
    { domain: "commands", id: BUG_REPORT_COMMAND, value: { id: BUG_REPORT_COMMAND, title: BUG_REPORT_COMMAND_NAME, description: "Send a bug report with an optional note", aliases: [], opens: BUG_REPORT_SURFACE } },
    { domain: "settings", id: "bug-reports", value: { control: "binary", group: "Interface", label: "Bug reports", description: "Send crash reports to Flywheel automatically and allow /report" } },
  ],
  observers: [], transformers: [], gates: [],
} as const satisfies FirstPartyModule

import { doNotTrack } from "../../../infra/environment/do-not-track.js"
import { processLoginShellPath } from "../../../infra/environment/login-shell-path.js"
import { AUTOMATIC_REPORTS_SETTING, BUG_REPORT_COMMAND, BUG_REPORT_COMMAND_NAME, BUG_REPORT_SURFACE, bugReportsProtocol } from "../../../protocol/modules/bug-reports.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../module-contract/module-catalog.js"
import { automaticReportsAnswer, automaticReportsObserver, bugReportsConfigSection } from "./config.js"
import { bugReportsService, createBugReportsService } from "./service.js"

/** The account service runs in the service manager's environment, which need not hold the person's shell
 *  variables, so a DO_NOT_TRACK that only the login shell exports counts too. */
const doNotTrackSet = async (): Promise<boolean | undefined> => doNotTrack(process.env.DO_NOT_TRACK) || await processLoginShellPath.doNotTrack()

export const bugReportsModule = {
  id: "bug-reports", dependencies: [], host: "account",
  service: {
    handle: bugReportsService,
    create: (services) => createBugReportsService({
      ...services.directories, enabled: services.enabled, doNotTrack: doNotTrackSet, ...automaticReportsAnswer(services.config),
      ...(services.readFaultReport === undefined ? {} : { readFaultReport: services.readFaultReport }),
    }),
  },
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
        "bugReport.consent": async ({ allow }) => {
          if (!services.enabled()) return { ok: false, error: "Bug reports are turned off." }
          return await services.modules.get(bugReportsService)?.answerAutomaticReports(allow) ?? { ok: false, error: "Bug reports are unavailable." }
        },
      },
      dispose() {},
    }),
  }),
  contributions: [
    {
      domain: "accountServices", id: "bug-reports",
      value: {
        // Each fault report reads the answer from the file as it sends, so a changed answer needs no new service.
        configuration: () => null,
        create: (options) => createBugReportsService({
          userDataRoot: options.userDataRoot, enabled: () => true, doNotTrack: doNotTrackSet,
          automaticReports: automaticReportsObserver(options.configOwner),
        }),
      },
    },
    { domain: "config", id: bugReportsConfigSection.key, value: bugReportsConfigSection },
    { domain: "commands", id: BUG_REPORT_COMMAND, value: { id: BUG_REPORT_COMMAND, title: BUG_REPORT_COMMAND_NAME, description: "Send a bug report with an optional note", aliases: [], opens: BUG_REPORT_SURFACE } },
    { domain: "settings", id: "bug-reports", value: { control: "binary", group: "Interface", label: "Bug reports", description: "Allow /report and crash reports to Flywheel" } },
    { domain: "settings", id: "bug-reports-automatic", value: { control: "config-boolean", section: bugReportsConfigSection.key, key: "automatic", defaultValue: false, group: "Interface", label: AUTOMATIC_REPORTS_SETTING, description: "Send crash reports without asking? DO_NOT_TRACK=1 stops them" } },
  ],
} as const satisfies FirstPartyModule

import type { TuiModule } from "../../tui-module.js"
import { createCrashReport, reportFaultNotice } from "./report.js"
import { presentDoNotTrack } from "./do-not-track.js"
import { BUG_REPORT_SURFACE } from "../../../protocol/modules/bug-reports.js"

export const bugReportsTui = {
  id: "bug-reports",
  errorReport: createCrashReport,
  faultNotice: reportFaultNotice,
  present: (props) => presentDoNotTrack(props),
  surfaces: [{ id: BUG_REPORT_SURFACE, loadController: async () => (await import("./send-report.js")).createSendReport }],
} as const satisfies TuiModule

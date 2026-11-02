import { BUG_REPORT_SURFACE } from "../../../../src/protocol/modules/bug-reports.js"
import type { WebModule } from "../../web-module.js"
import { BugReportSheet, RuntimeReportDetail, ViewErrorReport } from "./surfaces.js"

export const bugReportsWeb = {
  id: "bug-reports",
  viewError: { component: ViewErrorReport },
  runtimeFaultDetail: RuntimeReportDetail,
  surfaces: [{ id: BUG_REPORT_SURFACE, sheet: BugReportSheet }],
} as const satisfies WebModule

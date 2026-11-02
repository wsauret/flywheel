import { DurableObject } from "cloudflare:workers"

import type { BugReport } from "./report-schema.js"
import { ReportReceiver } from "./reports.js"

/** @externalHost Cloudflare binds this class as the global bug-report inbox. */
export class ReportInbox extends DurableObject<Env> {
  private readonly receiver = new ReportReceiver(this.ctx.storage, this.env.GITHUB_REPORTS_TOKEN)

  /** Receives the front door's validated report and returns its HTTP result. */
  async submit(report: BugReport): Promise<Response> {
    return this.receiver.submit(report)
  }
}

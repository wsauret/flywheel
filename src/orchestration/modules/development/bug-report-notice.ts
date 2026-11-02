import type { OwnedCommandRunner } from "../../../infra/owned-command.js"
import type { NotificationEpisodeInput } from "../../../infra/notification-episode.js"
import type { ModuleServiceInstance } from "../../app-service/module-service-host.js"
import { Log } from "../../../infra/log.js"

const log = Log.create({ service: "development-bug-reports" })
const sourceId = "development:bug-report-triage"

interface BugReportNoticeDeps {
  readonly runCommand: OwnedCommandRunner
  readonly notify: (episode: NotificationEpisodeInput) => Promise<void>
  readonly enabled: () => boolean
  readonly executionCwd: string
}

/** Checks the exact open issue count outside the two triage labels, raises or resolves its notice, and settles before project shutdown. */
export function createBugReportNotice(deps: BugReportNoticeDeps): ModuleServiceInstance {
  const controller = new AbortController()
  let work: Promise<void> | undefined
  const check = async (): Promise<void> => {
    if (controller.signal.aborted || !deps.enabled()) return
    const started = performance.now()
    let count: number | null = null
    let kind = "launch"
    try {
      const result = await deps.runCommand(
        ["gh", "api", "-X", "GET", "search/issues", "-f", "q=repo:wsauret/flywheel-reports is:issue is:open -label:triage:needs-evidence -label:triage:confirmed", "--jq", ".total_count"],
        { cwd: deps.executionCwd, timeoutMs: 10_000, signal: controller.signal },
      )
      if (result.timedOut || result.exitCode !== 0) {
        log.debug("bug report triage check failed", { kind: result.timedOut ? "timeout" : "exit" })
        return
      }
      kind = "response"
      const stdout = result.stdout.trim()
      const parsed = Number(stdout)
      if (!/^\d+$/.test(stdout) || !Number.isSafeInteger(parsed)) throw new Error("Invalid bug report count")
      count = parsed
      kind = "notify"
      if (!deps.enabled() || controller.signal.aborted) return
      if (count === 0) await deps.notify({ type: "resolve", sourceId })
      else await deps.notify({
        type: "raise",
        occurrence: {
          sourceId,
          title: "Bug reports need triage",
          message: `${count} ${count === 1 ? "bug report waits" : "bug reports wait"} for triage. Run /bug-report-triage.`,
          severity: "warning",
        },
      })
    } catch {
      log.debug("bug report triage check failed", { kind })
    } finally {
      log.info("bug report triage check finished", { count: count ?? "unknown", durationMs: performance.now() - started })
    }
  }
  return {
    start() {
      // Yield out of composition before launching optional network work.
      work ??= new Promise<void>((resolve) => { setImmediate(resolve) }).then(check)
    },
    closeAdmission() { controller.abort() },
    async dispose() { controller.abort(); await work },
  }
}

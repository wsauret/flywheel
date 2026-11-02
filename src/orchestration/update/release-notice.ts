import { Log } from "../../infra/log.js"
import { parseRepositoryIdentity } from "../../infra/update/release-manifest.js"
import { compareReleaseVersions, parseReleaseVersion } from "../../infra/update/version-order.js"
import type { ReleaseNotice } from "../../protocol/update-protocol-types.js"
import { CONFIG_VALUE_ABSENT, type RuntimeConfigOwner } from "../config/runtime-config-owner.js"
import { readReleaseSummary, releaseNoticeMessage, type ReleaseNotesFetch } from "./release-notes-summary.js"
import type { UpdateScheduler } from "./update-check.js"

const log = Log.create({ service: "release-notice" })
const FIRST_NOTICE_DELAY_MS = 10_000
const RELEASE_NOTES_TIMEOUT_MS = 5_000

interface ReleaseNoticeOptions {
  readonly owner: RuntimeConfigOwner
  /** Absent in a source run, as for the account updater. */
  readonly currentVersion: string | undefined
  readonly repository: string
  readonly fetch: ReleaseNotesFetch
  readonly scheduler: UpdateScheduler
  readonly publish: (notice: ReleaseNotice | undefined) => void
}

interface ReleaseNoticeLifecycle {
  dispose(): Promise<void>
}

/** Start optional account-wide release-notice work after startup. The config owner remains
 * the dismissal authority. Disposal cancels a pending start or request and joins its work. */
export function startReleaseNotice(options: ReleaseNoticeOptions): ReleaseNoticeLifecycle {
  const running = options.currentVersion === undefined ? undefined : parseReleaseVersion(options.currentVersion)
  if (running?.precedence === undefined) return { dispose: async () => {} }
  const controller = new AbortController()
  let closed = false
  let work: Promise<void> | undefined
  let computed: ReleaseNotice | undefined
  const pending = (): boolean => {
    const value = options.owner.snapshot().config.acknowledged_release_version
    const acknowledged = value === undefined ? undefined : parseReleaseVersion(value)
    return acknowledged !== undefined && (compareReleaseVersions(running, acknowledged) ?? 0) > 0
  }
  const publish = (): void => { options.publish(pending() ? computed : undefined) }
  const unsubscribe = options.owner.subscribe("acknowledgedReleaseVersion", publish)
  const compute = async (): Promise<void> => {
    const value = options.owner.snapshot().config.acknowledged_release_version
    if (value === undefined) {
      const result = await options.owner.mutate("acknowledgedReleaseVersion", CONFIG_VALUE_ABSENT, running.canonical)
      log.info("post-update release baseline recorded", { runningVersion: running.canonical, outcome: result.ok ? "committed" : result.kind })
      return
    }
    const acknowledged = parseReleaseVersion(value)
    if (acknowledged === undefined || (compareReleaseVersions(running, acknowledged) ?? 0) <= 0) return
    const { owner, repo } = parseRepositoryIdentity(options.repository)
    const baseUrl = `https://github.com/${owner}/${repo}/releases`
    let outcome: "counted" | "unavailable" = "unavailable"
    let counts: Awaited<ReturnType<typeof readReleaseSummary>>["counts"] | undefined
    try {
      const summary = await readReleaseSummary({
        repository: options.repository,
        acknowledged,
        running,
        fetch: options.fetch,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(RELEASE_NOTES_TIMEOUT_MS)]),
      })
      counts = summary.counts
      outcome = "counted"
      computed = {
        version: running.canonical,
        message: releaseNoticeMessage(running.canonical, counts),
        url: summary.releases === 1 ? `${baseUrl}/tag/v${running.canonical}` : baseUrl,
      }
    } catch {
      // Release notes are optional. The named release and link remain useful offline.
      computed = { version: running.canonical, message: releaseNoticeMessage(running.canonical), url: baseUrl }
    }
    if (closed) return
    log.info("post-update release notice computed", { acknowledgedVersion: value, runningVersion: running.canonical, outcome, ...(counts === undefined ? { failureKind: "release-notes-unavailable" } : counts) })
    publish()
  }
  const cancelStart = options.scheduler.setTimer(() => {
    work = compute().catch(() => {
      log.warn("post-update release notice could not be computed", { runningVersion: running.canonical, failureKind: "config-unavailable" })
    })
  }, FIRST_NOTICE_DELAY_MS)
  return {
    async dispose() {
      closed = true
      cancelStart()
      controller.abort()
      await unsubscribe()
      await work
    },
  }
}

import { Schema } from "effect"
import { parseRepositoryIdentity } from "../../infra/update/release-manifest.js"
import { compareReleaseVersions, parseReleaseVersion, type ReleaseVersion } from "../../infra/update/version-order.js"

export interface ReleaseChangeCounts {
  readonly features: number
  readonly fixes: number
  readonly other: number
}

/** The single fetch operation the release-notes reader needs. */
export type ReleaseNotesFetch = (url: string, init: RequestInit) => Promise<Response>

const ReleasePageSchema = Schema.Array(Schema.Struct({
  tag_name: Schema.String,
  body: Schema.NullOr(Schema.String),
}))
const decodePage = Schema.decodeUnknownSync(ReleasePageSchema)

/** Count top-level release-note bullets by section. A body with no section is unreadable. */
function countReleaseChanges(body: string): ReleaseChangeCounts {
  const counts = { features: 0, fixes: 0, other: 0 }
  let section: keyof ReleaseChangeCounts | undefined
  let hasSection = false
  for (const line of body.split(/\r?\n/)) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      hasSection = true
      section = heading[1] === "Added" ? "features" : heading[1] === "Fixed" ? "fixes" : "other"
    } else if (section !== undefined && /^- \S/.test(line)) {
      counts[section] += 1
    }
  }
  if (!hasSection) throw new Error("release-body-unreadable")
  return counts
}

/** The welcome sentence. Empty and unavailable counts leave only the running release. */
export function releaseNoticeMessage(version: string, counts?: ReleaseChangeCounts): string {
  const base = `Updated to v${version}.`
  if (counts === undefined) return base
  const categories = [
    [counts.features, "feature"],
    [counts.fixes, "fix"],
    [counts.other, "other change"],
  ] as const
  const parts = categories.filter(([count]) => count > 0).map(([count, noun]) => `${count} ${noun}${count === 1 ? "" : noun === "fix" ? "es" : "s"}`)
  if (parts.length === 0) return base
  const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(parts)
  return `${base} Got ${list}.`
}

interface ReleaseSummaryRequest {
  readonly repository: string
  readonly acknowledged: ReleaseVersion
  readonly running: ReleaseVersion
  readonly fetch: ReleaseNotesFetch
  readonly signal: AbortSignal
}

/** Read published releases in (acknowledged, running], paging until the acknowledged release.
 * Reject network, shape, or missing-running-release failures so the owner can omit counts. */
export async function readReleaseSummary(request: ReleaseSummaryRequest): Promise<{ readonly counts: ReleaseChangeCounts; readonly releases: number }> {
  const { owner, repo } = parseRepositoryIdentity(request.repository)
  const counts = { features: 0, fixes: 0, other: 0 }
  let releases = 0
  let foundRunning = false
  for (let page = 1; ; page += 1) {
    const response = await request.fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`, {
      signal: request.signal,
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!response.ok) throw new Error(`http-${response.status}`)
    const entries = decodePage(await response.json())
    let reachedAcknowledged = false
    for (const entry of entries) {
      const version = parseReleaseVersion(entry.tag_name)
      if (version?.precedence === undefined) continue
      const afterAcknowledged = compareReleaseVersions(version, request.acknowledged)
      const afterRunning = compareReleaseVersions(version, request.running)
      if (afterAcknowledged !== undefined && afterAcknowledged <= 0) reachedAcknowledged = true
      if (afterAcknowledged === undefined || afterAcknowledged <= 0 || afterRunning === undefined || afterRunning > 0) continue
      if (entry.body === null) throw new Error("release-body-missing")
      const changes = countReleaseChanges(entry.body)
      counts.features += changes.features
      counts.fixes += changes.fixes
      counts.other += changes.other
      releases += 1
      if (afterRunning === 0) foundRunning = true
    }
    if (entries.length < 100 || reachedAcknowledged) break
  }
  if (!foundRunning) throw new Error("running-release-missing")
  return { counts, releases }
}

import { Redacted, Schema } from "effect"
import { decodeBugReport, type BugReport } from "./report-schema.js"

/** The rows the inbox keeps, each for one UTC day. */
interface DailyCount {
  readonly day: string
  readonly count: number
}
/** The crash signatures posted today: how many times each, and the report id
 *  of its latest post, which a repeat past the cap answers with. */
interface SignatureDay {
  readonly day: string
  readonly posts: { readonly [label: string]: { readonly count: number; readonly reportId: string } }
}

/** Each row is this inbox's own writing, and each read still checks its day
 *  and shape (`dailyCount`, `signatureDay`). */
interface ReportStorage {
  get(key: string): Promise<DailyCount | SignatureDay | undefined>
  put(entries: { readonly [key: string]: DailyCount | SignatureDay }): Promise<void>
}

const MAX_REPORT_BYTES = 48 * 1024
const MAX_ISSUE_CHARACTERS = 60_000
/** Reports each kind may send to GitHub in one UTC day, including attempts
 *  GitHub fails. Each kind has its own budget, so a flood of anonymous
 *  manual reports cannot starve the crash reports that the product sends by
 *  itself. Rows `daily:crash` and `daily:manual` replace the one `daily` row
 *  an earlier relay kept, which nothing reads. */
const DAILY_LIMITS = { crash: 400, manual: 100 } as const
/** Posts one crash signature may make in one UTC day. The tenth says that
 *  later repeats that day are not posted; a repeat past it answers with the
 *  report id of the signature's latest post, costs no GitHub call, and counts
 *  against no budget. */
const SIGNATURE_DAILY_POSTS = 10
const GITHUB_REPOSITORY = "https://api.github.com/repos/wsauret/flywheel-reports"
const decodeIssues = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ number: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)) })))

/** POST /reports accepts BugReport JSON up to 48 KiB and returns {reportId}.
 * Refusals return {error} with 400, 405, 413, 429, 502, or 503. The caller
 * supplies the edge IP limiter and the one global inbox. No payload is logged. */
export async function receiveReport(request: Request, dependencies: { limiter: RateLimit; submit: (report: BugReport) => Promise<Response> }): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } })
  const { success } = await dependencies.limiter.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })
  if (!success) return Response.json({ error: "rate_limited" }, { status: 429 })
  if (!request.body) return Response.json({ error: "invalid_report" }, { status: 400 })
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_REPORT_BYTES) {
      await reader.cancel()
      return Response.json({ error: "report_too_large" }, { status: 413 })
    }
    chunks.push(value)
  }
  let report: BugReport
  try {
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    report = decodeBugReport(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)))
  } catch {
    return Response.json({ error: "invalid_report" }, { status: 400 })
  }
  try {
    return await dependencies.submit(report)
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 })
  }
}

/** One global inbox, backed by Durable Object storage and GitHub's fetch boundary. */
export class ReportReceiver {
  private pending = Promise.resolve()
  private readonly token: Redacted.Redacted<string> | undefined

  constructor(private readonly storage: ReportStorage, token: string | undefined, private readonly github: (input: string, init: RequestInit) => Promise<Response> = fetch) {
    this.token = token ? Redacted.make(token) : undefined
  }

  /** Serializes accepted reports across GitHub's read/create boundary. Only the
   * daily counters are persisted; GitHub's open issue labels own deduplication. */
  submit(report: BugReport): Promise<Response> {
    const result = this.pending.then(() => this.send(report))
    this.pending = result.then(() => {}, () => {})
    return result
  }

  private async send(report: BugReport): Promise<Response> {
    if (!this.token) return Response.json({ error: "unavailable" }, { status: 503 })
    const day = new Date().toISOString().slice(0, 10)
    const label = report.kind === "manual" ? "manual" : `crash:${await crashSignature(report.error)}`
    const signatures = report.kind === "crash" ? signatureDay(await this.storage.get("signatures"), day) : undefined
    const posted = signatures?.posts[label]
    if (posted !== undefined && posted.count >= SIGNATURE_DAILY_POSTS) return Response.json({ reportId: posted.reportId })
    const budgetKey = `daily:${report.kind}`
    const count = dailyCount(await this.storage.get(budgetKey), day)
    if (count >= DAILY_LIMITS[report.kind]) return Response.json({ error: "daily_limit" }, { status: 429 })

    const reportId = `FW-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    const posts = (posted?.count ?? 0) + 1
    const body = issueBody(report, reportId, label, posts === SIGNATURE_DAILY_POSTS)
    // A compact JSON encoding can expand numeric exponents. Check the rendered
    // body too, rather than assuming the input byte cap proves GitHub's limit.
    if (body.length > MAX_ISSUE_CHARACTERS) return Response.json({ error: "report_too_large" }, { status: 413 })

    // Failed GitHub attempts also consume the budget, so an upstream outage
    // cannot turn this public endpoint into unbounded authenticated API work.
    await this.storage.put({
      [budgetKey]: { day, count: count + 1 },
      ...(signatures === undefined ? {} : { signatures: { day, posts: { ...signatures.posts, [label]: { count: posts, reportId } } } }),
    })
    const headers = {
      Authorization: `Bearer ${Redacted.value(this.token)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "Flywheel-Bug-Reports",
      "Content-Type": "application/json",
    }
    const github = this.github
    const call = (path: string, method = "GET", value?: unknown) => github(`${GITHUB_REPOSITORY}${path}`, { method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
    try {
      let issue: { readonly number: number } | undefined
      if (report.kind === "crash") {
        const listed = await call(`/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`)
        if (!listed.ok) throw new Error("github_list_failed")
        issue = decodeIssues(await listed.json())[0]
      }
      if (issue) {
        const commented = await call(`/issues/${issue.number}/comments`, "POST", { body })
        if (!commented.ok) throw new Error("github_comment_failed")
      } else {
        const existing = await call(`/labels/${encodeURIComponent(label)}`)
        if (existing.status === 404) {
          const created = await call("/labels", "POST", { name: label, color: "b60205" })
          if (!created.ok) throw new Error("github_label_failed")
        } else if (!existing.ok) throw new Error("github_label_failed")
        const created = await call("/issues", "POST", {
          title: inert(report.kind === "manual"
            ? `Report: ${report.note?.split(/\r\n|\r|\n/, 1)[0]?.slice(0, 80) || "no note"}`
            : `${report.error.name}: ${report.error.message}`.replace(/\s+/g, " ").slice(0, 200)),
          body,
          labels: [label],
        })
        if (!created.ok) throw new Error("github_create_failed")
      }
      return Response.json({ reportId })
    } catch {
      return Response.json({ error: "github_unavailable" }, { status: 502 })
    }
  }
}

/** The issue or comment body. Everything outside the code block is the
 *  relay's own text; the reporter's text is all inside it. The fence is one
 *  backtick longer than the longest run of backticks in the JSON (and at
 *  least three), so by CommonMark no line of the report can close it, and
 *  inside a code block GitHub renders no markup, link, or mention. */
function issueBody(report: BugReport, reportId: string, label: string, lastPostToday: boolean): string {
  const json = JSON.stringify(report)
  const fence = "`".repeat(Array.from(json.matchAll(/`+/g)).reduce((longest, run) => Math.max(longest, run[0].length + 1), 3))
  const lines = [`Report ${reportId}`]
  if (report.kind === "crash") lines.push(`Signature: ${label}`)
  if (lastPostToday) lines.push(`This signature reached ${SIGNATURE_DAILY_POSTS} posts today; later repeats today are not posted.`)
  return `${lines.join("\n")}\n\n${fence}json\n${json}\n${fence}`
}

/** The title with GitHub's references made inert. A title is the reporter's
 *  text outside any code block, and GitHub turns `@name` into a mention that
 *  notifies, `#12` and `owner/repo#12` into links, and a URL into a link. A
 *  zero-width joiner after each `@` and `#`, and inside each `://` and
 *  `www.`, leaves the text readable and matches none of them. */
function inert(title: string): string {
  return title.replace(/[@#]/g, "$&\u200D").replace(/:\/\//g, ":\u200D//").replace(/www\./gi, (match) => `${match.slice(0, 3)}\u200D.`)
}

function dailyCount(row: unknown, day: string): number {
  return typeof row === "object" && row !== null && "day" in row && row.day === day && "count" in row && typeof row.count === "number" ? row.count : 0
}

function signatureDay(row: unknown, day: string): SignatureDay {
  const posts: { [label: string]: { readonly count: number; readonly reportId: string } } = {}
  if (typeof row === "object" && row !== null && "day" in row && row.day === day && "posts" in row && typeof row.posts === "object" && row.posts !== null) {
    for (const [label, post] of Object.entries(row.posts)) {
      if (typeof post === "object" && post !== null && "count" in post && typeof post.count === "number" && "reportId" in post && typeof post.reportId === "string") posts[label] = { count: post.count, reportId: post.reportId }
    }
  }
  return { day, posts }
}

async function crashSignature(error: BugReport["error"]): Promise<string> {
  const message = error.message
    .replace(/https?:\/\/[^\s)'"]+/g, "<url>")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s)'"]+/g, "<path>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<address>")
    .replace(/\b\d+(?:\.\d+)*\b/g, "<number>")
    .replace(/\s+/g, " ").trim()
  const functions = error.stack.split("\n").flatMap((line) => {
    const v8 = /^\s*at\s+(.*?)\s+\(/.exec(line)
    if (v8) return [v8[1]!]
    const webkit = /^\s*([^@\s]+)@/.exec(line)
    return webkit ? [webkit[1]!] : []
  }).slice(0, 5)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([error.name, message, functions])))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)
}

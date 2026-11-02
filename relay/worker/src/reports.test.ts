import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { marked } from "marked"

import type { BugReport } from "./report-schema.js"
import { receiveReport, ReportReceiver } from "./reports.js"

const decodeReply = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))
const decodeIssue = Schema.decodeUnknownSync(Schema.Struct({ body: Schema.String, title: Schema.optionalKey(Schema.String), labels: Schema.optionalKey(Schema.Array(Schema.String)) }))
const decodeReceipt = Schema.decodeUnknownSync(Schema.Struct({ reportId: Schema.String }))
const today = () => new Date().toISOString().slice(0, 10)

const report: BugReport = {
  kind: "crash",
  error: { name: "TypeError", message: "undefined is not an object (evaluating 'block.kind')", stack: "TypeError: failure\n    at closesToolStretch (/app/chunk-abc.js:12:4)\n    at render (/app/chunk-def.js:42:8)" },
  version: "0.1.0",
  build: "abc123",
  os: "windows",
  arch: "x64",
  surface: "tui",
  sessionId: "session-1",
  diagnostics: { tui: [{ ts: 123, type: "log.error", payload: { kind: "failed", bytes: 42 } }], executor: [], account: [] },
}

function request(body: unknown = report, headers: HeadersInit = {}): Request {
  return new Request("https://relay.flywl.sh/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1", ...headers },
    body: JSON.stringify(body),
  })
}

/** A row the inbox stores, as its storage reads it back. */
type ReportRow = Awaited<ReturnType<ConstructorParameters<typeof ReportReceiver>[0]["get"]>>

function harness(responses: Response[] = []) {
  const values = new Map<string, ReportRow>()
  const calls: { url: URL; method: string; body: unknown; headers: Headers }[] = []
  const receiver = new ReportReceiver({
    async get(key: string) { return values.get(key) },
    async put(entries) { for (const [key, value] of Object.entries(entries)) values.set(key, value) },
  }, "test-token", async (input, init) => {
    calls.push({ url: new URL(String(input)), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) })
    const response = responses.shift()
    if (!response) throw new Error("unexpected GitHub request")
    return response
  })
  const ips: string[] = []
  const receive = (input: Request, allowed = true) => receiveReport(input, {
    limiter: { async limit({ key }) { ips.push(key); return { success: allowed } } },
    submit: (value) => receiver.submit(value),
  })
  return { receive, receiver, calls, values, ips }
}

describe("POST /reports", () => {
  test("creates a labeled private-repository issue and returns its short report id", async () => {
    const h = harness([Response.json([]), Response.json({}, { status: 404 }), Response.json({}, { status: 201 }), Response.json({ number: 17 }, { status: 201 })])
    const response = await h.receive(request({ ...report, note: "Stopped when I opened the session." }))
    expect(response.status).toBe(200)
    const result = Schema.decodeUnknownSync(Schema.Struct({ reportId: Schema.String }))(await response.json())
    expect(result.reportId).toMatch(/^FW-[a-f0-9]{12}$/)
    expect(h.ips).toEqual(["192.0.2.1"])
    expect(h.calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/repos/wsauret/flywheel-reports/issues"],
      ["GET", expect.stringMatching(/^\/repos\/wsauret\/flywheel-reports\/labels\/crash%3A[a-f0-9]{32}$/)],
      ["POST", "/repos/wsauret/flywheel-reports/labels"],
      ["POST", "/repos/wsauret/flywheel-reports/issues"],
    ])
    expect(h.calls[0]!.url.searchParams.get("state")).toBe("open")
    const issue = decodeIssue(h.calls[3]!.body)
    expect(issue.labels).toEqual([h.calls[0]!.url.searchParams.get("labels")!])
    expect(issue.body).toContain(result.reportId)
    expect(issue.body).toContain("Stopped when I opened the session.")
    expect(issue.body).toContain('"bytes":42')
    expect(h.calls[0]!.headers.get("authorization")).toBe("Bearer test-token")
    expect(issue.body).not.toContain("test-token")
  })

  test("comments on an open signature issue and ignores build filenames, line numbers, paths, ids, and counts", async () => {
    const h = harness([
      Response.json([{ number: 17, title: "existing issue" }]), Response.json({}, { status: 201 }),
      Response.json([{ number: 17 }]), Response.json({}, { status: 201 }),
    ])
    const first = await h.receive(request({
      ...report,
      error: { ...report.error, message: "failed 12 times at C:\\Users\\test\\app.js for 123e4567-e89b-12d3-a456-426614174000" },
    }))
    const second = await h.receive(request({
      ...report, version: "0.2.0", build: null, sessionId: null,
      error: {
        ...report.error,
        message: "failed 99 times at /home/user/new.js for 00000000-0000-0000-0000-000000000000",
        stack: "TypeError: changed\nclosesToolStretch@https://host/chunk-new.js:900:2\nrender@https://host/other.js:71:2",
      },
    }))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(h.calls[0]!.url.searchParams.get("labels")).toBe(h.calls[2]!.url.searchParams.get("labels"))
    expect(h.calls[1]!.url.pathname).toBe("/repos/wsauret/flywheel-reports/issues/17/comments")
    expect(h.calls[3]!.url.pathname).toBe(h.calls[1]!.url.pathname)
    expect(await first.json()).not.toEqual(await second.json())
  })

  test.each([
    { note: `${"a".repeat(90)}\nsecond line`, title: `Report: ${"a".repeat(80)}` },
    { note: "The menu froze\nsecond line", title: "Report: The menu froze" },
    { note: undefined, title: "Report: no note" },
    { note: "", title: "Report: no note" },
  ])("opens a separate manual issue for every report ($title)", async ({ note, title }) => {
    const h = harness([
      Response.json({}), Response.json({ number: 17 }, { status: 201 }),
      Response.json({}), Response.json({ number: 18 }, { status: 201 }),
    ])
    const body = { ...report, kind: "manual", ...(note === undefined ? {} : { note }) }
    expect((await h.receive(request(body))).status).toBe(200)
    expect((await h.receive(request(body))).status).toBe(200)
    expect(h.calls.map((call) => [call.method, call.url.pathname])).toEqual([
      ["GET", "/repos/wsauret/flywheel-reports/labels/manual"],
      ["POST", "/repos/wsauret/flywheel-reports/issues"],
      ["GET", "/repos/wsauret/flywheel-reports/labels/manual"],
      ["POST", "/repos/wsauret/flywheel-reports/issues"],
    ])
    expect(h.calls[1]?.body).toMatchObject({ title, labels: ["manual"] })
    expect(h.calls[3]?.body).toMatchObject({ title, labels: ["manual"] })
  })

  test("keeps different function names, message shapes, and error names in separate signatures", async () => {
    const h = harness(Array.from({ length: 4 }, () => [Response.json([{ number: 17 }]), Response.json({}, { status: 201 })]).flat())
    for (const error of [
      report.error,
      { ...report.error, name: "RangeError" },
      { ...report.error, message: "Cannot read a session" },
      { ...report.error, stack: report.error.stack.replace("closesToolStretch", "differentFunction") },
    ]) expect((await h.receive(request({ ...report, error }))).status).toBe(200)
    expect(new Set(h.calls.filter((call) => call.method === "GET").map((call) => call.url.searchParams.get("labels"))).size).toBe(4)
  })

  test.each([
    { ...report, kind: undefined },
    { ...report, kind: "unknown" },
    { ...report, unexpected: true },
    { ...report, error: { ...report.error, text: "extra" } },
    { ...report, build: 42 },
    { ...report, sessionId: undefined },
    { ...report, diagnostics: { ...report.diagnostics, unknown: [] } },
    { ...report, diagnostics: { ...report.diagnostics, tui: [{ ts: 123, type: "log.error", content: "extra" }] } },
    { ...report, diagnostics: { ...report.diagnostics, account: [{ ts: "today", type: "log.error" }] } },
  ])("rejects invalid or excess report fields without reaching GitHub (%#)", async (body) => {
    const h = harness()
    const response = await h.receive(request(body))
    expect(response.status).toBe(400)
    expect(decodeReply(await response.json())).toEqual({ error: "invalid_report" })
    expect(h.calls).toHaveLength(0)
  })

  test("refuses malformed JSON, empty bodies, and invalid UTF-8", async () => {
    const h = harness()
    for (const body of ["{", undefined, new Uint8Array([0xff])]) {
      const response = await h.receive(new Request("https://relay.flywl.sh/reports", { method: "POST", body }))
      expect(response.status).toBe(400)
    }
    expect(h.calls).toHaveLength(0)
  })

  test("enforces the cap on streamed UTF-8 bytes without trusting Content-Length", async () => {
    const h = harness()
    let canceled = false
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...report, note: "\u00e9".repeat(25_000) }))) },
      cancel() { canceled = true },
    })
    const response = await h.receive(new Request("https://relay.flywl.sh/reports", { method: "POST", body, headers: { "content-length": "1" } }))
    expect(response.status).toBe(413)
    expect(decodeReply(await response.json())).toEqual({ error: "report_too_large" })
    expect(canceled).toBe(true)
    expect(h.calls).toHaveLength(0)
  })

  test("accepts the byte ceiling and keeps the emitted issue body below GitHub's character limit", async () => {
    const h = harness([Response.json([{ number: 17 }]), Response.json({}, { status: 201 })])
    const emptySize = new TextEncoder().encode(JSON.stringify({ ...report, note: "" })).byteLength
    const response = await h.receive(request({ ...report, note: "x".repeat(48 * 1024 - emptySize) }))
    expect(response.status).toBe(200)
    expect(decodeIssue(h.calls[1]!.body).body.length).toBeLessThan(65_536)
  })

  test("refuses numeric JSON whose compact rendering exceeds the issue-body cap", async () => {
    const h = harness()
    const json = JSON.stringify({ ...report, diagnostics: { ...report.diagnostics, account: [{ ts: 123, type: "log.error", payload: [] }] } })
      .replace('"payload":[]', `"payload":[${Array.from({ length: 6_000 }, () => "1e9").join(",")}]`)
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(48 * 1024)
    const response = await h.receive(new Request("https://relay.flywl.sh/reports", { method: "POST", body: json }))
    expect(response.status).toBe(413)
    expect(h.calls).toHaveLength(0)
  })

  test("applies the IP limiter before reading or forwarding a refused report", async () => {
    const h = harness()
    const response = await h.receive(request(), false)
    expect(response.status).toBe(429)
    expect(decodeReply(await response.json())).toEqual({ error: "rate_limited" })
    expect(h.ips).toEqual(["192.0.2.1"])
    expect(h.calls).toHaveLength(0)
  })

  test("allows only POST and returns Allow without consuming IP quota", async () => {
    const h = harness()
    const response = await h.receive(new Request("https://relay.flywl.sh/reports"))
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("POST")
    expect(h.ips).toHaveLength(0)
  })

  test("enforces a persistent daily crash budget across IPs and resets it on a new UTC day", async () => {
    const h = harness([
      Response.json([{ number: 17 }]), Response.json({}, { status: 201 }),
      Response.json([{ number: 17 }]), Response.json({}, { status: 201 }),
    ])
    h.values.set("daily:crash", { day: today(), count: 399 })
    expect((await h.receive(request())).status).toBe(200)
    const capped = await h.receive(request({ ...report, error: { ...report.error, name: "RangeError" } }, { "cf-connecting-ip": "192.0.2.2" }))
    expect(capped.status).toBe(429)
    expect(decodeReply(await capped.json())).toEqual({ error: "daily_limit" })
    expect(h.calls).toHaveLength(2)
    h.values.set("daily:crash", { day: "2000-01-01", count: 400 })
    expect((await h.receive(request())).status).toBe(200)
    expect(h.values.get("daily:crash")).toEqual({ day: today(), count: 1 })
  })

  test("manual reports that exhaust their own budget leave the crash budget whole", async () => {
    const manual = { ...report, kind: "manual", note: "spam" }
    const h = harness([
      ...Array.from({ length: 100 }, () => [Response.json({}), Response.json({ number: 18 }, { status: 201 })]).flat(),
      Response.json([{ number: 17 }]), Response.json({}, { status: 201 }),
    ])
    // One sender rotating addresses, as the IP limiter cannot stop.
    for (let index = 0; index < 100; index += 1) expect((await h.receive(request(manual, { "cf-connecting-ip": `198.51.100.${index}` }))).status).toBe(200)
    const refused = await h.receive(request(manual, { "cf-connecting-ip": "198.51.100.200" }))
    expect(refused.status).toBe(429)
    expect(decodeReply(await refused.json())).toEqual({ error: "daily_limit" })
    expect((await h.receive(request())).status).toBe(200)
    expect(h.values.get("daily:crash")).toEqual({ day: today(), count: 1 })
    expect(h.calls.at(-1)!.url.pathname).toEndWith("/17/comments")
  })

  test("posts one crash signature at most ten times a day, says so in the tenth, and answers later repeats with that post's id at no cost", async () => {
    const h = harness(Array.from({ length: 10 }, () => [Response.json([{ number: 17 }]), Response.json({}, { status: 201 })]).flat())
    const ids: string[] = []
    for (let index = 0; index < 12; index += 1) {
      const response = await h.receive(request())
      expect(response.status).toBe(200)
      ids.push(decodeReceipt(await response.json()).reportId)
    }
    const comments = h.calls.filter((call) => call.method === "POST").map((call) => decodeIssue(call.body).body)
    expect(comments).toHaveLength(10)
    expect(comments.filter((body) => body.includes("later repeats today are not posted"))).toHaveLength(1)
    expect(comments[9]).toContain("later repeats today are not posted")
    expect(ids[10]).toBe(ids[9])
    expect(ids[11]).toBe(ids[9])
    expect(h.values.get("daily:crash")).toEqual({ day: today(), count: 10 })
    // Another signature is posted as before.
    const other = harness([Response.json([{ number: 18 }]), Response.json({}, { status: 201 })])
    other.values.set("signatures", h.values.get("signatures"))
    expect((await other.receive(request({ ...report, error: { ...report.error, name: "RangeError" } }))).status).toBe(200)
    expect(other.calls).toHaveLength(2)
  })

  test("keeps the report's text inside an unbreakable code block and makes the title's mentions and links inert", async () => {
    const hostile = "```\n@maintainer please look ![x](https://evil.example/p.png) [link](https://evil.example) #12 www.evil.example ````"
    const h = harness([
      Response.json([]), Response.json({}, { status: 404 }), Response.json({}, { status: 201 }), Response.json({ number: 17 }, { status: 201 }),
      Response.json({}), Response.json({ number: 18 }, { status: 201 }),
    ])
    expect((await h.receive(request({ ...report, error: { ...report.error, message: hostile, stack: `${report.error.stack}\n\`\`\`\`\`\`` } }))).status).toBe(200)
    expect((await h.receive(request({ ...report, kind: "manual", note: `@team/owners ${hostile.replace("\n", " ")}` }))).status).toBe(200)
    for (const issue of [h.calls[3]!, h.calls[5]!].map((call) => decodeIssue(call.body))) {
      // By CommonMark, as GitHub renders it: the relay's lines, then one code
      // block that holds the whole report and nothing after it.
      const tokens = marked.lexer(issue.body).filter((token) => token.type !== "space")
      expect(tokens.map((token) => token.type)).toEqual(["paragraph", "code"])
      const block = tokens[1]!
      if (block.type !== "code") throw new Error("expected a code block")
      expect(JSON.parse(block.text)).toMatchObject({ error: { name: "TypeError" } })
      expect(tokens[0]!.raw).not.toContain("@")
      const title = issue.title ?? ""
      expect(title).not.toMatch(/@[A-Za-z]/)
      expect(title).not.toMatch(/#\d/)
      expect(title).not.toContain("://")
      expect(title).not.toMatch(/www\./i)
      expect(title).toContain("@\u200Dm")
    }
  })

  test("serializes simultaneous first reports through issue creation before deduplication", async () => {
    const h = harness([
      Response.json([]), Response.json({}), Response.json({ number: 17 }, { status: 201 }),
      Response.json([{ number: 17 }]), Response.json({}, { status: 201 }),
    ])
    const responses = await Promise.all([h.receive(request()), h.receive(request())])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(h.calls.map((call) => call.method)).toEqual(["GET", "GET", "POST", "GET", "POST"])
    expect(h.calls[4]!.url.pathname).toEndWith("/17/comments")
  })

  test.each([
    [Response.json({}, { status: 401 })],
    [Response.json({ malformed: true })],
    [Response.json([{ number: "../unsafe" }])],
    [Response.json([{ number: 17 }]), Response.json({}, { status: 500 })],
    [Response.json([]), Response.json({}, { status: 500 })],
    [Response.json([]), Response.json({}, { status: 404 }), Response.json({}, { status: 403 })],
    [Response.json([]), Response.json({}), Response.json({}, { status: 422 })],
  ].map((responses) => ({ responses })))("reports GitHub failures without returning token or upstream body (%#)", async ({ responses }) => {
    const h = harness(responses)
    const response = await h.receive(request())
    expect(response.status).toBe(502)
    expect(decodeReply(await response.json())).toEqual({ error: "github_unavailable" })
    expect(h.values.get("daily:crash")).toEqual({ day: today(), count: 1 })
  })

  test("keeps the queue usable after network failure and does not invent success without a token", async () => {
    const h = harness()
    expect((await h.receive(request())).status).toBe(502)
    expect((await h.receive(request())).status).toBe(502)
    const noToken = new ReportReceiver({
      async get() { return undefined },
      async put() { throw new Error("must not persist without a token") },
    }, undefined)
    const response = await noToken.submit(report)
    expect(response.status).toBe(503)
    expect(decodeReply(await response.json())).toEqual({ error: "unavailable" })
  })
})

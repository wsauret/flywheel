/**
 * An in-process fake of the Gemini API for the bundled Antigravity CLI in API-key mode, which reaches it through
 * `GOOGLE_GEMINI_BASE_URL`. It answers each generate request from a scripted queue and records every request it
 * received, classified as the engine's title request, a compaction (summary) request, a main request, or another call,
 * so a test can count every request the engine sent, also the hidden ones. Ported from the spike harness's fake.
 */

/** One scripted answer of a main request. `text`: a model answer, sent after `delayMs`. `calls`: a model answer with
 *  function calls, after a thought part when `thought` is set. `status`: an HTTP error with the Gemini error body
 *  (`body` replaces it, for example with a RetryInfo detail). `when` names a text that the request must contain, so
 *  concurrent sessions take their own answers. `promptTokens` replaces the prompt token count that the answer reports,
 *  which is the request body's length divided by 4 otherwise. */
export type FakeAnswer = { readonly when?: string; readonly promptTokens?: number } & (
  | { readonly kind: "text"; readonly text: string; readonly delayMs?: number }
  | { readonly kind: "calls"; readonly calls: readonly { readonly name: string; readonly args?: { readonly [name: string]: unknown } }[]; readonly thought?: string }
  | { readonly kind: "status"; readonly status: number; readonly body?: unknown }
)

export type FakeRequestKind = "title" | "compaction" | "main" | "other"

/** One request the fake received. The body is kept, so a test can check the content the engine sent. */
export interface FakeRequest {
  readonly kind: FakeRequestKind
  readonly at: number
  readonly path: string
  readonly body: string
  /** The scripted answer that a main request took, or nothing for every other kind. */
  readonly answer: FakeAnswer | undefined
}

export interface FakeGemini {
  /** The base URL for `GOOGLE_GEMINI_BASE_URL`. */
  readonly url: string
  /** Queues answers for the next main requests. A main request with an empty queue gets the text `default reply`. */
  script(answers: readonly FakeAnswer[]): void
  /** Every request so far, in arrival order. */
  readonly requests: readonly FakeRequest[]
  close(): Promise<void>
}

const TITLE_MARKER = /You are a conversation title generator/u
const COMPACTION_MARKER = /continuation summary/iu
const GENERATE = /:(stream)?[gG]enerateContent$/u

function errorStatus(status: number): string {
  if (status === 429) return "RESOURCE_EXHAUSTED"
  if (status === 503) return "UNAVAILABLE"
  return "INTERNAL"
}

function candidate(answer: Exclude<FakeAnswer, { readonly kind: "status" }>) {
  const parts = answer.kind === "text"
    ? [{ text: answer.text }]
    : [
      ...answer.thought === undefined ? [] : [{ text: answer.thought, thought: true }],
      ...answer.calls.map((call) => ({ functionCall: { name: call.name, args: call.args ?? {} }, thoughtSignature: "c2ln" })),
    ]
  return { content: { role: "model", parts }, finishReason: "STOP", index: 0 }
}

/** Opens the fake on an ephemeral loopback port. `titleStatus` makes every title request fail with that status. */
export function openFakeGemini(options: { readonly titleStatus?: number } = {}): FakeGemini {
  const queue: FakeAnswer[] = []
  const requests: FakeRequest[] = []
  const take = (body: string): FakeAnswer | undefined => {
    const index = queue.findIndex(({ when }) => when === undefined || body.includes(when))
    return index < 0 ? undefined : queue.splice(index, 1)[0]
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.text()
      const generate = GENERATE.test(path)
      const kind: FakeRequestKind = !generate ? "other" : TITLE_MARKER.test(body) ? "title" : COMPACTION_MARKER.test(body) ? "compaction" : "main"
      const answer: FakeAnswer | undefined = kind === "main" ? take(body) ?? { kind: "text", text: "default reply" } : undefined
      requests.push({ kind, at: Date.now(), path, body, answer })
      if (!generate) {
        if (/\/models\/?$/u.test(path)) return Response.json({ models: [] })
        return Response.json({})
      }
      const failure = kind === "title" && options.titleStatus !== undefined ? { kind: "status", status: options.titleStatus } as const : answer?.kind === "status" ? answer : undefined
      if (failure !== undefined) {
        const error = failure.body ?? { error: { code: failure.status, message: `scripted ${String(failure.status)}`, status: errorStatus(failure.status) } }
        return Response.json(error, { status: failure.status })
      }
      if (answer?.kind === "status") throw new Error("unreachable: a status answer returned above")
      const reply = answer ?? { kind: "text", text: "Fake Title" } as const
      if (reply.kind === "text" && reply.delayMs !== undefined) await Bun.sleep(reply.delayMs)
      const promptTokens = answer?.promptTokens ?? Math.ceil(body.length / 4)
      const response = {
        candidates: [candidate(reply)],
        usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: 7, totalTokenCount: promptTokens + 7, cachedContentTokenCount: 0, thoughtsTokenCount: 0 },
        modelVersion: "fake-model",
        responseId: `fake-${String(requests.length)}`,
      }
      if (!path.endsWith(":streamGenerateContent")) return Response.json(response)
      if (new URL(request.url).searchParams.get("alt") === "sse") return new Response(`data: ${JSON.stringify(response)}\r\n\r\n`, { headers: { "content-type": "text/event-stream" } })
      return Response.json([response])
    },
  })
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    script: (answers) => { queue.push(...answers) },
    requests,
    close: () => server.stop(true),
  }
}

/** The loopback OpenAI-compatible provider the executor-responsiveness
 *  scenario serves. It answers by model and by the conversation's first user
 *  message, so each session the scenario opens plays one part:
 *
 *  - A probe session streams one visible delta every 5 ms until the scenario
 *    ends its phase. The executor records the longest gap it saw between two
 *    deltas in the stream's summary fact, which is the timer-gap probe.
 *  - A task session calls the `code` tool with a fixed program, then answers
 *    once the result is back. The capacity task asks for forty calls at once,
 *    three times.
 *  - The routed learning review uses its own model, so its requests are kept
 *    whole for the scenario's exactness checks.
 *
 *  The provider runs on the scenario's own thread. Nothing here parses a
 *  large body while a probe streams, so the probe's own cadence stays exact;
 *  the scenario checks that cadence and voids a probe whose source stalled. */

export const CHAT_MODEL = "chat-model"
export const REVIEW_MODEL = "review-model"
export const TITLE_MODEL = "title-model"

const PROBE_INTERVAL_MS = 5
/** A probe is flowing once this many deltas have gone out. */
const PROBE_FLOWING_DELTAS = 20
const CAPACITY_CALLS_PER_BATCH = 40
const CAPACITY_BATCHES = 3

export type FixtureTask = "code-result" | "compute-interrupt" | "pending-interrupt" | "capacity"

/** The marker a session's opening message carries: its part and its name. */
const SESSION_PART = /executor-responsiveness (probe|task) ([\w-]+)/

export function taskMessage(task: FixtureTask): string {
  return `executor-responsiveness task ${task}`
}

export function probeMessage(probeId: string): string {
  return `executor-responsiveness probe ${probeId}`
}

/** The programs the task sessions run. The result reports the parsed array's
 *  length and last index, so a truncated or reordered result is visible. */
const LARGE_RESULT_SOURCE = "const result = await tools.loop.large({}); return { outcome: result.outcome, items: result.content.length, last: result.content.at(-1).index }"
const COMPUTE_SOURCE = "for (;;) {}"
const PENDING_SOURCE = "await tools.loop.pending({}); return \"unreachable\""

/** Whether a tool result is the whole large result: every item parsed, in order. */
export function isWholeLargeResult(text: string, items: number): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return isFields(parsed) && parsed.outcome === "ok" && parsed.items === items && parsed.last === items - 1
  } catch {
    return false
  }
}

interface ProbeStream {
  sent: number
  maxSourceGapMs: number
  ended: boolean
  readonly flowing: PromiseWithResolvers<void>
}

export interface ProbeSource {
  /** Deltas the provider sent. */
  readonly sent: number
  /** The longest gap between two of its own sends. */
  readonly maxSourceGapMs: number
}

export interface ReviewRequest {
  readonly receivedAt: number
  readonly body: string
}

export interface CapacityBatch {
  /** When the provider finished sending the batch's calls. */
  readonly sentAt: number
  /** When the request that carries the batch's results arrived. */
  receivedAt?: number
  /** Each call's result text, in call order. */
  results: readonly string[]
}

interface RequestMessage {
  readonly role: string
  readonly text: string
}

interface JsonFields {
  readonly [key: string]: unknown
}

function isFields(value: unknown): value is JsonFields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The messages of a chat-completions request with each content as text. */
function requestMessages(body: string): RequestMessage[] {
  const parsed: unknown = JSON.parse(body)
  if (!isFields(parsed) || !Array.isArray(parsed.messages)) return []
  return parsed.messages.flatMap((message: unknown) => {
    if (!isFields(message) || typeof message.role !== "string") return []
    const content = message.content
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((part: unknown) => isFields(part) && typeof part.text === "string" ? part.text : "").join("")
        : ""
    return [{ role: message.role, text }]
  })
}

/** The text of the review's instruction: the last user message that states the
 *  skill load counts. A tree-hosted review sends its tool notice as request
 *  context in a later user message, so the instruction need not be the last. */
export function reviewInstructionText(body: string): string {
  return requestMessages(body).findLast((message) => message.role === "user" && message.text.includes("## Skill load counts"))?.text ?? ""
}

/** Values that arrive one after another; a waiter asks for the nth. */
function arrivals<T extends object | string>() {
  const values: T[] = []
  const waiters: { readonly index: number; readonly resolve: (value: T) => void }[] = []
  return {
    push(value: T): void {
      values.push(value)
      // An earlier index was answered when it arrived or when it was asked for.
      for (const waiter of waiters.filter(({ index }) => index === values.length - 1)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(value)
      }
    },
    nth(index: number): Promise<T> {
      const value = values[index]
      if (value !== undefined) return Promise.resolve(value)
      const waiting = Promise.withResolvers<T>()
      waiters.push({ index, resolve: waiting.resolve })
      return waiting.promise
    },
  }
}

function sse(data: JsonFields): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function chunk(model: string, delta: JsonFields, finishReason: string | null = null): string {
  return sse({ id: "responsiveness-response", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finishReason }] })
}

function finish(model: string, reason: "stop" | "tool_calls"): string {
  return chunk(model, {}, reason)
    + sse({ id: "responsiveness-response", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 } })
    + "data: [DONE]\n\n"
}

function stream(produce: (send: (text: string) => void) => Promise<void> | void): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        await produce((text) => controller.enqueue(encoder.encode(text)))
        controller.close()
      } catch {
        // The runtime closed the stream, or the scenario stopped the provider.
      }
    },
  }), { headers: { "content-type": "text/event-stream" } })
}

function answer(model: string, text: string): Response {
  return stream((send) => send(chunk(model, { content: text }) + finish(model, "stop")))
}

function codeCalls(model: string, ids: readonly string[], source: string): string {
  const calls = ids.map((id, index) => chunk(model, { tool_calls: [{ index, id, type: "function", function: { name: "code", arguments: JSON.stringify({ source }) } }] }))
  return calls.join("") + finish(model, "tool_calls")
}

export function startResponsivenessProvider() {
  let stopped = false
  let unexpected = 0
  const probes = new Map<string, ProbeStream>()
  const reviews = arrivals<ReviewRequest>()
  const codeResults = arrivals<string>()
  const capacityBatches: CapacityBatch[] = []
  const capacityDone = Promise.withResolvers<readonly CapacityBatch[]>()

  function probe(probeId: string): ProbeStream {
    const existing = probes.get(probeId)
    if (existing) return existing
    const created: ProbeStream = { sent: 0, maxSourceGapMs: 0, ended: false, flowing: Promise.withResolvers<void>() }
    probes.set(probeId, created)
    return created
  }

  function probeResponse(probeId: string): Response {
    const state = probe(probeId)
    // The scenario ends the probe from outside this loop.
    const streaming = () => !state.ended && !stopped
    return stream(async (send) => {
      let previous = performance.now()
      while (streaming()) {
        send(chunk(CHAT_MODEL, { content: "probe " }))
        const now = performance.now()
        if (state.sent > 0) state.maxSourceGapMs = Math.max(state.maxSourceGapMs, now - previous)
        previous = now
        state.sent++
        if (state.sent === PROBE_FLOWING_DELTAS) state.flowing.resolve()
        await Bun.sleep(PROBE_INTERVAL_MS)
      }
      if (!stopped) send(finish(CHAT_MODEL, "stop"))
    })
  }

  function capacityResponse(results: readonly RequestMessage[]): Response {
    const batch = results.length / CAPACITY_CALLS_PER_BATCH
    const previous = capacityBatches[batch - 1]
    if (previous) {
      previous.receivedAt = performance.now()
      previous.results = results.slice(-CAPACITY_CALLS_PER_BATCH).map((message) => message.text)
    }
    if (batch >= CAPACITY_BATCHES) {
      capacityDone.resolve(capacityBatches)
      return answer(CHAT_MODEL, "Every capacity batch is done.")
    }
    const ids = Array.from({ length: CAPACITY_CALLS_PER_BATCH }, (_, index) => `capacity-${batch}-${index}`)
    return stream((send) => {
      send(codeCalls(CHAT_MODEL, ids, LARGE_RESULT_SOURCE))
      capacityBatches.push({ sentAt: performance.now(), results: [] })
    })
  }

  function taskResponse(task: FixtureTask, messages: readonly RequestMessage[]): Response {
    const results = messages.filter((message) => message.role === "tool")
    if (task === "capacity") return capacityResponse(results)
    if (results.length > 0) {
      if (task === "code-result") codeResults.push(results.at(-1)?.text ?? "")
      return answer(CHAT_MODEL, "The program finished.")
    }
    const source = task === "code-result" ? LARGE_RESULT_SOURCE : task === "compute-interrupt" ? COMPUTE_SOURCE : PENDING_SOURCE
    return stream((send) => send(codeCalls(CHAT_MODEL, [`${task}-call`], source)))
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The capacity batch and the review can keep a response open for a while.
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [CHAT_MODEL, REVIEW_MODEL, TITLE_MODEL].map((id) => ({ id, object: "model", created: 0, owned_by: "fixture" })) })
      }
      const receivedAt = performance.now()
      const body = await request.text()
      // The model is read without parsing, because a review body carries the
      // giant transcript and a parse would hold this thread while a probe streams.
      const model = /"model"\s*:\s*"([^"]+)"/.exec(body)?.[1]
      if (model === REVIEW_MODEL) {
        reviews.push({ receivedAt, body })
        return answer(REVIEW_MODEL, "Nothing in this session is worth saving.")
      }
      if (model === TITLE_MODEL) return answer(TITLE_MODEL, "Fixture title")
      const messages = requestMessages(body)
      // The runtime can put context of its own in user messages, so the
      // part is found by its marker, not by position.
      const part = messages.filter((message) => message.role === "user").map((message) => SESSION_PART.exec(message.text)).find((match) => match !== null)
      // One stream per probe: a second request would double the cadence.
      if (part?.[1] === "probe" && part[2] !== undefined && probe(part[2]).sent === 0) return probeResponse(part[2])
      const task = part?.[1] === "task" ? part[2] : undefined
      if (task === "code-result" || task === "compute-interrupt" || task === "pending-interrupt" || task === "capacity") return taskResponse(task, messages)
      unexpected++
      return answer(model ?? CHAT_MODEL, "Fixture answer.")
    },
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    /** Settles once the probe's stream has sent its first deltas. */
    probeFlowing: (probeId: string): Promise<void> => probe(probeId).flowing.promise,
    /** Ends the probe's stream and reports its own cadence. */
    endProbe(probeId: string): ProbeSource {
      const state = probe(probeId)
      state.ended = true
      return { sent: state.sent, maxSourceGapMs: state.maxSourceGapMs }
    },
    /** The nth routed review request, counted from zero across the run. */
    review: (index: number): Promise<ReviewRequest> => reviews.nth(index),
    /** The nth code-result task's tool result text, counted from zero. */
    codeResult: (index: number): Promise<string> => codeResults.nth(index),
    /** Every capacity batch, once the last batch's results arrived. */
    capacity: (): Promise<readonly CapacityBatch[]> => capacityDone.promise,
    capacityCallsPerBatch: CAPACITY_CALLS_PER_BATCH,
    capacityBatches: CAPACITY_BATCHES,
    /** Requests that no session of the scenario should have made. */
    unexpectedRequests: (): number => unexpected,
    stop(): void {
      stopped = true
      for (const state of probes.values()) state.ended = true
      server.stop(true)
    },
  }
}

export type ResponsivenessProvider = ReturnType<typeof startResponsivenessProvider>

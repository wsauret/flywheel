import { AsyncLocalStorage } from "node:async_hooks";
import { maxEventLoopLagBetween } from "../../../../infra/diagnostics/event-loop-lag.js";
import { beginOutboundRequest, endOutboundRequest } from "./inflight-requests.js";
import type { StreamTelemetrySink } from "../types.js";

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface FetchTimings {
  /** `performance.now()` when the request hit the socket layer. */
  fetchInvokedAt?: number;
  /** `performance.now()` when response headers came back. */
  headersAt?: number;
}

const fetchTimings = new AsyncLocalStorage<FetchTimings>();

/** Stamps connection-send and header-receipt times into the ambient
 *  FetchTimings store that `sendStreamingRequest` opens. Pass it to a provider
 *  SDK whose requests go through `sendStreamingRequest`; outside that store it
 *  is a plain `fetch`. Splits the dead-zone window into [our prep] +
 *  [connect + send + server think]. */
export const timingFetch: FetchLike = (url, init) => {
  const store = fetchTimings.getStore();
  if (!store) return fetch(url, init);
  store.fetchInvokedAt = performance.now();
  return fetch(url, init).then((response) => {
    store.headersAt = performance.now();
    return response;
  });
};

interface StreamSendContext {
  telemetry: StreamTelemetrySink | undefined;
  /** `performance.now()` captured at the top of the turn, before prep. */
  turnStart: number;
  /** First request issued on a freshly-created adapter (tests connection reuse). */
  coldAdapter: boolean;
}

interface StreamSendResult<T> {
  data: T;
  response: Response;
  /** Marks the request no longer in-flight. Call when the stream ends
   *  (success, error, or abort). Idempotent. */
  endInFlight: () => void;
}

/** Sends a streaming provider request with full dead-zone instrumentation:
 *  in-flight accounting, fetch-level connect/header timing, and event-loop lag
 *  during the window. Emits a `model.stream.event_observed` fact
 *  (source "request", kind "timing"). The caller invokes `endInFlight` once the
 *  stream is fully consumed.
 *
 *  Anthropic-only by design: this exists for the Opus TTFB dead-zone investigation,
 *  so only Anthropic-protocol requests open the timing store. A client that sends
 *  through `timingFetch` on another path, such as the shared Copilot fetch for its
 *  OpenAI route, gets a plain fetch. Thread this through another provider only when
 *  that provider needs the same dead-zone breakdown. */
export async function sendStreamingRequest<T>(
  create: () => Promise<{ data: T; response: Response }>,
  ctx: StreamSendContext,
): Promise<StreamSendResult<T>> {
  const timings: FetchTimings = {};
  const inFlightAtSend = beginOutboundRequest();
  let ended = false;
  const endInFlight = (): void => {
    if (ended) return;
    ended = true;
    endOutboundRequest();
  };
  const sendAt = performance.now();
  let result: { data: T; response: Response };
  try {
    result = await fetchTimings.run(timings, create);
  } catch (err) {
    try {
      emitRequestTiming(ctx, timings, sendAt, inFlightAtSend);
    } finally {
      endInFlight();
    }
    throw err;
  }
  try {
    emitRequestTiming(ctx, timings, sendAt, inFlightAtSend);
    return { data: result.data, response: result.response, endInFlight };
  } catch (err) {
    endInFlight();
    throw err;
  }
}

function emitRequestTiming(
  ctx: StreamSendContext,
  timings: FetchTimings,
  sendAt: number,
  inFlightAtSend: number,
): void {
  if (!ctx.telemetry) return;
  const fetchInvokedAt = timings.fetchInvokedAt ?? sendAt;
  const headersAt = timings.headersAt ?? performance.now();
  ctx.telemetry.observe({
    source: "request",
    kind: "timing",
    metadata: {
      // prep: model-info resolve + message conversion + param build + params fact.
      prepMs: Math.round(sendAt - ctx.turnStart),
      // SDK request serialization between the call and the actual socket write.
      sdkBuildMs: Math.round(fetchInvokedAt - sendAt),
      // connect + TLS + send + server think-time until response headers.
      fetchWaitMs: Math.round(headersAt - fetchInvokedAt),
      // peak main-thread starvation during the window (loop too busy to react).
      eventLoopLagMs: maxEventLoopLagBetween(ctx.turnStart, headersAt),
      coldAdapter: ctx.coldAdapter,
      inFlightAtSend,
    },
  });
}

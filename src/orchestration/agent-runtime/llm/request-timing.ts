import { AsyncLocalStorage } from "node:async_hooks";
import { maxEventLoopLagBetween } from "../../../infra/event-loop-lag.js";
import { beginOutboundRequest, endOutboundRequest } from "../../../infra/inflight-requests.js";
import type { StreamTelemetrySink } from "./types.js";

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface FetchTimings {
  /** `performance.now()` when the request hit the socket layer. */
  fetchInvokedAt?: number;
  /** `performance.now()` when response headers came back. */
  headersAt?: number;
}

const fetchTimings = new AsyncLocalStorage<FetchTimings>();

export interface ResettableTimingFetch {
  fetch: FetchLike;
  resetIdleConnections: () => void;
}

/** Wraps `fetch` to stamp connection-send and header-receipt times into the
 *  ambient FetchTimings store. Pass to provider SDKs as their `fetch`.
 *  Splits the dead-zone window into [our prep] + [connect + send + server think]. */
export function createResettableTimingFetch(): ResettableTimingFetch {
  let closeNextRequest = false;
  return {
    fetch: (url, init) => {
      const effectiveInit = closeNextRequest ? connectionCloseInit(init) : init;
      closeNextRequest = false;
      const store = fetchTimings.getStore();
      if (!store) return fetch(url, effectiveInit);
      store.fetchInvokedAt = performance.now();
      return fetch(url, effectiveInit).then((response) => {
        store.headersAt = performance.now();
        return response;
      });
    },
    resetIdleConnections: () => {
      closeNextRequest = true;
    },
  };
}

function connectionCloseInit(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Connection", "close");
  return { ...init, headers, keepalive: false };
}

/** Adapter transport wiring for SDK clients that may be injected pre-built.
 *  Resolution order for withRetryStream's resetIdleConnections hook: an
 *  explicit override wins; otherwise the timing fetch's reset applies only
 *  when the adapter built its own client - an injected client never routed
 *  through our fetch, so we have no idle sockets to close on its behalf. */
export function resolveAdapterTransport(
  overrides: { client?: unknown; resetIdleConnections?: () => void | Promise<void> } | undefined,
) {
  const timingFetch = createResettableTimingFetch();
  return {
    fetch: timingFetch.fetch,
    resetIdleConnections: overrides?.resetIdleConnections ?? (overrides?.client ? undefined : timingFetch.resetIdleConnections),
  };
}

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
 *  Anthropic-only by design: this exists for the Opus TTFB dead-zone investigation.
 *  The other adapters still wrap their fetch with `createResettableTimingFetch` (so
 *  connect/header times are stamped), but only Anthropic folds them into a timing
 *  fact. Thread this through another provider only when that provider needs the same
 *  dead-zone breakdown. */
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

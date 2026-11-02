import { DebugLog } from "../../../../infra/debug-log.js";
import { LlmStreamError } from "../../../agent-runtime/llm/errors.js";
import type { ProviderTransportHiddenRequest } from "../../../session/provider-request-audit-types.js";
import { CLAUDE_AGENT_SDK_LABEL } from "../names.js";
import { serviceRequests, wireFailure, type WireFailure } from "../service-requests.js";
import { silentDebugOutputFailure, type DebugLine, type EngineDrift, type SilentVersions } from "../stderr-signals.js";

/** How long a hosted agent's failed step waits for the record of its request to complete. stderr and the gate's
 *  socket are separate pipes, so the record can complete moments after the step ended. */
const RECORD_BOUND_MS = 10_000;

const endedWithoutResponse = () => new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} agent host's request ended without a response`, "transient");

/** The engine versions whose hosted SSE error was recorded as unattributed, so each version records it once. */
const unattributedStreamErrors = new Set<string>();

/** One hosted agent's requests: the admitted steps that no record took yet, and the state of its admitted record. */
interface AgentRequests {
  allowance: number;
  /** The log id of the record that the agent's newest admitted step opened, until that record completes. */
  record: string | undefined;
  /** The outcome of that record. */
  outcome: { readonly kind: "sent" } | { readonly kind: "succeeded" } | { readonly kind: "failed"; readonly error: Error } | undefined;
  readonly waiters: ((error: Error) => void)[];
  /** The requests that the agent sent without an admitted step, for its next transport record. */
  hidden: ProviderTransportHiddenRequest[];
  /** The agent's task ended (`retire`). */
  ended: boolean;
  /** The transport of the agent's newest step was consumed (`released`): its stream ended or its consumer left it, so
   *  no consumer reads this state again for that step. */
  released: boolean;
}

/** One request of the dispatcher in one frame, by its record. */
interface DispatcherRequest {
  readonly logId: string;
  status: number | undefined;
  /** The service's answer when the request failed. */
  wire: WireFailure | undefined;
  /** The record awaits no more evidence. */
  complete: boolean;
}

/** The dispatcher's requests of one frame, in the order that the engine sent them. A request that the engine's main
 *  loop sent while no frame was open has a frame of its own, which is ended from the start. */
interface FrameRequests {
  readonly nonce: string;
  readonly requests: DispatcherRequest[];
  /** The input tokens of each complete dispatcher response, in order (`dispatcherUsage`). */
  readonly usage: number[];
  /** The frame's request whose model response streams now: the service answered it with a success, and the
   *  dispatcher asked for no later step and ended no turn since. */
  streaming: DispatcherRequest | undefined;
  /** The wait of the frame's failure for its first failed record (`frameFailure`): `changed` hears each change of the
   *  frame's records, and `end` ends the wait at once. */
  waiter: { readonly changed: () => void; readonly end: () => void } | undefined;
}

export interface HostedRequestsConfig {
  readonly sessionId: string;
  readonly silentVersions: SilentVersions;
  /** The engine's version, once its init message stated it. */
  readonly cliVersion: () => string | undefined;
  /** A dispatcher response ended complete, so its usage report is owed (`UsageReports.served`): the dispatcher asked
   *  for the frame's next step (`dispatcherAsked`), or the frame's turn ended with its success. The debug output states
   *  no end of a stream. Returns at once. */
  readonly dispatcherServed: () => void;
  readonly recordBoundMs?: number;
}

/**
 * The service requests of one agent host's engine, by owner (bridge rule 4; ARCH-CONTEXT-008): the one authority for
 * which requests the engine sent, how many, and how each ended. The engine's debug output opens a record for each
 * request (`serviceRequests`). A record of a hosted agent binds to that agent's admitted step: the agent's first
 * record after an admission is the admitted request, and its failure is the step's failure. A 404 that the engine
 * sends again without streaming keeps the first answer, and the resend, like every record without an admission, is
 * one hidden request of that agent. A record of the engine's main loop binds to the dispatcher frame that is open when
 * it opens; each is one hidden request of the frame, and the first that failed is the frame's failure. SDK output adds
 * only usage evidence (`dispatcherUsage`).
 *
 * A record retires by one explicit transition: an agent's records when its task ended and the transport of its last
 * step was consumed, also when a person cancelled the step before its response headers came; a frame's records when
 * the frame ended and a transport record took its requests (`takeHidden`), so evidence that comes after the frame's
 * end still reaches that record.
 */
export interface HostedRequests {
  read(line: DebugLine): void;
  /** The gate admitted a step of `agentId`, which sends one request. */
  admitted(agentId: string): void;
  /**
   * The failure of the agent's step that ended without its stop. It is the service's answer of the step's complete
   * record. A record whose response began and that then ended without its stop met an SSE error, which the engine
   * reports without a key (CLI 2.1.306), so that step fails as a transient cut, as it did before. A record that still
   * awaits its body when the bound ends fails with its status and headers. A record that does not complete in time, or
   * a step that no record took, means that the engine's debug output is not the format that this reads: the engine's
   * version then serves nothing more (`silentDebugOutputFailure`).
   */
  failure(agentId: string): Promise<Error>;
  /** The hidden requests for the agent's next transport record: the requests of every ended frame that no record took
   *  yet, which the next record of any agent takes, and the agent's own requests without an admitted step. */
  takeHidden(agentId: string): readonly ProviderTransportHiddenRequest[];
  /** The transport of the agent's current step was consumed. With its task's end, the agent's records retire. */
  released(agentId: string): void;
  /** The agent's task ended. With its last step's consumed transport, the agent's records retire. */
  retire(agentId: string): void;
  /** The dispatch frame of `nonce` opened: the main loop's requests from now on are that frame's. */
  frameOpened(nonce: string): void;
  /** The dispatcher asks for the next step of the frame of `nonce`. The engine asks only after the frame's last
   *  response ended, so a response that streamed ended complete. */
  dispatcherAsked(nonce: string): void;
  /** A complete dispatcher response of the open frame stated `inputTokens`. */
  dispatcherUsage(nonce: string, inputTokens: number): void;
  /** The frame of `nonce` ended with its turn's success: its requests wait for the next transport record, and the
   *  response that streamed last ended complete. */
  frameEnded(nonce: string): void;
  /** The frame of `nonce` ended with its turn's error. Resolves, as its requests then wait for the next transport
   *  record, with the service's answer to its first failed request: at once when a failed record is complete or no
   *  record awaits more evidence, else when the bound ends, with the status and headers of a record that still awaits
   *  its body. Undefined when no request of the frame failed at the service. */
  frameFailure(nonce: string): Promise<WireFailure | undefined>;
  /** Fails the engine's version as one whose debug output Flywheel cannot read (`silentDebugOutputFailure`). */
  drifted(rule: EngineDrift): Error;
  /** Ends every wait with `error`, and every frame, whose response that streamed was cut. Returns how many requests
   *  no transport record took. */
  close(error: Error): number;
}

export function hostedRequests(config: HostedRequestsConfig): HostedRequests {
  const { sessionId } = config;
  const boundMs = config.recordBoundMs ?? RECORD_BOUND_MS;
  const requests = serviceRequests(sessionId);
  const agents = new Map<string, AgentRequests>();
  /** The frames that have not ended, by nonce. */
  const frames = new Map<string, FrameRequests>();
  /** The frames that ended and whose requests no transport record took yet. */
  const ended: FrameRequests[] = [];
  /** The dispatcher's request of each record of a frame that no transport record took yet, with its frame. */
  const dispatcher = new Map<string, { readonly frame: FrameRequests; readonly request: DispatcherRequest }>();
  let openFrame: FrameRequests | undefined;
  /** The hidden requests of agents whose records retired, which the next transport record of any agent takes. */
  const leftover: ProviderTransportHiddenRequest[] = [];
  /** The drift that this engine's output showed, which fails every later step that has no answer. */
  let drift: EngineDrift | undefined;

  const agentOf = (agentId: string): AgentRequests => {
    let state = agents.get(agentId);
    if (state === undefined) {
      state = { allowance: 0, record: undefined, outcome: undefined, waiters: [], hidden: [], ended: false, released: false };
      agents.set(agentId, state);
    }
    return state;
  };

  const settle = (state: AgentRequests, error: Error) => {
    for (const waiter of state.waiters.splice(0)) waiter(error);
  };

  const drifted = (rule: EngineDrift): Error => {
    drift ??= rule;
    const version = config.cliVersion() ?? "unknown";
    config.silentVersions.drifted(sessionId, version, rule);
    return silentDebugOutputFailure(version);
  };

  /** The failure of a step whose response began: the engine names no key of the SSE error that ended it. */
  const streamCut = (agentId: string): Error => {
    const version = config.cliVersion();
    if (version !== undefined && !unattributedStreamErrors.has(version)) {
      unattributedStreamErrors.add(version);
      DebugLog.record({ type: "provider.claude_sdk.host.stream_error.unattributed", payload: { sessionId, agentId, cliVersion: version } });
    }
    return endedWithoutResponse();
  };

  /** Retires the agent's records and state once its task ended and its last step's transport was consumed. Its
   *  hidden requests go to the dispatcher's, so the next record of any agent of the host still states them. */
  const retireIfDone = (agentId: string, state: AgentRequests) => {
    if (!state.ended || !state.released) return;
    requests.retire(agentId);
    agents.delete(agentId);
    leftover.push(...state.hidden.splice(0));
    // A wait that remains belongs to a consumer that left its step, so no one reads its answer, and it is no evidence
    // of a stream error.
    settle(state, endedWithoutResponse());
  };

  const frameOf = (nonce: string): FrameRequests => ({ nonce, requests: [], usage: [], streaming: undefined, waiter: undefined });

  const readDispatcher = (event: Exclude<ReturnType<typeof requests.read>, undefined | { readonly kind: "unjoinable" }>) => {
    const { logId } = event.request;
    if (event.kind === "opened") {
      const request: DispatcherRequest = { logId, status: undefined, wire: undefined, complete: false };
      // A request that no frame asked for joins no frame, so no frame waits for its answer; its record still takes
      // the evidence that the engine writes for it.
      const frame = openFrame ?? frameOf("");
      if (openFrame === undefined) ended.push(frame);
      frame.requests.push(request);
      dispatcher.set(logId, { frame, request });
      return;
    }
    const bound = dispatcher.get(logId);
    if (bound === undefined) return;
    const { frame, request } = bound;
    request.complete = true;
    if (event.kind === "succeeded") {
      request.status = event.status;
      if (frame === openFrame) frame.streaming = request;
    } else {
      request.status = event.wire.status;
      request.wire = event.wire;
      // An SSE error cut the stream, so its response did not end complete.
      if (frame.streaming === request) frame.streaming = undefined;
    }
    frame.waiter?.changed();
  };

  const read = (line: DebugLine) => {
    if (line.kind !== "request-sent" && line.kind !== "status-line" && line.kind !== "response" && line.kind !== "response-unread" && line.kind !== "api-error" && line.kind !== "stream-error") return;
    const event = requests.read(line);
    if (event === undefined) return;
    if (event.kind === "unjoinable") {
      const error = drifted("body-unjoined");
      for (const state of agents.values()) if (state.outcome?.kind === "sent") settle(state, error);
      return;
    }
    const { request } = event;
    if (!request.model) return;
    if (request.agent === undefined) {
      readDispatcher(event);
      return;
    }
    if (event.kind === "opened") {
      const state = agentOf(request.agent);
      if (state.allowance > 0) {
        state.allowance -= 1;
        state.record = request.logId;
        state.outcome = { kind: "sent" };
        return;
      }
      state.hidden.push({ source: "agent-host-agent" });
      DebugLog.record({ type: "provider.claude_sdk.request.hidden", payload: { sessionId, agentId: request.agent, tag: "unadmitted", phase: "hosted", announcedBy: "request-block" } });
      return;
    }
    // A record of a hidden request settles nothing: the admitted request's answer is the step's.
    const state = agents.get(request.agent);
    if (state === undefined || state.record !== request.logId) return;
    state.record = undefined;
    if (event.kind === "succeeded") {
      state.outcome = { kind: "succeeded" };
      // A step that already ended without its stop waits here when its response block came after the step's end.
      if (state.waiters.length > 0) settle(state, streamCut(request.agent));
      return;
    }
    const error = wireFailure(event.wire);
    state.outcome = { kind: "failed", error };
    settle(state, error);
  };

  /** Ends `frame`, once: no later request joins it, and its requests wait for the next transport record. A response
   *  that streamed then ended `complete`, or was cut. */
  const endFrame = (frame: FrameRequests, complete: boolean) => {
    if (!frames.delete(frame.nonce)) return;
    if (openFrame === frame) openFrame = undefined;
    frame.waiter?.end();
    if (complete && frame.streaming !== undefined) config.dispatcherServed();
    frame.streaming = undefined;
    ended.push(frame);
  };

  /** The hidden requests of every ended frame, each with its status and with the input tokens of the complete
   *  response that answered it, read from its record now. Each record then retires. */
  const takeFrames = (): ProviderTransportHiddenRequest[] => ended.splice(0).flatMap((frame) => {
    const usage = frame.usage.values();
    return frame.requests.map(({ logId, status, wire }) => {
      dispatcher.delete(logId);
      requests.forget(logId);
      const inputTokens = wire === undefined && status !== undefined && status < 300 ? usage.next().value : undefined;
      return { source: "agent-host-dispatcher" as const, ...(status === undefined ? {} : { status }), ...(inputTokens === undefined ? {} : { inputTokens }) };
    });
  });

  return {
    read,
    admitted(agentId) {
      const state = agentOf(agentId);
      state.allowance += 1;
      state.outcome = undefined;
      state.ended = false;
      state.released = false;
    },
    failure(agentId) {
      const state = agentOf(agentId);
      const { outcome } = state;
      if (outcome?.kind === "failed") return Promise.resolve(outcome.error);
      if (outcome?.kind === "succeeded") return Promise.resolve(streamCut(agentId));
      if (drift !== undefined) return Promise.resolve(drifted(drift));
      const waited = Promise.withResolvers<Error>();
      const timer = setTimeout(() => {
        state.waiters.splice(state.waiters.indexOf(waited.resolve), 1);
        const bodyless = state.record === undefined ? undefined : requests.withoutBody(state.record);
        if (bodyless !== undefined) {
          const error = wireFailure(bodyless);
          state.record = undefined;
          state.outcome = { kind: "failed", error };
          waited.resolve(error);
        } else waited.resolve(drifted(state.allowance > 0 ? "agent-header-missing" : "record-incomplete"));
      }, boundMs);
      state.waiters.push(waited.resolve);
      return waited.promise.finally(() => { clearTimeout(timer); });
    },
    takeHidden(agentId) {
      return [...takeFrames(), ...leftover.splice(0), ...agents.get(agentId)?.hidden.splice(0) ?? []];
    },
    released(agentId) {
      const state = agents.get(agentId);
      if (state === undefined) return;
      state.released = true;
      retireIfDone(agentId, state);
    },
    retire(agentId) {
      const state = agents.get(agentId);
      if (state === undefined) {
        requests.retire(agentId);
        return;
      }
      state.ended = true;
      retireIfDone(agentId, state);
    },
    frameOpened(nonce) {
      openFrame = frameOf(nonce);
      frames.set(nonce, openFrame);
    },
    dispatcherAsked(nonce) {
      const frame = frames.get(nonce);
      if (frame?.streaming === undefined) return;
      frame.streaming = undefined;
      config.dispatcherServed();
    },
    dispatcherUsage(nonce, inputTokens) {
      frames.get(nonce)?.usage.push(inputTokens);
    },
    frameEnded(nonce) {
      const frame = frames.get(nonce);
      if (frame !== undefined) endFrame(frame, true);
    },
    async frameFailure(nonce) {
      const frame = frames.get(nonce);
      if (frame === undefined) return undefined;
      if (openFrame === frame) openFrame = undefined;
      // The first failed request is the frame's failure, so a later request's answer never replaces it.
      const first = () => frame.requests.find((request) => request.wire !== undefined || !request.complete);
      if (first()?.complete === false) {
        const waited = Promise.withResolvers<void>();
        const end = () => {
          clearTimeout(timer);
          frame.waiter = undefined;
          waited.resolve();
        };
        const timer = setTimeout(end, boundMs);
        frame.waiter = { changed: () => { if (first()?.complete !== false) end(); }, end };
        await waited.promise;
      }
      const pending = first();
      if (pending !== undefined && !pending.complete) {
        const bodyless = requests.withoutBody(pending.logId);
        if (bodyless !== undefined) {
          pending.status = bodyless.status;
          pending.wire = bodyless;
          pending.complete = true;
        }
      }
      // The turn's error ends the frame, so a response that still streamed did not end complete.
      endFrame(frame, false);
      return frame.requests.find((request) => request.wire !== undefined)?.wire;
    },
    drifted,
    close(error) {
      for (const state of agents.values()) settle(state, error);
      for (const frame of frames.values()) endFrame(frame, false);
      return leftover.length + ended.reduce((count, frame) => count + frame.requests.length, 0);
    },
  };
}

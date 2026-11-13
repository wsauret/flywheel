import Anthropic from "@anthropic-ai/sdk";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import type { AnthropicOperations } from "../../agent-runtime/llm/anthropic.js";
import type { Claim, TransportContextFrame } from "../../agent-runtime/llm/types.js";
import type { BlockOrigins } from "../../agent-runtime/llm/conversions/anthropic-messages.js";
import { LlmStreamError } from "../../agent-runtime/llm/errors.js";
import type { BridgeRequest } from "./cli-view.js";
import { engineBlockLocation } from "./engine-additions.js";
import { CLAUDE_AGENT_SDK_LABEL } from "./names.js";

/** The window that one request's admission states, and the eligibility revision that the admission read it from
 *  (`AccessProviderCandidateAttribution.eligibilityRevision`), which tells whether the admission came before or after
 *  a refusal of the extended window that the bridge saw (`BridgeState.refusedWindow`). */
export interface AdmittedWindow {
  readonly contextLimit: number;
  readonly eligibilityRevision: number | undefined;
}

/** The window that a query started for a request of the admitted `window` asks for, after the bridge met `refused`
 *  (`BridgeState.refusedWindow`): at most the refused window, unless the admission's revision is later than the
 *  revision of the request that met the refusal. An admission without a revision cannot show that it is later. */
export function queryWindow(window: AdmittedWindow, refused: AdmittedWindow | undefined): number {
  if (refused === undefined) return window.contextLimit;
  const later = refused.eligibilityRevision !== undefined && window.eligibilityRevision !== undefined && window.eligibilityRevision > refused.eligibilityRevision;
  return later ? window.contextLimit : Math.min(window.contextLimit, refused.contextLimit);
}

export type AbortSource = "caller-signal" | "adapter-controller";
export type BridgeRequestInput =
  | { readonly kind: "request"; readonly id: number; readonly params: BridgeRequest; readonly origins: BlockOrigins; readonly window: AdmittedWindow; readonly signal: AbortSignal; readonly reply: Deferred.Deferred<AsyncIterable<Anthropic.RawMessageStreamEvent | TransportContextFrame>, Error> }
  | { readonly kind: "abort"; readonly request: number; readonly reason: unknown; readonly source: AbortSource }
  /** A request with `params` follows (`LLMClient.anticipate`). `reply` takes the claim on the engine that the bridge
   *  holds for it, if any. */
  | { readonly kind: "anticipate"; readonly params: BridgeRequest; readonly origins: BlockOrigins; readonly window: AdmittedWindow; readonly reply: Deferred.Deferred<Claim | undefined> };

export const bridgeClosedError = () => new LlmStreamError(`The ${CLAUDE_AGENT_SDK_LABEL} bridge closed`, "transient");

/** Admits adapter requests to the bridge actor, each with the window of the admission that the operations are bound
 * to (`AdmittedWindow`). A pending reply ends on caller abort or worker exit. The returned controller releases a
 * completed request or aborts one that still streams. */
export function createBridgeRequests(offer: (input: BridgeRequestInput) => boolean, running: Fiber.Fiber<void>): (window: AdmittedWindow) => AnthropicOperations {
  let requests = 0;
  return (window) => ({
    createStream: async (params, { signal, origins }) => {
      signal.throwIfAborted();
      const id = ++requests;
      const reply = Deferred.makeUnsafe<AsyncIterable<Anthropic.RawMessageStreamEvent | TransportContextFrame>, Error>();
      const controller = new AbortController();
      const request = AbortSignal.any([signal, controller.signal]);
      if (!offer({ kind: "request", id, params, origins, window, signal: request, reply })) throw bridgeClosedError();
      // The adapter aborts the controller after every request; after the request ended it is only a release. The one
      // abort of the request reaches the actor once, whichever signal ended it first.
      request.addEventListener("abort", () => {
        offer({ kind: "abort", request: id, reason: request.reason, source: signal.aborted ? "caller-signal" : "adapter-controller" });
      }, { once: true });
      const exit = await Effect.runPromiseExit(
        Effect.raceFirst(Deferred.await(reply), Fiber.await(running).pipe(Effect.flatMap(() => Effect.fail(bridgeClosedError())))),
        { signal },
      );
      signal.throwIfAborted();
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
      return { data: Object.assign(exit.value, { controller }), response: new Response(null) };
    },
    anticipate: async (params, { origins }) => {
      const reply = Deferred.makeUnsafe<Claim | undefined>();
      if (!offer({ kind: "anticipate", params, origins, window, reply })) return undefined;
      // A bridge that closes first started nothing that serves the request.
      return Effect.runPromise(Effect.raceFirst(Deferred.await(reply), Fiber.await(running).pipe(Effect.as<Claim | undefined>(undefined))));
    },
    isBadRequestError: (error) => error instanceof Anthropic.BadRequestError,
    preparedBlock: engineBlockLocation,
  });
}

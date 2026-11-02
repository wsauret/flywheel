import { Redacted } from "effect";
import { readBoundedJson } from "../../../infra/auth/bounded-json.js";
import { openRouterModelOutputCap, openRouterModelPricing } from "./model-support.js";
import type { ProviderAffordabilityCapability, ProviderAffordabilityDecision, ProviderAffordabilityEvaluation } from "../../agent-runtime/llm/provider-affordability.js";

const KEY_URL = "https://openrouter.ai/api/v1/key";
const CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_KEY_RESPONSE_BYTES = 64 * 1024;
const KEY_CAPTURE_DEADLINE_MS = 2_000;

interface Capture {
  readonly capturedAt: number;
  readonly remaining: number | undefined;
}

export interface OpenRouterAffordabilityOwner {
  readonly profileId: string;
  readonly credentialLineage: string;
  readonly apiKey: Redacted.Redacted<string>;
}

interface OpenRouterAffordabilityOptions {
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly deadlineMs?: number;
}

interface CaptureState {
  capture: Capture | undefined;
  pending: Promise<Capture> | undefined;
}

interface UnknownFields {
  readonly [key: string]: unknown;
}

function record(value: unknown): value is UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function remainingFrom(body: unknown): number | undefined {
  if (!record(body) || !record(body.data)) return undefined;
  const limit = finiteNonNegative(body.data.limit);
  const remaining = finiteNonNegative(body.data.limit_remaining);
  return limit === undefined || remaining === undefined ? undefined : remaining;
}

async function cancelResponseAfterAbort(fetchRequest: Promise<Response>, signal: AbortSignal): Promise<void> {
  try {
    const response = await fetchRequest;
    if (signal.aborted) await response.body?.cancel();
  } catch {
    // The request path owns transport failures and converts them to unknown evidence.
  }
}

/** Creates the lazy OpenRouter account capture and maximum-request admission owner. */
export function createOpenRouterAffordability(
  owner: OpenRouterAffordabilityOwner,
  options: OpenRouterAffordabilityOptions = {},
): ProviderAffordabilityCapability {
  const fetchKey = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? KEY_CAPTURE_DEADLINE_MS;
  const state: CaptureState = { capture: undefined, pending: undefined };

  async function capture(signal?: AbortSignal): Promise<Capture> {
    const current = state.capture;
    const capturedAt = now();
    if (current && capturedAt - current.capturedAt < CACHE_TTL_MS) return current;
    const active = state.pending;
    if (active) return active;
    const request = (async (): Promise<Capture> => {
      let remaining: number | undefined;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Error("OpenRouter balance capture timed out")), deadlineMs);
      const requestSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
      try {
        const fetchRequest = fetchKey(KEY_URL, {
          method: "GET",
          headers: { authorization: `Bearer ${Redacted.value(owner.apiKey)}` },
          signal: requestSignal,
        });
        void cancelResponseAfterAbort(fetchRequest, requestSignal);
        const aborted = new Promise<never>((_resolve, reject) => {
          requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
        });
        const response = await Promise.race([fetchRequest, aborted]);
        if (response.ok) remaining = remainingFrom(await readBoundedJson(response, MAX_KEY_RESPONSE_BYTES));
        else await response.body?.cancel().catch(() => {});
      } catch {
        remaining = undefined;
      } finally {
        clearTimeout(timer);
      }
      const result = Object.freeze({ capturedAt: now(), remaining });
      state.capture = result;
      return result;
    })();
    state.pending = request;
    try {
      return await request;
    } finally {
      if (state.pending === request) state.pending = undefined;
    }
  }

  return Object.freeze({
    async evaluate({ attribution, request, signal }: ProviderAffordabilityEvaluation): Promise<ProviderAffordabilityDecision> {
      if (attribution.catalogProvenance !== "live") return { kind: "eligible" };
      const pricing = openRouterModelPricing(attribution.catalogMetadata);
      const outputLimit = openRouterModelOutputCap(attribution.catalogMetadata);
      const promptTokens = request.tokenClasses.estimatedPromptTokens;
      if (!pricing || outputLimit === undefined || promptTokens === undefined || !Number.isFinite(promptTokens) || promptTokens < 0
        || request.attempt.outputLimit !== outputLimit) return { kind: "eligible" };
      const balance = await capture(signal);
      if (balance.remaining === undefined) return { kind: "eligible" };
      const maximum = promptTokens * pricing.prompt + (request.outputTokenLimit ?? outputLimit) * pricing.completion;
      return maximum > balance.remaining
        ? { kind: "unaffordable", detail: `OpenRouter needs up to $${maximum} but $${balance.remaining} remain.` }
        : { kind: "eligible" };
    },
  });
}

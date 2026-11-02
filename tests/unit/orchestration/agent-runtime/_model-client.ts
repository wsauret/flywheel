import {
  type AdmittedModelRequest,
  FUNCTION_TOOL_PRESENTATION,
  type LLMClient,
  type ModelClient,
  type ServingAttempt,
  type StreamOptions,
} from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { modelFamilyApi } from "../../../../src/orchestration/agent-runtime/llm/messages.js";

/** The history target of a fake client that stamps its turns with its attempt's own identity. */
export function attemptHistoryTarget(attempt: Pick<ServingAttempt, "accessProvider" | "modelFamily" | "model">): ReturnType<LLMClient["historyTarget"]> {
  return { accessProvider: attempt.accessProvider, provider: attempt.modelFamily, api: modelFamilyApi(attempt.modelFamily), model: attempt.model, sharedHost: false };
}

/** One-candidate chain over a fake adapter: the runtime holds a ModelClient,
 *  and the adapter under test is the single provider that serves every
 *  request, so each request prepares itself against that one attempt. */
export function withRequestAdmission(client: Omit<ModelClient, "admitRequest"> & Pick<LLMClient, "streamWithTools"> & Partial<Pick<LLMClient, "historyTarget">>): ModelClient {
  const modelClient: ModelClient = {
    model: client.model,
    modelFamily: client.modelFamily,
    plannedAttempt: client.plannedAttempt,
    async admitRequest() {
      const candidate = async ({ prepare, providerOptions }: Parameters<AdmittedModelRequest["prepare"]>[0]) => {
        const attempt = await modelClient.plannedAttempt(providerOptions);
        const prepared = await prepare(attempt);
        return {
          attempt: prepared.attempt,
          client: { ...prepared.attempt, streamWithTools: client.streamWithTools, historyTarget: client.historyTarget ?? (() => attemptHistoryTarget(prepared.attempt)) },
          prepared,
        };
      };
      return {
        candidateAttributions: [],
        prepare: candidate,
        run: async (request) => {
          const result = await request.execute(await candidate(request));
          if (result.kind === "provider_failure") {
            throw result.failure;
          }
          return result.value;
        },
        plannedAttempt: (providerOptions) => modelClient.plannedAttempt(providerOptions),
      };
    },
  };
  return modelClient;
}

export function asModelClient(
  client: Omit<LLMClient, "toolPresentation" | "historyTarget"> & Partial<Pick<LLMClient, "toolPresentation" | "historyTarget">>,
): ModelClient {
  const attempt: ServingAttempt = { ...client, toolPresentation: client.toolPresentation ?? FUNCTION_TOOL_PRESENTATION };
  return withRequestAdmission({
    model: client.model,
    modelFamily: client.modelFamily,
    plannedAttempt: async () => attempt,
    streamWithTools: (options: StreamOptions) => client.streamWithTools(options),
    ...(client.historyTarget === undefined ? {} : { historyTarget: client.historyTarget }),
  });
}

/** The `historyTarget` of a fake client that stamps its turns with its own identity. A method, so that the
 *  client object that holds it reads that client's own identity. */
const ownIdentity = {
  historyTarget(this: Pick<ServingAttempt, "accessProvider" | "modelFamily" | "model">): ReturnType<LLMClient["historyTarget"]> {
    return attemptHistoryTarget(this);
  },
};
export const ownHistoryTarget = ownIdentity.historyTarget;

/** A serving attempt with fixed limits and no price, for a fake client of `accessProvider` and `model`. A client that
 *  spreads it lowers history for its own identity. */
export function fakeAttempt(accessProvider: ServingAttempt["accessProvider"], model: string): ServingAttempt & Pick<LLMClient, "historyTarget"> {
  return {
    historyTarget: () => attemptHistoryTarget({ accessProvider, modelFamily: accessProvider === "anthropic_api" ? "anthropic" : "openai", model }),
    accessProvider,
    modelFamily: accessProvider === "anthropic_api" ? "anthropic" : "openai",
    model,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  }
}

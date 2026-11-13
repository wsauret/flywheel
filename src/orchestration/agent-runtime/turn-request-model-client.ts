import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import type { AdmittedModelRequest, AdmittedModelRequestRun, ModelClient, ModelRequestCapture } from "./llm/types.js";
import type { TurnUsageTracker } from "./turn-usage-tracker.js";

/** Decorates one turn's model client so each admitted request reads shared retry state and every wire attempt starts a separate usage-accounting scope. */
export function withTurnRequestScope(client: ModelClient, usageTracker: TurnUsageTracker): ModelClient {
  const admitRequest = async (capture?: ModelRequestCapture): Promise<AdmittedModelRequest> => {
    const admitted = await client.admitRequest(capture);
    return Object.freeze({
      candidateAttributions: admitted.candidateAttributions,
      run: <T>(request: AdmittedModelRequestRun<T>): Promise<T> => admitted.run<T>({
        ...request,
        execute: (candidate) => {
          usageTracker.beginAttempt();
          return request.execute(candidate);
        },
      }),
      prepare: admitted.prepare,
      plannedAttempt: admitted.plannedAttempt,
    });
  };
  return {
    model: client.model,
    modelFamily: client.modelFamily,
    admitRequest,
    plannedAttempt: async (providerOptions?: ProviderRequestOptions, capture?: ModelRequestCapture) => (await admitRequest(capture)).plannedAttempt(providerOptions),
  };
}

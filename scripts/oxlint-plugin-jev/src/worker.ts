import { APICallError, experimental_decide, InvalidResponseDataError, RetryError } from 'ai';
import { runAsWorker } from 'synckit';
import { backendFromWire } from './backend.ts';
import { decisionModelFor, decisionProviderOptions, type DecisionModel } from './decision-model.ts';
import { messageOf } from './jev.ts';
import type { AskInput, AskResult, Backend, DecisionRequest } from './types.ts';

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

// The AI SDK wraps exhausted retries in a RetryError; the last attempt names the real cause.
function reasonFor(error: unknown, lastAttemptError: unknown): string {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (isAbort(cause)) {
    // A deadline that expires between retries is reported as the error being retried.
    return lastAttemptError === undefined || isAbort(lastAttemptError)
      ? 'timeout'
      : reasonFor(lastAttemptError, undefined);
  }
  if (APICallError.isInstance(cause)) {
    return cause.statusCode === undefined
      ? `network: ${cause.message}`
      : `http ${cause.statusCode}: ${cause.message}`;
  }
  return `${cause instanceof Error ? cause.name : 'error'}: ${messageOf(cause)}`;
}

interface Attempts {
  lastError?: unknown;
}

async function decide(
  backend: Backend,
  request: DecisionRequest,
  abortSignal: AbortSignal,
  attempts: Attempts,
): Promise<AskResult> {
  const inner = decisionModelFor(backend);
  let last: Awaited<ReturnType<DecisionModel['doDecide']>> | undefined;
  // The AI SDK rejects a whole response when one answer is malformed. Keeping the raw result lets
  // the plugin use the valid verdicts and ask again only for the malformed location answers.
  const model: DecisionModel = {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedQuestionTypes: inner.supportedQuestionTypes,
    doDecide: async (options) => {
      try {
        last = await inner.doDecide(options);
        attempts.lastError = undefined;
        return last;
      } catch (error) {
        attempts.lastError = error;
        throw error;
      }
    },
  };
  try {
    const result = await experimental_decide({
      model,
      state: request.state,
      questions: request.questions,
      abortSignal,
      providerOptions: decisionProviderOptions(backend),
    });
    return { ok: true, model: result.response.modelId, answers: result.answers };
  } catch (error) {
    if (!InvalidResponseDataError.isInstance(error) || last === undefined) throw error;
    return { ok: true, model: last.response?.modelId ?? inner.modelId, answers: last.answers };
  }
}

runAsWorker(async ({ backend, request, timeoutMs }: AskInput): Promise<AskResult> => {
  const attempts: Attempts = {};
  try {
    return await decide(backendFromWire(backend), request, AbortSignal.timeout(timeoutMs), attempts);
  } catch (error) {
    return { ok: false, reason: reasonFor(error, attempts.lastError) };
  }
});

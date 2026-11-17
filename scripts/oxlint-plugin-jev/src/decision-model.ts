import { createOpenAI } from '@ai-sdk/openai';
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import { Redacted } from 'effect';
import type { Backend } from './types.ts';

export type DecisionModel = ReturnType<ReturnType<typeof createTypeSafeAi>['decisionModel']>;

/** The AI SDK decision model that answers for a backend. */
export function decisionModelFor(backend: Backend): DecisionModel {
  const { baseURL, model } = backend;
  const apiKey = Redacted.value(backend.apiKey);
  return backend.kind === 'typesafe'
    ? createTypeSafeAi({ apiKey, baseURL }).decisionModel(model)
    : createOpenAI({ apiKey, baseURL }).decisionModel(model);
}

/** TypeSafe's long-context header, when the backend asks for it. */
export const decisionProviderOptions = (backend: Backend) =>
  backend.kind === 'typesafe' && backend.longContext
    ? { typesafe: { longContext: true } }
    : undefined;

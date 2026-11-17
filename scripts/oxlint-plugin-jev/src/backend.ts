import { Redacted } from 'effect';
import type { Backend, ResolvedOptions, WireBackend } from './types.ts';

const DEFAULT_TYPESAFE_URL = 'https://api.typesafe.ai/v1';
const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';

/** The OpenAI Decisions model used when only `OPENAI_API_KEY` is set. */
export const DEFAULT_OPENAI_MODEL = 'gpt-6-luna';

/** Selects the decision backend as `<provider>:<model>`, such as `typesafe:jev-latest` or `openai:gpt-6-luna`. */
export const DECISION_MODEL_ENV = 'ANTI_SLOP_DECISION_MODEL';

interface Env {
  readonly [name: string]: string | undefined;
}

const read = (env: Env, name: string): string => (env[name] ?? '').trim();

// `TYPESAFE_BASE_URL` comes from `@typesafe-ai/sdk` and names the host; the AI SDK provider's
// `TYPESAFE_AI_BASE_URL` already includes the `/v1` API prefix.
function typeSafeBaseURL(env: Env): string {
  const host = read(env, 'TYPESAFE_BASE_URL').replace(/\/+$/, '');
  if (host !== '') return `${host}/v1`;
  return read(env, 'TYPESAFE_AI_BASE_URL').replace(/\/+$/, '') || DEFAULT_TYPESAFE_URL;
}

/** Named in the warning when no decision credential of any kind is set. */
export const NO_DECISION_CREDENTIALS =
  'no decision model credentials: TYPESAFE_API_KEY and OPENAI_API_KEY are both unset';

export type BackendResult =
  | { ok: true; backend: Backend; id: string }
  | { ok: false; reason: string };

export interface DecisionDefaults {
  /** The TypeSafe model used when `ANTI_SLOP_DECISION_MODEL` is unset. */
  readonly typesafeModel: string;
  /** Send TypeSafe's long-context header. */
  readonly longContext: boolean;
}

type Provider = Backend['kind'];

const isProvider = (value: string): value is Provider => value === 'typesafe' || value === 'openai';

function selection(env: Env, typesafeModel: string): { provider: Provider; model: string } | null {
  const setting = read(env, DECISION_MODEL_ENV);
  if (setting !== '') {
    const colon = setting.indexOf(':');
    const provider = setting.slice(0, colon);
    const model = setting.slice(colon + 1);
    if (colon === -1 || model === '' || !isProvider(provider)) {
      throw new Error(
        `${DECISION_MODEL_ENV} must be typesafe:<model> or openai:<model>, not "${setting}"`,
      );
    }
    return { provider, model };
  }
  if (read(env, 'TYPESAFE_API_KEY') !== '') return { provider: 'typesafe', model: typesafeModel };
  if (read(env, 'OPENAI_API_KEY') !== '') return { provider: 'openai', model: DEFAULT_OPENAI_MODEL };
  return null;
}

/**
 * Picks the decision backend from the environment. `ANTI_SLOP_DECISION_MODEL` names it; without
 * it, TypeSafe answers when `TYPESAFE_API_KEY` is set, else OpenAI Decisions when
 * `OPENAI_API_KEY` is set. A missing credential is a result that names it; a malformed setting
 * throws, because no run can succeed until it is corrected.
 */
export function chooseDecisionBackend(env: Env, defaults: DecisionDefaults): BackendResult {
  const selected = selection(env, defaults.typesafeModel);
  if (selected === null) return { ok: false, reason: NO_DECISION_CREDENTIALS };
  const { provider, model } = selected;
  const typesafeKey = read(env, 'TYPESAFE_API_KEY');
  const openaiKey = read(env, 'OPENAI_API_KEY');
  if (provider === 'openai') {
    if (openaiKey === '') {
      return { ok: false, reason: `${DECISION_MODEL_ENV} selects openai, but OPENAI_API_KEY is not set` };
    }
    const baseURL = read(env, 'OPENAI_BASE_URL').replace(/\/+$/, '') || DEFAULT_OPENAI_URL;
    return {
      ok: true,
      backend: { kind: 'openai', model, apiKey: Redacted.make(openaiKey), baseURL },
      id: `openai ${baseURL} ${model}`,
    };
  }
  if (typesafeKey === '') {
    return { ok: false, reason: `${DECISION_MODEL_ENV} selects typesafe, but TYPESAFE_API_KEY is not set` };
  }
  const baseURL = typeSafeBaseURL(env);
  return {
    ok: true,
    backend: {
      kind: 'typesafe',
      model,
      apiKey: Redacted.make(typesafeKey),
      baseURL,
      longContext: defaults.longContext,
    },
    id: `typesafe ${baseURL} ${model}`,
  };
}

/**
 * The one serialization point of the API key: the synckit worker receives its input through a
 * structured clone, which drops what a `Redacted` holds. `backendFromWire` wraps it again.
 */
export const backendToWire = (backend: Backend): WireBackend => ({
  ...backend,
  apiKey: Redacted.value(backend.apiKey),
});

export const backendFromWire = (backend: WireBackend): Backend => ({
  ...backend,
  apiKey: Redacted.make(backend.apiKey),
});

/** Picks the backend for a rule list, or says which credential is missing. */
export function backendFor(options: ResolvedOptions): BackendResult {
  return chooseDecisionBackend(process.env, {
    typesafeModel: options.model,
    longContext: options.longContext,
  });
}

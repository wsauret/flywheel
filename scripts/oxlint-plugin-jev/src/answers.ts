import { readCache, writeCache } from './cache.ts';
import { buildRequest, isValidAnswer, messageOf, type Ask } from './jev.ts';
import { askModel } from './sync-jev.ts';
import type { Answered, Backend } from './types.ts';

export type AnswersResult =
  | { ok: true; answers: Map<string, Answered> }
  | { ok: false; reason: string };

export interface AnswerInput {
  readonly asks: readonly Ask[];
  readonly backend: Backend;
  /** `Date.now()` time by which every request of the operation must have answered. */
  readonly deadline: number;
  readonly cacheDir: string;
  readonly onCacheError?: (message: string) => void;
}

// The decision models accept 64k tokens per request. Token-dense source, such as hex literals,
// runs at about 1.7 characters per token, so 100,000 serialized characters stay under the limit.
const MAX_REQUEST_CHARS = 100_000;

const serializedChars = (value: unknown): number => JSON.stringify(value).length;

const EMPTY_REQUEST_CHARS = serializedChars(buildRequest([]).request);

// Refs and ids are sized for a request of up to 10,000 snippets and questions.
const questionChars = (ask: Ask): number => serializedChars({ q0000: ask.question('s0000') });
const snippetChars = (ask: Ask): number => serializedChars({ s0000: ask.snippet });

/** Splits asks into requests whose serialized size, questions and criteria included, stays under the limit. */
function requestBatches(asks: readonly Ask[]): Ask[][] {
  const batches: Ask[][] = [];
  let batch: Ask[] = [];
  let snippets = new Set<string>();
  let chars = EMPTY_REQUEST_CHARS;
  for (const ask of asks) {
    const question = questionChars(ask);
    const snippet = snippets.has(ask.snippet) ? 0 : snippetChars(ask);
    if (batch.length > 0 && chars + question + snippet > MAX_REQUEST_CHARS) {
      batches.push(batch);
      batch = [];
      snippets = new Set();
      chars = EMPTY_REQUEST_CHARS;
    }
    if (!snippets.has(ask.snippet)) {
      snippets.add(ask.snippet);
      chars += snippetChars(ask);
    }
    chars += question;
    batch.push(ask);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Answers every ask, from the cache where it can and with as few requests as the size limit
 * allows for the rest. Every request shares the one deadline, so a split answer takes no longer
 * than an unsplit one. A missing or invalid verdict fails the batch; an invalid location is
 * returned but never cached, so it is asked again on the next run.
 */
export function answerAll({
  asks,
  backend,
  deadline,
  cacheDir,
  onCacheError,
}: AnswerInput): AnswersResult {
  const answers = new Map<string, Answered>();
  const misses = new Map<string, Ask>();
  for (const ask of asks) {
    if (answers.has(ask.key) || misses.has(ask.key)) continue;
    const cached = readCache(cacheDir, ask.key);
    if (cached !== null && isValidAnswer(ask, cached.answer)) answers.set(ask.key, cached);
    else misses.set(ask.key, ask);
  }
  if (misses.size === 0) return { ok: true, answers };

  let missingVerdict: string | null = null;
  for (const pending of requestBatches([...misses.values()])) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: 'timeout' };
    const { request, asked } = buildRequest(pending);
    const result = askModel(backend, request, remaining);
    if (!result.ok) return result;
    for (const { ask, id } of asked) {
      const answer = result.answers[id];
      const entry = { model: result.model, answer };
      if (!isValidAnswer(ask, answer)) {
        if (ask.kind === 'verdict') missingVerdict ??= id;
        else answers.set(ask.key, entry);
        continue;
      }
      answers.set(ask.key, entry);
      try {
        writeCache(cacheDir, ask.key, entry);
      } catch (error) {
        onCacheError?.(`could not write cache in ${cacheDir}: ${messageOf(error)}`);
      }
    }
  }
  if (missingVerdict !== null) {
    return { ok: false, reason: `response has no probability in [0, 1] for "${missingVerdict}"` };
  }
  return { ok: true, answers };
}

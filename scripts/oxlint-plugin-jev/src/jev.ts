// oxlint-disable anti-slop/no-known-value-widening, flywheel/no-record, typescript/consistent-indexed-object-style, typescript/consistent-type-assertions -- vendored upstream source keeps its own style; see UPSTREAM.md
import { createHash } from 'node:crypto';
import type { Location } from '@oxlint/plugins';
import type { ChoiceQuestion, DecisionRequest, JevRule, Question, RequestMatch } from './types.ts';

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function truncateSnippet(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}/* ...truncated */`;
}

const sourceLines = (text: string): string[] => text.split(/\r\n|[\n\r\u2028\u2029]/);

type LocatedMatch = RequestMatch & {
  rule: { question: string; location: NonNullable<JevRule['location']> };
};

// A truncated snippet has incomplete lines and a synthetic marker, so it cannot be located.
export function locates(match: RequestMatch): match is LocatedMatch {
  return Boolean(match.rule.location) && !match.truncated;
}

export interface LineRange {
  start: number;
  end: number;
}

export function locationCandidates(snippet: string, within?: LineRange): Record<string, LineRange> {
  const lines = sourceLines(snippet)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(
      ({ text, line }) => text.trim() && (!within || (line >= within.start && line <= within.end)),
    );
  const candidates: Record<string, LineRange> = {};
  // Reserve one of Choice's 255 options for an uncertain or inapplicable location.
  const width = Math.max(1, Math.ceil(lines.length / 254));
  for (let offset = 0; offset < lines.length; offset += width) {
    // SAFETY: the loop keeps offset below lines.length, and the end index is clamped to it.
    const start = lines[offset]!.line;
    const end = lines[Math.min(offset + width - 1, lines.length - 1)]!.line;
    candidates[start === end ? `L${start}` : `L${start}-L${end}`] = { start, end };
  }
  return candidates;
}

/** The snippet text as the model reads it: numbered when a location question refers to lines. */
export function sentSnippet(match: RequestMatch): string {
  if (!locates(match)) return match.snippet;
  return sourceLines(match.snippet)
    .map((text, index) => `L${index + 1}| ${text}`)
    .join('\n');
}

/** One question about one snippet, cached on its own. `ref` names the snippet in the request. */
export interface Ask {
  readonly key: string;
  readonly kind: 'verdict' | 'location';
  readonly snippet: string;
  readonly criteria?: ChoiceQuestion['criteria'];
  question(ref: string): Question;
}

const hash = (payload: unknown): string =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

// The key holds only what the answer depends on: the backend and model that answer, the question
// text, and the snippet as sent. Ids, cutoffs, messages, and severities are left out on purpose.
export function verdictAsk(backend: string, match: RequestMatch): Ask {
  const snippet = sentSnippet(match);
  const { question } = match.rule;
  return {
    key: hash({ v: 4, backend, kind: 'verdict', question, snippet }),
    kind: 'verdict',
    snippet,
    question: (ref) => ({
      type: 'boolean',
      instructions: `Consider only snippet "${ref}" in state.snippets. ${question}`,
    }),
  };
}

export function locationAsk(backend: string, match: LocatedMatch, within?: LineRange): Ask {
  const snippet = sentSnippet(match);
  const { question, location } = match.rule;
  const criteria: ChoiceQuestion['criteria'] = {
    ...Object.fromEntries(
      Object.keys(locationCandidates(match.snippet, within)).map((key) => [key, null]),
    ),
    unknown: 'No clear source location for this violation',
  };
  return {
    key: hash({
      v: 4,
      backend,
      kind: 'location',
      question,
      location: location.question,
      snippet,
      within: within ?? null,
    }),
    kind: 'location',
    snippet,
    criteria,
    question: (ref) => ({
      type: 'choice',
      instructions: `Consider only the numbered source in state.snippets.${ref}. If it violates this rule, select the line (or range containing that line) to annotate. Rule: ${question} Location: ${location.question} If multiple violations exist, select the earliest one. Select unknown if no violation exists or its location is unclear.`,
      criteria,
    }),
  };
}

/** One request for many asks. Identical snippets are sent once and identical asks asked once. */
export function buildRequest(asks: readonly Ask[]): {
  request: DecisionRequest;
  asked: { ask: Ask; id: string }[];
} {
  const snippets: Record<string, string> = {};
  const refBySnippet = new Map<string, string>();
  const questions: DecisionRequest['questions'] = {};
  const idByKey = new Map<string, string>();
  const asked = asks.map((ask) => {
    const existing = idByKey.get(ask.key);
    if (existing !== undefined) return { ask, id: existing };
    let ref = refBySnippet.get(ask.snippet);
    if (ref === undefined) {
      ref = `s${refBySnippet.size}`;
      refBySnippet.set(ask.snippet, ref);
      snippets[ref] = ask.snippet;
    }
    const id = `q${idByKey.size}`;
    idByKey.set(ask.key, id);
    questions[id] = ask.question(ref);
    return { ask, id };
  });
  return { request: { state: { snippets }, questions }, asked };
}

export function probabilityOf(answer: unknown): number | null {
  if (typeof answer !== 'object' || answer === null) return null;
  if (!('type' in answer) || answer.type !== 'boolean' || !('probability' in answer)) return null;
  const { probability } = answer;
  return typeof probability === 'number' && probability >= 0 && probability <= 1
    ? probability
    : null;
}

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
}

export function isChoiceAnswer(
  answer: unknown,
  criteria: Record<string, unknown>,
): answer is ChoiceAnswer {
  if (
    typeof answer !== 'object' ||
    answer === null ||
    !('type' in answer) ||
    answer.type !== 'choice'
  )
    return false;
  if (
    !('choice' in answer) ||
    typeof answer.choice !== 'string' ||
    !Object.hasOwn(criteria, answer.choice)
  )
    return false;
  if (
    !('probabilities' in answer) ||
    typeof answer.probabilities !== 'object' ||
    answer.probabilities === null
  )
    return false;
  const probability = (answer.probabilities as Record<string, unknown>)[answer.choice];
  return typeof probability === 'number' && probability >= 0 && probability <= 1;
}

/** Whether an answer can be cached: a verdict needs a probability, a location a valid choice. */
export function isValidAnswer(ask: Ask, answer: unknown): boolean {
  return ask.kind === 'verdict'
    ? probabilityOf(answer) !== null
    : isChoiceAnswer(answer, ask.criteria ?? {});
}

export function selectedLocation(
  answer: unknown,
  candidates: Record<string, LineRange>,
  cutoff: number,
): LineRange | null {
  if (
    !isChoiceAnswer(answer, { ...candidates, unknown: null }) ||
    !Object.hasOwn(candidates, answer.choice)
  )
    return null;
  // SAFETY: isChoiceAnswer proved a probability for the choice, and Object.hasOwn proved the
  // candidate.
  return answer.probabilities[answer.choice]! >= cutoff ? candidates[answer.choice]! : null;
}

export function locationOfLine(snippet: string, line: number): Location {
  // SAFETY: line comes from locationCandidates over the same snippet, so it names one of its lines.
  const text = sourceLines(snippet)[line - 1]!;
  return {
    start: { line, column: text.search(/\S/) },
    end: { line, column: text.trimEnd().length },
  };
}

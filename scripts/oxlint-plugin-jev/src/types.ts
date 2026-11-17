// oxlint-disable flywheel/no-record, typescript/consistent-indexed-object-style -- vendored upstream source keeps its own style; see UPSTREAM.md
import type { Location, Range } from '@oxlint/plugins';
import type { Redacted } from 'effect';

export type Target = 'function' | 'call' | 'jsx' | 'file';

export type CiBehavior = 'skip' | 'fail';

export interface JevRule {
  /** Unique within the rule list. Shown in the lint message. */
  id: string;
  target: Target;
  /** One English yes/no question. "Yes" means "report an error". */
  question: string;
  /** Report when the yes-probability is >= this. Between 0 and 1. */
  cutoff: number;
  /** File rules may select a source line, keeping a file-level finding below this probability. */
  location?: { question: string; cutoff: number };
  /** Shown instead of the question when the rule fires. Not sent to the model. */
  message?: string;
}

export interface SharedOptions {
  ci?: CiBehavior;
  timeoutMs?: number;
  maxMatchesPerFile?: number;
  maxSnippetChars?: number;
  /** The TypeSafe model id, such as `jev-latest`, used when `ANTI_SLOP_DECISION_MODEL` is unset. */
  model?: string;
  /** Send TypeSafe's long-context header, raising its token limits. */
  longContext?: boolean;
  /** Only check matches that overlap lines changed against `changedBase`. */
  changedOnly?: boolean;
  /** The git ref `changedOnly` diffs against. */
  changedBase?: string;
}

export interface JevOptions extends SharedOptions {
  rules: JevRule[];
}

export interface JevPluginOptions extends SharedOptions {
  /** The oxlint plugin name. Each rule is configured as `<name>/<id>`. */
  name: string;
  rules: JevRule[];
}

/** Options as a rule sees them, with the defaults already merged underneath. */
export type ResolvedOptions = Required<JevOptions>;

export interface RequestMatch {
  readonly rule: Pick<JevRule, 'question' | 'location'>;
  readonly snippet: string;
  readonly truncated?: boolean;
}

export interface Match extends RequestMatch {
  readonly rule: JevRule;
  readonly loc: Location;
  /** The oxlint rule that collected the match and reports it. */
  readonly owner: object;
}

export interface BooleanQuestion {
  type: 'boolean';
  instructions: string;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export type Question = BooleanQuestion | ChoiceQuestion;

export interface DecisionRequest {
  state: { snippets: Record<string, string> };
  questions: Record<string, Question>;
}

export type Backend =
  | {
      kind: 'typesafe';
      model: string;
      apiKey: Redacted.Redacted<string>;
      baseURL: string;
      longContext: boolean;
    }
  | { kind: 'openai'; model: string; apiKey: Redacted.Redacted<string>; baseURL: string };

type PlainKey<Each> = Each extends Backend ? Omit<Each, 'apiKey'> & { apiKey: string } : never;

/** A backend as it crosses the synckit worker boundary, which cannot carry a `Redacted`. */
export type WireBackend = PlainKey<Backend>;

export interface AskInput {
  backend: WireBackend;
  request: DecisionRequest;
  timeoutMs: number;
}

/** `answers` are AI SDK decision answers, such as `{ type: 'boolean', probability }`. */
export type AskResult =
  | { ok: true; model: string; answers: Record<string, unknown> }
  | { ok: false; reason: string };

export interface Answered {
  /** The model id that answered, such as `jev-1.13.0`, even when the request said `jev-latest`. */
  readonly model: string;
  readonly answer: unknown;
}

export interface SnippetNode {
  readonly type: string;
  readonly range: Range;
  readonly parent?: NamedParent | null | undefined;
}

export interface NamedParent extends SnippetNode {
  readonly init?: unknown;
  readonly value?: unknown;
}

export interface ReportNode {
  readonly loc: Location;
  readonly openingElement?: { readonly loc: Location } | undefined;
}

/** The public shape of the default export. Consumers load the plugin by name, so the rule
 * internals are deliberately not part of the published type. */
export interface JevPlugin {
  meta: { name: string };
  rules: { ask: object; suggest: object };
}

/** The public shape of a `createJevPlugin` plugin: one oxlint rule per question id. */
export interface JevRulesPlugin {
  meta: { name: string };
  rules: Record<string, object>;
}

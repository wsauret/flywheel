import { Result, Schema } from "effect";
import type { QuestionChoice, QuestionChoiceOption, QuestionEntry } from "../../output-blocks.js";
import type { ToolDisplay, ToolPresentation } from "../types.js";

const HEADER_MAX = 12;
const FREEFORM_LABEL = "Other";
const sentence = (): ToolPresentation => ({ name: askUserDisplay.verbs.past, detail: "you" });

/** The model-facing result text of a user-cancelled question. The output
 *  layer compares against it to tell a real cancellation (already settled by
 *  the protocol) from an error result no interaction will ever settle. */
export const ASK_USER_CANCELLED_RESULT = "User cancelled the question.";

interface AskUserFields {
  [key: string]: unknown;
}

/** The user-facing prose an ask_user call carries for rendering above its
 *  question. Read leniently from the raw input: the runtime tool's guard owns
 *  validation, and rendering must never disagree with what it accepted. */
export function askUserLeadingContext(input: AskUserFields | undefined): string | undefined {
  const context = input?.context;
  return typeof context === "string" && context.trim().length > 0 ? context : undefined;
}

const OptionInputSchema = Schema.Union([
  Schema.NonEmptyString,
  Schema.Struct({
    label: Schema.NonEmptyString,
    description: Schema.optionalKey(Schema.String),
    recommended: Schema.optionalKey(Schema.Boolean),
    requires_text: Schema.optionalKey(Schema.Boolean),
  }),
]);

const QuestionInputSchema = Schema.Struct({
  question: Schema.NonEmptyString,
  header: Schema.optionalKey(Schema.String),
  options: Schema.Array(OptionInputSchema).check(Schema.isNonEmpty()),
  multi_select: Schema.optionalKey(Schema.Boolean),
  multiSelect: Schema.optionalKey(Schema.Boolean),
});

const AskUserInputSchema = Schema.StructWithRest(Schema.Struct({
  question: Schema.optionalKey(Schema.NonEmptyString),
  header: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(OptionInputSchema).check(Schema.isNonEmpty())),
  multi_select: Schema.optionalKey(Schema.Boolean),
  multiSelect: Schema.optionalKey(Schema.Boolean),
  questions: Schema.optionalKey(Schema.Array(QuestionInputSchema).check(Schema.isBetweenLength(1, 5))),
}), [Schema.Record(Schema.String, Schema.Unknown)]);

type AskUserInput = typeof AskUserInputSchema.Type;

type NormalizedAskUserInput =
  | { success: true; questions: QuestionEntry[] }
  | { success: false; message: string };

const RECOMMENDED_SUFFIX_RE = /^(.+?)\s*\(\s*recommended\s*\)\s*$/i;

function normalizeOption(option: typeof OptionInputSchema.Type, ordinal: number): QuestionChoiceOption {
  const raw = typeof option === "string" ? { label: option } : option;
  const match = raw.label.match(RECOMMENDED_SUFFIX_RE);
  const label = match?.[1] ?? raw.label;
  const recommended = raw.recommended === true || match !== null;
  return {
    kind: "option",
    choiceId: `choice-${ordinal + 1}`,
    label,
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(recommended ? { recommended: true } : {}),
    ...(raw.requires_text === true ? { requiresText: true } : {}),
  };
}

function buildChoices(options: ReadonlyArray<typeof OptionInputSchema.Type>): QuestionChoice[] {
  return [
    ...options.map(normalizeOption),
    { kind: "freeform", label: FREEFORM_LABEL },
  ];
}

/** The header renders only in the tab-strip chips, which clip overflow, so an
 *  over-long header is a display concern: elide it instead of failing the call.
 *  Counted in code points so a surrogate pair is never split. */
function elideHeader(header: string): string {
  const points = [...header];
  return points.length > HEADER_MAX ? `${points.slice(0, HEADER_MAX - 1).join("")}\u2026` : header;
}

function normalizeQuestion(input: typeof QuestionInputSchema.Type): QuestionEntry {
  return {
    question: input.question,
    ...(input.header !== undefined ? { header: elideHeader(input.header) } : {}),
    choices: buildChoices(input.options),
    multiSelect: (input.multi_select ?? input.multiSelect) ?? false,
  };
}

export function normalizeAskUserInput(input: AskUserFields | undefined): NormalizedAskUserInput {
  const parsed = Schema.decodeUnknownResult(AskUserInputSchema)(input ?? {});
  if (Result.isFailure(parsed)) return { success: false, message: parsed.failure.message };
  const data: AskUserInput = parsed.success;
  if (data.questions) return { success: true, questions: data.questions.map(normalizeQuestion) };
  if (!data.question || !data.options) {
    return { success: false, message: "Provide either questions[] or question plus options." };
  }
  return {
    success: true,
    questions: [normalizeQuestion({
      question: data.question,
      ...(data.header !== undefined ? { header: data.header } : {}),
      options: data.options,
      multi_select: data.multi_select,
      multiSelect: data.multiSelect,
    })],
  };
}

export const askUserDisplay: ToolDisplay = {
  name: "ask_user",
  action: "ask_user",
  displayName: "Ask User",
  verbs: { progressive: "asking", past: "Asked" },
  isOptimistic: false,
  getSentence: sentence,
  getDetail: (input) => {
    const normalized = normalizeAskUserInput(input);
    return normalized.success ? normalized.questions[0]?.question ?? "Question" : "Question";
  },
  leadingText: askUserLeadingContext,
  // The controller replaces this provisional identity with the interactive
  // question only after the request is durable.
  standaloneHandler: (input, timestamp, builder, toolUseId) => {
    if (toolUseId) {
      const index = builder.pushStandaloneToolEntry({
        kind: "tool",
        id: toolUseId,
        name: "ask_user",
        presentation: { name: "Ask User", detail: "" },
        sentence: sentence(),
        action: "ask_user",
        timestamp,
        status: "streaming",
      });
      return { index, toolName: "ask_user" };
    }
    return null;
  },
};

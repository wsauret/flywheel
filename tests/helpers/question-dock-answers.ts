/** Resolve answer text against the choices each question declared, the way the
 *  dock resolves what the user did: text equal to a declared option's label is
 *  that choice and contributes the option's id, anything else is free text. A
 *  fake ask_user controller answers in labels, so this is what turns those
 *  labels into the durable discriminated answer the strict fact requires. */

import type { QuestionEntry } from "../../src/infra/output-blocks.js";
import type { AgentInputAnswer } from "../../src/protocol/question-protocol-types.js";

type QuestionOption = Extract<QuestionEntry["choices"][number], { kind: "option" }>;

export function resolveDockAnswers(
  questions: readonly QuestionEntry[],
  answers: Record<string, string>,
): Record<string, AgentInputAnswer> {
  const resolved: Record<string, AgentInputAnswer> = {};
  for (const [question, text] of Object.entries(answers)) {
    const choices = questions.find((entry) => entry.question === question)?.choices ?? [];
    const option = choices.find((choice): choice is QuestionOption => choice.kind === "option" && choice.label === text);
    resolved[question] = option?.choiceId
      ? { kind: "choice", selections: [{ choiceId: option.choiceId }], text }
      : { kind: "freeform", text };
  }
  return resolved;
}

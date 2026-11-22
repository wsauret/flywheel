import type { HeadlessBenchmarkInput } from "../../src/orchestration/modules/development/benchmark/headless-execution.js";

type QuestionPolicy = NonNullable<HeadlessBenchmarkInput["answerQuestion"]>;
/** A question the subject asks as an ACP form, as the adapter decodes it. */
type HeadlessQuestionForm = Parameters<QuestionPolicy>[0];
type HeadlessFormContent = ReturnType<QuestionPolicy>;

/** Record an answered question for deduplication. Only an approving answer increases the approval count. */
export function recordCampaignAnswer(
  capture: { readonly answered: Set<string>; approvals: number },
  toolUseId: string,
  kind: "approve" | "revise-design",
) {
  capture.answered.add(toolUseId);
  if (kind === "approve") capture.approvals++;
}

/** The single-choice options of a form that asks exactly one question, which
 *  is the form's `q1` property; text properties beside it are `q1_<id>`. */
function singleChoice(form: HeadlessQuestionForm, answered: ReadonlySet<string>) {
  if (answered.has(form.toolUseId)) return undefined;
  const { properties } = form.requestedSchema;
  const questions = Object.keys(properties).filter((key) => /^q\d+$/.test(key));
  const question = properties.q1;
  if (questions.length !== 1 || question?.type !== "string" || !question.oneOf) return undefined;
  return { options: question.oneOf, properties };
}

/** Approve only a typed workflow launch question. Flywheel composes it with the
 *  choice id `approve`, which a model-written question never has (its choices
 *  are numbered), and names the same workflow in the question and the choice. */
export function campaignWorkflowApproval(form: HeadlessQuestionForm, answered: ReadonlySet<string>): HeadlessFormContent {
  const question = singleChoice(form, answered);
  const name = /^Launch the (.+) workflow\?$/.exec(form.message)?.[1];
  const approve = question?.options.find((option) => option.const === "approve");
  if (name === undefined || approve?.title !== `Start the ${name} workflow`) return undefined;
  return { q1: approve.const };
}

/** Approve a single design-approval question: one that offers `Approve and
 *  continue` and a `Revise design` choice that takes text. */
export function campaignDesignAnswer(form: HeadlessQuestionForm, answered: ReadonlySet<string>): HeadlessFormContent {
  const question = singleChoice(form, answered);
  const approve = question?.options.find((option) => option.title === "Approve and continue");
  const revise = question?.options.find((option) => option.title === "Revise design");
  if (!question || !approve || !revise || !(`q1_${revise.const}` in question.properties)) return undefined;
  return { q1: approve.const };
}

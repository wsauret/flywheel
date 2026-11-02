import { Schema } from "effect";
import { LearningScopeSchema } from "./learning-scope.js";
import { MutationDiffSchema } from "./mutation-diff.js";
import { MutationEvidenceSchema } from "./mutation-evidence-schema.js";

/** One durable skill write a learning review notice reports: the
 *  package it wrote, the action it took, and the canonical artifact of what the
 *  write changed.
 *
 *  The notice text groups repeated writes into one clause per skill; these
 *  records keep every write, in the order the fork made them, as the evidence
 *  under that text. Evidence for a reader only: nothing derives state,
 *  identity, or a count from it, and it never enters the model-visible context.
 *
 *  `mutation` is absent when the write published no artifact. A published
 *  artifact is already safe to retain: `buildMutationDiff` omits a sensitive
 *  target whole rather than carrying its bytes, and this notice is retained by
 *  the user-local event store of the project that made the write, which crosses
 *  no export, sync, or sharing boundary. Records written before the artifact
 *  existed carry nothing, which is why absence stays valid. */
export const ReviewNoticeMutationSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  action: Schema.NonEmptyString,
  reach: LearningScopeSchema,
  mutation: Schema.optionalKey(MutationDiffSchema),
});

export type ReviewNoticeMutation = typeof ReviewNoticeMutationSchema.Type;

/** One ordered manifest carries all review actions and their evidence. Skill and
 * memory journals still use ReviewNoticeMutation before the notice is retained. */
export const ReferenceReviewNoticeFields = {
  mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
  reviewMutations: Schema.optionalKey(Schema.Never),
};
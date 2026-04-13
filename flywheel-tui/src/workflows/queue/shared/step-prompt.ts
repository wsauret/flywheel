import type { Step } from "../types";

/** Build a prompt from step metadata (title, description, acceptance criteria). */
export function buildStepMetadataPrompt(step: Step): string {
  const parts = [step.title];
  if (step.description) parts.push(step.description);
  if (step.acceptanceCriteria?.length) {
    parts.push("Acceptance criteria:", ...step.acceptanceCriteria.map(c => `- ${c}`));
  }
  return parts.join("\n");
}

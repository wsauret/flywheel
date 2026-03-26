// ---------------------------------------------------------------------------
// Queue System — Proto-Step Schema & Formalization
// ---------------------------------------------------------------------------
//
// Proto-steps are lightweight step definitions output by the plan workflow.
// They contain human-readable metadata (title, description, acceptance
// criteria) but no execution details (no prompt, no ID). The
// formalizeProtoSteps() function deterministically converts proto-steps into
// full Step[] definitions suitable for queue insertion.
//
// Terminology:
//   ProtoStep — lightweight step definition from plan output
//   Step      — full queue step with ID, type, status, and metadata
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { Step } from "./types";

// ---------------------------------------------------------------------------
// Complexity enum for estimated effort
// ---------------------------------------------------------------------------

export const EstimatedComplexitySchema = z.enum([
  "trivial",
  "low",
  "medium",
  "high",
  "critical",
]);

export type EstimatedComplexity = z.infer<typeof EstimatedComplexitySchema>;

// ---------------------------------------------------------------------------
// ProtoStep Zod schema
// ---------------------------------------------------------------------------

export const ProtoStepSchema = z.object({
  /** Human-readable title for the step. */
  title: z.string().min(1),
  /** Detailed description of what the step should accomplish. */
  description: z.string().min(1),
  /** Acceptance criteria that must be satisfied for the step to pass. */
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  /** Milestone this step belongs to (optional). */
  milestone: z.string().optional(),
  /** Validation contract assertion IDs this step fulfills (optional). */
  fulfills: z.array(z.string()).optional(),
  /** Estimated complexity of the step (optional). */
  estimatedComplexity: EstimatedComplexitySchema.optional(),
}).strict();

export type ProtoStep = z.infer<typeof ProtoStepSchema>;

// ---------------------------------------------------------------------------
// ProtoStep array schema (for validating plan output)
// ---------------------------------------------------------------------------

export const ProtoStepArraySchema = z.array(ProtoStepSchema).min(1);

// ---------------------------------------------------------------------------
// Formalization options
// ---------------------------------------------------------------------------

export interface FormalizeOptions {
  /** Step type to assign to all formalized steps. Default: "work". */
  stepType?: Step["type"];
  /** ID generator function. Default: sequential `step-<index>`. */
  idGenerator?: (index: number) => string;
}

// ---------------------------------------------------------------------------
// Template-based prompt generation
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic prompt from proto-step metadata.
 * No LLM involved — pure string template.
 */
function buildStepPrompt(proto: ProtoStep, index: number, total: number): string {
  const lines: string[] = [];

  lines.push(`## Step ${index + 1} of ${total}: ${proto.title}`);
  lines.push("");
  lines.push("### Description");
  lines.push(proto.description);
  lines.push("");
  lines.push("### Acceptance Criteria");
  for (const criterion of proto.acceptanceCriteria) {
    lines.push(`- [ ] ${criterion}`);
  }

  if (proto.estimatedComplexity) {
    lines.push("");
    lines.push(`### Estimated Complexity: ${proto.estimatedComplexity}`);
  }

  if (proto.fulfills && proto.fulfills.length > 0) {
    lines.push("");
    lines.push(`### Fulfills: ${proto.fulfills.join(", ")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API: formalizeProtoSteps
// ---------------------------------------------------------------------------

/**
 * Convert an array of proto-steps into full Step[] definitions.
 *
 * This is a deterministic, template-based conversion — no LLM involved.
 * Each proto-step becomes a Step with:
 *   - A unique ID (sequential by default, or from idGenerator)
 *   - Type "work" by default (or from options.stepType)
 *   - Status "pending"
 *   - Title from proto-step
 *   - Optional milestone, fulfills from proto-step
 *
 * The generated prompt is stored in the returned StepWithPrompt.prompt field.
 *
 * @param protoSteps Validated array of ProtoStep objects
 * @param options Optional formalization configuration
 * @returns Array of Step definitions with generated prompts
 */
export function formalizeProtoSteps(
  protoSteps: ProtoStep[],
  options?: FormalizeOptions,
): StepWithPrompt[] {
  const stepType = options?.stepType ?? "work";
  const idGen = options?.idGenerator ?? ((i: number) => `step-${i + 1}`);
  const total = protoSteps.length;

  return protoSteps.map((proto, index) => {
    const step: StepWithPrompt = {
      id: idGen(index),
      type: stepType,
      title: proto.title,
      status: "pending",
      prompt: buildStepPrompt(proto, index, total),
    };

    // Attach optional metadata
    if (proto.milestone) {
      step.milestone = proto.milestone;
    }
    if (proto.fulfills && proto.fulfills.length > 0) {
      step.fulfills = [...proto.fulfills];
    }

    return step;
  });
}

// ---------------------------------------------------------------------------
// StepWithPrompt — Step extended with a generated prompt
// ---------------------------------------------------------------------------

/**
 * A Step with an additional `prompt` field containing the generated
 * execution prompt from proto-step formalization.
 */
export interface StepWithPrompt extends Step {
  /** Generated execution prompt from template-based formalization. */
  prompt: string;
}

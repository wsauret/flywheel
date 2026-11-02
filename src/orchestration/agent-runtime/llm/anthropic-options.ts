import { dashedModelId } from "../../../infra/llm/model-id.js";
import type { ModelInfo, ReasoningEffort } from "../../../infra/llm/models.js";
import type { AnthropicThinkingDisplay } from "../../../infra/llm/provider-options.js";
import { clampReasoningEffort, type ReasoningEffortTier } from "./model-compat.js";

/** Assumed tiers for adaptive-thinking models with no models.dev effort
 *  declaration: every adaptive Claude release accepts low through high. */
const ANTHROPIC_EFFORT_FALLBACK = ["low", "medium", "high"] as const satisfies readonly ReasoningEffortTier[];

export function mapAnthropicAdaptiveEffort(
  info: ModelInfo | null,
  effort: ReasoningEffort,
): Exclude<ReasoningEffortTier, "ultra"> | null {
  if (effort === "off") return null;
  const clamped = clampReasoningEffort(effort, info, ANTHROPIC_EFFORT_FALLBACK);
  return clamped === "ultra" ? "max" : clamped;
}

export function anthropicThinkingBudget(
  effort: ReasoningEffort,
  maxTokens: number,
): number {
  const requested = effort === "low" ? 4_096 : effort === "medium" ? 8_192 : 16_384;
  return Math.max(1, Math.min(requested, Math.max(1, maxTokens - 1)));
}

export function anthropicThinkingDisplay(
  display: AnthropicThinkingDisplay | undefined,
  model: string,
  accessProvider: string,
): AnthropicThinkingDisplay {
  if (display) return display;
  const supported = /^(claude-fable-5(?:-1)?|claude-mythos-5-1)(?:-\d{8})?$/.test(dashedModelId(model));
  return accessProvider === "anthropic_api" && supported ? "updates" : "summarized";
}

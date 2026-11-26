import { numField, strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDisplay, ToolPresentationResolution } from "../types.js";

/** One seat as the run reports it: `model@effort`, the id shape the benchmark
 *  stores and the report prints. */
function seatLabel(model: string, effort: string | null): string {
  return effort ? `${model}@${effort}` : model;
}

function variantList(input: ToolInput): string {
  const variants = input.variants;
  if (!Array.isArray(variants)) return "";
  return variants.flatMap((variant) => {
    if (typeof variant !== "object" || variant === null || !("model" in variant) || typeof variant.model !== "string" || variant.model.length === 0) return [];
    const effort = "effort" in variant && typeof variant.effort === "string" && variant.effort.length > 0 ? variant.effort : null;
    return [seatLabel(variant.model, effort)];
  }).join(" vs ");
}

/** Material run parameters beyond the seats: repeat count above one, and
 *  whether the call is a dry run that spends nothing. */
function runModifiers(input: ToolInput): string {
  const repeats = numField(input, "repeats");
  const parts: string[] = [];
  if (repeats !== undefined && repeats > 1) parts.push(`x${repeats}`);
  if (input.dryRun === true) parts.push("(dry run)");
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/** run and resume are distinct operations to a reader: one starts a matrix, the
 *  other continues a named results directory. */
function presentation(input: ToolInput): ToolPresentationResolution {
  const action = strField(input, "action");
  if (action === "run") {
    const persona = strField(input, "persona");
    if (!persona) return "input_not_ready";
    const variants = variantList(input);
    const detail = variants ? `${persona}: ${variants}` : persona;
    return { name: "Benchmark", detail: `${detail}${runModifiers(input)}` };
  }
  if (action === "resume") {
    const resultId = strField(input, "resultId");
    if (!resultId) return "input_not_ready";
    return { name: "Resume Benchmark", detail: `${resultId}${input.dryRun === true ? " (dry run)" : ""}` };
  }
  return "input_not_ready";
}

export const benchmarkDisplay: ToolDisplay = {
  name: "benchmark",
  action: "benchmark_run",
  displayName: "Benchmark",
  verbs: { progressive: "Benchmarking", past: "Benchmarked" },
  isOptimistic: false,
  // The row body is the streamed benchmark progress tail while the matrix
  // runs, and the recorded tail (or the dry-run matrix JSON) after it settles.
  preservesResultContent: true,
  resultContentFromExecutionOutput: true,
  getPresentation: presentation,
};

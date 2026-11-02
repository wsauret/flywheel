import type { LogicalNode } from "./graph-types.js";

export function isNonEmpty(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function normalizedSignal(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return raw.replace(/\s+/g, " ").trim();
}

/** The evaluator's stop decision, shared by control and its tree projection. */
export function whileOutcome(
  node: Extract<LogicalNode, { kind: "while" }>,
  handoff: { readonly [key: string]: unknown },
  iteration: number,
  previousHandoff?: { readonly [key: string]: unknown } | null,
): "dry" | "stuck" | "bound" | undefined {
  const raw = handoff[node.evaluator.field];
  if (!isNonEmpty(raw)) return "dry";
  const prior = previousHandoff === undefined ? node.priorNormalizedSignal : previousHandoff === null ? null : normalizedSignal(previousHandoff[node.evaluator.field]);
  if (node.detectStuck && prior !== null && prior === normalizedSignal(raw)) return "stuck";
  return iteration >= node.maxIterations ? "bound" : undefined;
}

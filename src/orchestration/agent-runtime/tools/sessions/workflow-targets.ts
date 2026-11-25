/** Normalizes model-supplied targets: missing or empty means whole workflow; null means invalid. */
export function parseWorkflowTargets(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const targets = value.map((target) => typeof target === "string" ? target.trim() : "");
  if (targets.some((target) => !target)) return null;
  return targets.length === 0 ? undefined : targets;
}

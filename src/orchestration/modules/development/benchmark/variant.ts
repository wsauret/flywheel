import { EFFORT_VALUES, type Effort } from "../../../../infra/workflow-types.js";

/** An explicitly authored model and effort for one benchmark seat. */
export interface VariantSpec {
  id: string;
  model: string;
  effort: Effort;
}

function isEffort(value: string): value is Effort {
  return EFFORT_VALUES.some((effort) => effort === value);
}

/** The seat a structured (model, effort) request names. The id shape lives here
 *  alone, so seats requested as objects and seats parsed from CLI text compare
 *  and store identically. */
export function variantSeat(model: string, effort: string): VariantSpec {
  if (!isEffort(effort)) throw new Error(`Unknown effort "${effort}" for model "${model}"`);
  return { id: `${model}@${effort}`, model, effort };
}

export function parseVariant(spec: string): VariantSpec {
  const [model, effort, removedProvider] = spec.split(":");
  if (removedProvider !== undefined) {
    throw new Error(`--variant "${spec}" names a provider segment, which no longer exists: access-provider routing is automatic. Use model:effort.`);
  }
  if (!model || !effort) throw new Error(`--variant must be model:effort, got "${spec}"`);
  return variantSeat(model, effort);
}

/** Stored seat rows carry the VariantSpec fields, but the strategy harness
 *  stores composite seats (model "a+b", effort "high+medium"), so the
 *  comparison is over plain strings rather than Effort. */
interface SeatIdentity {
  id: string;
  model?: string;
  effort?: string;
}

/** Whether a run's requested seats match the stored run-config seats, so a
 *  resume never silently mixes results from different seat lists. */
export function sameVariants(left: readonly SeatIdentity[], right: readonly SeatIdentity[]): boolean {
  return left.length === right.length && left.every((variant, index) => {
    const other = right[index];
    return other !== undefined && variant.id === other.id && variant.model === other.model && variant.effort === other.effort;
  });
}

import type { EvaluatorInput } from "./schemas.js";
import type { EvaluatorResult } from "../../infra/workflow-types.js";

/**
 * DI interface for evaluator.
 * Separate from DispatcherTransport for type-safe, clear contracts.
 */
export interface EvaluatorTransport {
  invoke(input: EvaluatorInput): Promise<EvaluatorResult>;
}

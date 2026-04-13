import type { EvaluatorInput } from "./schemas";
import type { EvaluatorResult } from "../../infra/workflow-types";

/**
 * DI interface for evaluator.
 * Separate from DispatcherTransport for type-safe, clear contracts.
 */
export interface EvaluatorTransport {
  invoke(input: EvaluatorInput): Promise<EvaluatorResult>;
}

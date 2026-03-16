import type { EvaluatorInput, EvaluatorResult } from "../schemas/evaluator";

// TODO(feat-flywheel-cli-intelligence): Implementation in Plan 3

/**
 * DI interface for evaluator.
 * Separate from DispatcherTransport for type-safe, clear contracts.
 */
export interface EvaluatorTransport {
  invoke(input: EvaluatorInput): Promise<EvaluatorResult>;
}

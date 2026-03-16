import type { DispatcherInput, DispatcherDecision } from "../schemas/dispatcher";

// TODO(feat-flywheel-cli-intelligence): Implementation in Plan 3

/**
 * DI interface for Tier 2 dispatcher.
 * Separate from EvaluatorTransport for type-safe, clear contracts.
 */
export interface DispatcherTransport {
  invoke(input: DispatcherInput): Promise<DispatcherDecision>;
}

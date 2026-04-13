import type { DispatcherInput } from "./schemas";
import type { DispatcherDecision } from "../../infra/workflow-types";

/**
 * DI interface for Tier 2 dispatcher.
 * Separate from EvaluatorTransport for type-safe, clear contracts.
 */
export interface DispatcherTransport {
  invoke(input: DispatcherInput): Promise<DispatcherDecision>;
}

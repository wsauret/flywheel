import type { DispatcherInput } from "./schemas.js";
import type { DispatcherDecision } from "../../infra/workflow-types.js";

/**
 * DI interface for Tier 2 dispatcher.
 * Separate from EvaluatorTransport for type-safe, clear contracts.
 */
export interface DispatcherTransport {
  invoke(input: DispatcherInput): Promise<DispatcherDecision>;
}

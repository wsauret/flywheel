import type { DispatcherInput } from "./schemas.js";
import type { DispatcherDecision } from "../../infra/workflow-types.js";

export interface DispatcherTransport {
  invoke(input: DispatcherInput, signal?: AbortSignal): Promise<DispatcherDecision>;
}

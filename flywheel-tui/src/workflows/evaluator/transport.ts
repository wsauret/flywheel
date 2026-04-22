import type { EvaluatorInput } from "./schemas.js";
import type { EvaluatorResult } from "../../infra/workflow-types.js";

export interface EvaluatorTransport {
  invoke(input: EvaluatorInput): Promise<EvaluatorResult>;
}

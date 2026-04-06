/**
 * Factory for creating an engine-aware evaluator transport.
 *
 * Uses the configured engine and model to create a SubprocessEvaluatorTransport
 * with the correct engine-aware command building.
 *
 * The evaluator model falls back to: evaluator.model -> dispatcher.model -> engine default.
 */

import type { EvaluatorTransport } from "./transport";
import type { SubprocessEvaluatorTransportOptions } from "./subprocess-transport";
import { SubprocessEvaluatorTransport } from "./subprocess-transport";
import { Log } from "../../infra/log";

const log = Log.create({ service: "evaluator-transport-factory" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateEvaluatorTransportOptions = SubprocessEvaluatorTransportOptions;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an engine-aware evaluator transport.
 *
 * Uses the SubprocessEvaluatorTransport with the configured engine and model,
 * passing per-engine optimization flags (tools disabled, fast model, etc.).
 */
export async function createEvaluatorTransport(
  options: CreateEvaluatorTransportOptions,
): Promise<EvaluatorTransport> {
  log.info("creating evaluator transport", {
    engine: options.engine.metadata.id,
    model: options.tierConfig?.model ?? "(default)",
  });

  return new SubprocessEvaluatorTransport(options);
}

/**
 * Factory for creating an engine-aware evaluator transport.
 *
 * Mirrors the dispatcher's auto-detect pattern: uses the configured engine
 * and model to create a SubprocessEvaluatorTransport with the correct
 * engine-aware command building.
 *
 * The evaluator model falls back to: evaluator.model → dispatcher.model → engine default.
 */

import type { ProcessSpawner } from "../worker/spawner";
import type { EvaluatorTransport } from "./transport";
import { SubprocessEvaluatorTransport } from "./subprocess-transport";
import { Log } from "../utils/log";

const log = Log.create({ service: "evaluator-transport-factory" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateEvaluatorTransportOptions {
  spawner: ProcessSpawner;
  /** Engine name — "claude" or "opencode". Defaults to "opencode". */
  engineName?: string;
  /** Evaluator model override — flows to --model CLI flag. Uses engine default when not set. */
  evaluatorModel?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an engine-aware evaluator transport.
 *
 * Uses the SubprocessEvaluatorTransport with the configured engine and model,
 * passing per-engine optimization flags (tools disabled, fast model, etc.).
 */
export function createEvaluatorTransport(
  options: CreateEvaluatorTransportOptions,
): EvaluatorTransport {
  const engineName = options.engineName ?? "opencode";

  log.info("creating evaluator transport", {
    engine: engineName,
    model: options.evaluatorModel ?? "(default)",
  });

  return new SubprocessEvaluatorTransport({
    spawner: options.spawner,
    engineName,
    evaluatorModel: options.evaluatorModel,
  });
}

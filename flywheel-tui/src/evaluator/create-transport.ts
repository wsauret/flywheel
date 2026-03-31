/**
 * Factory for creating an engine-aware evaluator transport.
 *
 * Mirrors the dispatcher's auto-detect pattern: uses the configured engine
 * and model to create a SubprocessEvaluatorTransport with the correct
 * engine-aware command building.
 *
 * When the engine is OpenCode and the SDK is available, the shared SdkSpawner
 * singleton (from engines/sdk-detect.ts) is used instead of the caller-provided
 * subprocess spawner — giving the evaluator full streaming support.
 *
 * The evaluator model falls back to: evaluator.model → dispatcher.model → engine default.
 */

import type { ProcessSpawner } from "../worker/spawner";
import type { EvaluatorTransport } from "./transport";
import { SubprocessEvaluatorTransport } from "./subprocess-transport";
import { SDK_AVAILABLE, getOrCreateSdkSpawner } from "../engines/sdk-detect.js";
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
  /** Called with each decoded stdout chunk as it arrives from the evaluator subprocess. */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives from the evaluator subprocess. */
  onStderr?: (chunk: string) => void;
  /** Base directory for subprocess JSONL logging. When set, all stdout/stderr is logged. */
  logBaseDir?: string;
  /** Flywheel session ID for session-scoped handoff paths. */
  sessionId?: string;
  /** Project base directory for path resolution. */
  baseDir?: string;
  /** Optional addendum appended to the evaluator system prompt (e.g. sprint adversarial instructions). */
  systemPromptAddendum?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an engine-aware evaluator transport.
 *
 * Uses the SubprocessEvaluatorTransport with the configured engine and model,
 * passing per-engine optimization flags (tools disabled, fast model, etc.).
 *
 * When engine is OpenCode and SDK is available, the shared SdkSpawner singleton
 * is used for streaming support (same pattern as the dispatcher's auto-detect).
 */
export async function createEvaluatorTransport(
  options: CreateEvaluatorTransportOptions,
): Promise<EvaluatorTransport> {
  const engineName = options.engineName ?? "opencode";
  let spawner = options.spawner;

  // OpenCode engine: try SdkSpawner for streaming (shared singleton with dispatcher)
  if (engineName !== "claude" && SDK_AVAILABLE) {
    const sdkSpawner = await getOrCreateSdkSpawner();
    if (sdkSpawner) {
      log.info("using shared SdkSpawner for evaluator transport (streaming mode)", {
        engine: engineName,
        model: options.evaluatorModel ?? "(default)",
      });
      spawner = sdkSpawner;
    } else {
      log.warn("SDK available but SdkSpawner creation failed for evaluator, using subprocess", {
        engine: engineName,
      });
    }
  }

  log.info("creating evaluator transport", {
    engine: engineName,
    model: options.evaluatorModel ?? "(default)",
    usingSdk: spawner !== options.spawner,
  });

  return new SubprocessEvaluatorTransport({
    spawner,
    engineName,
    evaluatorModel: options.evaluatorModel,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    logBaseDir: options.logBaseDir,
    sessionId: options.sessionId,
    baseDir: options.baseDir,
    systemPromptAddendum: options.systemPromptAddendum,
  });
}

/**
 * Auto-detect — selects the best available dispatcher transport based on engine config.
 *
 * Engine routing:
 * - All engines use SubprocessTransport with the passed spawner.
 */

import type { DispatcherTransport } from "./transport";
import type { SubprocessTransportOptions } from "./subprocess-transport";
import { SubprocessTransport } from "./subprocess-transport";
import { Log } from "../../infra/log";

const log = Log.create({ service: "dispatcher" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedTransport {
  transport: DispatcherTransport;
  /** Which transport was selected */
  label: "cli";
  /** Stop the API server. No-op for CLI transport. */
  dispose(): void;
}

export interface AutoDetectOptions extends SubprocessTransportOptions {
  /** Server start timeout in ms (default: 10 000). */
  serverTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the dispatcher transport — always uses SubprocessTransport.
 */
export async function autoDetectTransport(
  options: AutoDetectOptions,
): Promise<ResolvedTransport> {
  log.info(`${options.engine.metadata.id} engine — using subprocess transport`);
  const transport = new SubprocessTransport(options);
  return { transport, label: "cli", dispose: () => {} };
}

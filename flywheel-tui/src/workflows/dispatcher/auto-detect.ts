/**
 * Auto-detect — selects the best available dispatcher transport based on engine config.
 *
 * Engine routing:
 * - All engines use SubprocessTransport with the passed spawner.
 */

import type { DispatcherTransport } from "./transport";
import type { ProcessSpawner } from "../../orchestration/worker/spawner";
import { SubprocessTransport } from "./subprocess-transport";
import { Log } from "../shared/log";

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

export interface AutoDetectOptions {
  spawner: ProcessSpawner;
  /** Server start timeout in ms (default: 10 000). */
  serverTimeoutMs?: number;
  /** Engine name — "claude" or "opencode". Defaults to "opencode". */
  engineName?: string;
  /** Dispatcher model override — passed through to SubprocessTransport. */
  dispatcherModel?: string;
  /** Called with each decoded stdout chunk as it arrives from the dispatcher subprocess. */
  onStdout?: (chunk: string) => void;
  /** Called with each decoded stderr chunk as it arrives from the dispatcher subprocess. */
  onStderr?: (chunk: string) => void;
  /** Base directory for subprocess JSONL logging. When set, all stdout/stderr is logged. */
  logBaseDir?: string;
  /** Flywheel session ID for session-scoped handoff paths. */
  sessionId?: string;
  /** Project base directory for path resolution. */
  baseDir?: string;
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
  const engineName = options.engineName ?? "opencode";

  log.info(`${engineName} engine — using subprocess transport`);
  const transport = new SubprocessTransport({
    spawner: options.spawner,
    engineName,
    dispatcherModel: options.dispatcherModel,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    logBaseDir: options.logBaseDir,
    sessionId: options.sessionId,
    baseDir: options.baseDir,
  });
  return { transport, label: "cli", dispose: () => {} };
}

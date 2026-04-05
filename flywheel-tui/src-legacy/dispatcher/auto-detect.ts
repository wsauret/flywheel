/**
 * Auto-detect — selects the best available dispatcher transport based on engine config.
 *
 * Engine routing:
 * - Claude: always uses SubprocessTransport with BunProcessSpawner
 * - OpenCode: tries SdkSpawner first (full streaming via SDK), falls back to SubprocessTransport
 *
 * When SDK is available, a SdkSpawner is created and passed to SubprocessTransport.
 * This gives full streaming (thinking text, tool use events) through the same
 * infrastructure the worker already uses, replacing the old synchronous SdkTransport.
 *
 * The SdkSpawner owns its server lifecycle — caller must call `dispose()` to stop it.
 */

import type { DispatcherTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import { SubprocessTransport } from "./subprocess-transport";
import { SDK_AVAILABLE, getOrCreateSdkSpawner } from "../engines/sdk-detect.js";
import { Log } from "../utils/log";

const log = Log.create({ service: "dispatcher" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedTransport {
  transport: DispatcherTransport;
  /** Which transport was selected: "sdk" or "cli" */
  label: "sdk" | "cli";
  /** Stop the API server (SDK only). No-op for CLI transport. */
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
 * Auto-detect the best available transport.
 *
 * Engine-aware routing:
 * - Claude: skip SDK entirely (it's OpenCode-only), use Claude Code subprocess
 * - OpenCode: try SdkSpawner first (streaming via SDK), fall back to CLI subprocess
 * - Default (no engine specified): existing behavior (try SDK → subprocess with opencode)
 */
export async function autoDetectTransport(
  options: AutoDetectOptions,
): Promise<ResolvedTransport> {
  const engineName = options.engineName ?? "opencode";

  // Subprocess-based engines: skip SDK entirely — SDK is OpenCode-only
  if (engineName !== "opencode") {
    log.info(`${engineName} engine — using subprocess transport (SDK is OpenCode-only)`);
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

  // OpenCode engine: try SdkSpawner first, fall back to subprocess
  if (SDK_AVAILABLE) {
    const sdkSpawner = await getOrCreateSdkSpawner();
    if (sdkSpawner) {
      log.info("using SdkSpawner with SubprocessTransport for dispatcher (streaming mode)");
      const transport = new SubprocessTransport({
        spawner: sdkSpawner,
        engineName,
        dispatcherModel: options.dispatcherModel,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
        logBaseDir: options.logBaseDir,
        sessionId: options.sessionId,
        baseDir: options.baseDir,
      });
      return {
        transport,
        label: "sdk",
        dispose: () => {
          // SdkSpawner is a singleton — don't dispose it here, it's shared.
          // It will be cleaned up on process exit.
        },
      };
    }
    log.warn("SDK available but SdkSpawner creation failed, falling back to subprocess");
  }

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

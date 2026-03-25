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
import { SDK_AVAILABLE } from "./sdk-transport";
import { SubprocessTransport } from "./subprocess-transport";
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
}

// SdkSpawner singleton — shared across all pipelines in the same process.
// Created once, reused until process exit.
let _sdkSpawner: ProcessSpawner & { dispose(): void } | null = null;
let _sdkSpawnerCreating: Promise<(ProcessSpawner & { dispose(): void }) | null> | null = null;

/**
 * Get or create the shared SdkSpawner instance.
 * Returns null if the SDK is not available or the spawner cannot be created.
 *
 * Exported so the evaluator transport can share the same singleton.
 */
export async function getOrCreateSdkSpawner(): Promise<(ProcessSpawner & { dispose(): void }) | null> {
  if (_sdkSpawner) return _sdkSpawner;

  // Deduplicate concurrent calls
  if (_sdkSpawnerCreating) return _sdkSpawnerCreating;

  _sdkSpawnerCreating = (async () => {
    try {
      // Dynamic import — only loaded when SDK is available
      const { SdkSpawner } = await import("../worker/sdk-spawner");
      const spawner = new SdkSpawner();
      _sdkSpawner = spawner;
      log.info("SdkSpawner created for dispatcher (streaming mode)");
      return spawner;
    } catch (err) {
      log.warn("failed to create SdkSpawner for dispatcher", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      _sdkSpawnerCreating = null;
    }
  })();

  return _sdkSpawnerCreating;
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

  // Claude engine: skip SDK entirely — SDK is OpenCode-only
  if (engineName === "claude") {
    log.info("claude engine — using subprocess transport (SDK is OpenCode-only)");
    const transport = new SubprocessTransport({
      spawner: options.spawner,
      engineName: "claude",
      dispatcherModel: options.dispatcherModel,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      logBaseDir: options.logBaseDir,
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
  });
  return { transport, label: "cli", dispose: () => {} };
}

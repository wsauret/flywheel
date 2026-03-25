/**
 * Auto-detect — selects the best available dispatcher transport based on engine config.
 *
 * Engine routing:
 * - Claude: always uses SubprocessTransport (SDK is OpenCode-only)
 * - OpenCode: tries SDK first, falls back to SubprocessTransport
 *
 * The server is owned by the returned handle — caller must call `dispose()`
 * to stop it when the pipeline finishes.
 */

import type { DispatcherTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import { SDK_AVAILABLE, SdkTransport, _createOpencodeServer } from "./sdk-transport";
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
}

// Server singleton — shared across all pipelines in the same process.
// Started once, reused until process exit.
let _serverInstance: { url: string; close(): void } | null = null;
let _serverStarting: Promise<{ url: string; close(): void } | null> | null = null;

/**
 * Get or start the shared OpenCode API server.
 * Returns null if the server cannot be started.
 */
async function getOrStartServer(timeoutMs: number): Promise<{ url: string; close(): void } | null> {
  if (_serverInstance) return _serverInstance;

  // Deduplicate concurrent calls
  if (_serverStarting) return _serverStarting;

  _serverStarting = (async () => {
    if (!_createOpencodeServer) return null;
    try {
      const server = await _createOpencodeServer({ timeout: timeoutMs });
      _serverInstance = server;
      log.info("opencode API server started", { url: server.url });
      return server;
    } catch (err) {
      log.warn("failed to start opencode API server", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      _serverStarting = null;
    }
  })();

  return _serverStarting;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Auto-detect the best available transport.
 *
 * Engine-aware routing:
 * - Claude: skip SDK entirely (it's OpenCode-only), use Claude Code subprocess
 * - OpenCode: try SDK first, fall back to OpenCode subprocess
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
    });
    return { transport, label: "cli", dispose: () => {} };
  }

  // OpenCode engine: try SDK first, fall back to subprocess
  if (SDK_AVAILABLE && _createOpencodeServer) {
    const server = await getOrStartServer(options.serverTimeoutMs ?? 10_000);
    if (server) {
      const transport = new SdkTransport({
        baseUrl: server.url,
        dispatcherModel: options.dispatcherModel,
      });
      return {
        transport,
        label: "sdk",
        dispose: () => {
          // Server is a singleton — don't close it here, it's shared.
          // It will be cleaned up on process exit.
        },
      };
    }
    log.warn("SDK available but server failed to start, falling back to subprocess");
  }

  const transport = new SubprocessTransport({
    spawner: options.spawner,
    engineName,
    dispatcherModel: options.dispatcherModel,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });
  return { transport, label: "cli", dispose: () => {} };
}

/**
 * Auto-detect — starts an OpenCode API server via the SDK, then creates
 * an SdkTransport pointed at it. Falls back to SubprocessTransport if
 * the SDK is unavailable or the server fails to start.
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
 * 1. If @opencode-ai/sdk is available, start an API server and use SdkTransport
 * 2. Otherwise, fall back to SubprocessTransport (spawns `opencode run`)
 */
export async function autoDetectTransport(
  options: AutoDetectOptions,
): Promise<ResolvedTransport> {
  if (SDK_AVAILABLE && _createOpencodeServer) {
    const server = await getOrStartServer(options.serverTimeoutMs ?? 10_000);
    if (server) {
      const transport = new SdkTransport({ baseUrl: server.url });
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

  const transport = new SubprocessTransport({ spawner: options.spawner });
  return { transport, label: "cli", dispose: () => {} };
}

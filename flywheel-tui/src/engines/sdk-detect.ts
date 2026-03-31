/**
 * SDK Availability Detection
 *
 * Detects whether the @opencode-ai/sdk package is available at runtime
 * and provides a shared SdkSpawner singleton for consumers that need
 * SDK-based streaming (dispatcher, evaluator).
 *
 * Extracted from dispatcher/auto-detect.ts so both dispatcher and evaluator
 * can depend on this without cross-subsystem imports.
 */

import type { ProcessSpawner } from "../worker/spawner";
import { Log } from "../utils/log";

// ---------------------------------------------------------------------------
// SDK availability detection
// ---------------------------------------------------------------------------

let _sdkAvailable = false;

try {
  const sdk = await import("@opencode-ai/sdk");
  if ("createOpencodeClient" in sdk) {
    _sdkAvailable = true;
  }
} catch {
  // SDK not available — that's fine
}

export const SDK_AVAILABLE: boolean = _sdkAvailable;

const log = Log.create({ service: "sdk-detect" });

// ---------------------------------------------------------------------------
// SdkSpawner singleton
// ---------------------------------------------------------------------------

// SdkSpawner singleton — shared across all sessions in the same process.
// Created once, reused until process exit.
let _sdkSpawner: ProcessSpawner & { dispose(): void } | null = null;
let _sdkSpawnerCreating: Promise<(ProcessSpawner & { dispose(): void }) | null> | null = null;

/**
 * Get or create the shared SdkSpawner instance.
 * Returns null if the SDK is not available or the spawner cannot be created.
 *
 * Shared singleton — used by both dispatcher and evaluator transports.
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
      log.info("SdkSpawner created (streaming mode)");
      return spawner;
    } catch (err) {
      log.warn("failed to create SdkSpawner", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      _sdkSpawnerCreating = null;
    }
  })();

  return _sdkSpawnerCreating;
}

/**
 * Auto-detect — tries SdkTransport first, falls back to CliTransport.
 *
 * Returns a ResolvedTransport with the chosen transport and a label for logging.
 */

import type { DispatcherTransport } from "./transport";
import type { ProcessSpawner } from "../worker/spawner";
import { SDK_AVAILABLE, SdkTransport } from "./sdk-transport";
import { CliTransport } from "./cli-transport";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedTransport {
  transport: DispatcherTransport;
  /** Which transport was selected: "sdk" or "cli" */
  label: "sdk" | "cli";
}

export interface AutoDetectOptions {
  spawner: ProcessSpawner;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Auto-detect the best available transport.
 *
 * 1. If @opencode-ai/sdk is available, use SdkTransport
 * 2. Otherwise, fall back to CliTransport
 *
 * Emits fallback warning to stderr if SDK is unavailable.
 */
export async function autoDetectTransport(
  options: AutoDetectOptions,
): Promise<ResolvedTransport> {
  if (SDK_AVAILABLE) {
    try {
      const transport = new SdkTransport();
      return { transport, label: "sdk" };
    } catch {
      // SDK constructor failed — fall through to CLI
      console.error(
        "[flywheel] SDK transport initialization failed, falling back to CLI transport",
      );
    }
  }

  const transport = new CliTransport({ spawner: options.spawner });
  return { transport, label: "cli" };
}

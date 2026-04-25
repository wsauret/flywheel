// loadStepMarkdown — reads a step's .md content at module load time.
//
// Primary path: filesystem read (works in dev + when running from source).
// Fallback: the build-binary manifest, which bundles .md files into the
// compiled standalone binary where the filesystem layout is lost.
// If both fail, throws with a message naming both locations.

import { readFileSync } from "node:fs";

import { errorMessage } from "../../../infra/error-message.js";
import { stepMarkdown } from "../../agents/manifest.js";

export function loadStepMarkdown(
  filePath: string,
  manifestKey: string,
  displayName: string,
): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch (fsErr) {
    if ((fsErr as NodeJS.ErrnoException).code !== "ENOENT") throw fsErr;
    const manifestValue = stepMarkdown[manifestKey];
    if (manifestValue !== undefined) return manifestValue;
    throw new Error(
      `Failed to load ${displayName}: filesystem path ${filePath} (${errorMessage(fsErr)}) and manifest key ${manifestKey} both missing.`,
    );
  }
}

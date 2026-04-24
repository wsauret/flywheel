// loadStepMarkdown — reads a step's .md content at module load time.
//
// Primary path: filesystem read (works in dev + when running from source).
// Fallback: the build-binary manifest, which bundles .md files into the
// compiled standalone binary where the filesystem layout is lost.
// If both fail, throws with a message naming both locations.

import { errorMessage } from "../../../infra/error-message.js";

export interface LoadStepMarkdownOptions {
  filePath: string;
  manifestKey: string;
  displayName: string;
  readFile: (filePath: string, encoding: "utf-8") => string;
  manifest: Record<string, string>;
}

export function loadStepMarkdown(options: LoadStepMarkdownOptions): string {
  const { filePath, manifestKey, displayName, readFile, manifest } = options;
  try {
    return readFile(filePath, "utf-8");
  } catch (fsErr) {
    const manifestValue = manifest[manifestKey];
    if (manifestValue !== undefined) return manifestValue;
    throw new Error(
      `Failed to load ${displayName}: filesystem path ${filePath} (${errorMessage(fsErr)}) and manifest key ${manifestKey} both missing.`,
    );
  }
}

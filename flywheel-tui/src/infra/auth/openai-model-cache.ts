import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { AUTH_DIR } from "../paths.js";

const MODELS_FILENAME = "openai-models.json";

function modelsPath(baseDir?: string): string {
  return path.join(baseDir ?? AUTH_DIR, MODELS_FILENAME);
}

export function loadCachedModels(baseDir?: string): ReadonlySet<string> | null {
  try {
    const raw = fs.readFileSync(modelsPath(baseDir), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((m): m is string => typeof m === "string")) return null;
    return new Set(parsed);
  } catch {
    return null;
  }
}

export function saveCachedModels(models: string[], baseDir?: string): void {
  const dir = baseDir ?? AUTH_DIR;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(modelsPath(baseDir), JSON.stringify(models), { mode: 0o600 });
}

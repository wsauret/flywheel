// readFileSync: tokens are <1KB and read synchronously at client construction
// time (once per runner start). Bun.file() is async-only for reads.
import * as fs from "node:fs";
import * as path from "node:path";
import { StoredTokensSchema, type StoredTokens } from "./openai-auth-types.js";
import { writeFileAtomic } from "../atomic-write.js";
import { AUTH_DIR } from "../paths.js";
import { Log } from "../log.js";

const log = Log.create({ service: "openai-token-store" });

const TOKEN_FILENAME = "openai.json";

function tokenPath(baseDir?: string): string {
  return path.join(baseDir ?? AUTH_DIR, TOKEN_FILENAME);
}

export function loadStoredTokens(baseDir?: string): StoredTokens | null {
  const filePath = tokenPath(baseDir);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const result = StoredTokensSchema.safeParse(parsed);
    if (!result.success) {
      log.warn("stored tokens failed validation", { path: filePath });
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

export function saveStoredTokens(tokens: StoredTokens, baseDir?: string): void {
  const dir = baseDir ?? AUTH_DIR;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = tokenPath(baseDir);
  writeFileAtomic(filePath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function deleteStoredTokens(baseDir?: string): void {
  const filePath = tokenPath(baseDir);
  try {
    fs.unlinkSync(filePath);
    log.info("deleted stored tokens", { path: filePath });
  } catch {
    // idempotent
  }
}

export function isTokenExpired(tokens: { expiresAtMs: number }, bufferMs = 60_000): boolean {
  return tokens.expiresAtMs - bufferMs < Date.now();
}

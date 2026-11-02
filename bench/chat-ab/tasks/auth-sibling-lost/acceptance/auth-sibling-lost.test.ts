import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Redacted } from "effect";
import { loginWithApiKey } from "../src/orchestration/auth/auth-actions.js";
import { fileTemporaryDirectory } from "../tests/helpers/directories.js";

// Account layout the locked store expects: an account home with the auth
// directory nested inside it.
const ACCOUNT_HOME = fileTemporaryDirectory("flywheel-test-auth-sibling-");
const AUTH_DIR = `${ACCOUNT_HOME}/.flywheel/auth`;

const resolveKey = async (value: string) => Redacted.make(value);
const settleCatalog = async (): Promise<void> => {};

interface JsonObject { [key: string]: unknown }

function authJsonPath(): string {
  return path.join(AUTH_DIR, "auth.json");
}

function writeStore(store: JsonObject): void {
  fs.writeFileSync(authJsonPath(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function readStore(): JsonObject {
  if (!fs.existsSync(authJsonPath())) return {};
  return JSON.parse(fs.readFileSync(authJsonPath(), "utf-8"));
}

describe("explicit API key login next to stored accounts", () => {
  beforeEach(() => {
    if (fs.existsSync(ACCOUNT_HOME)) fs.rmSync(ACCOUNT_HOME, { recursive: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(ACCOUNT_HOME)) fs.rmSync(ACCOUNT_HOME, { recursive: true });
  });

  it("still repairs a wholly rejected provider entry and preserves unknown siblings", async () => {
    writeStore({
      openai_api: { type: "api_key" },
      removed_provider: { arbitrary: "preserved" },
    });
    await loginWithApiKey("openai_api", "sk-valid-repair", AUTH_DIR, resolveKey, undefined, settleCatalog);
    expect(readStore()).toEqual({
      openai_api: expect.objectContaining({ type: "api_key", key: "sk-valid-repair" }),
      removed_provider: { arbitrary: "preserved" },
    });
  });

  it("never discards a healthy account when another account of the same provider is damaged", async () => {
    const healthy = { id: "healthy", identity: "Healthy", lineageId: crypto.randomUUID(), credential: { type: "api_key", key: "healthy-key" } };
    const damaged = { id: "damaged", identity: "Damaged", lineageId: crypto.randomUUID(), credential: { type: "api_key", key: 7 } };
    writeStore({
      openai_api: { type: "api_key", key: "sk-other" },
      opencode_go: [healthy, damaged],
    });
    const before = fs.readFileSync(authJsonPath());

    let failed = false;
    try {
      await loginWithApiKey("opencode_go", "new-key", AUTH_DIR, resolveKey, undefined, settleCatalog);
    } catch {
      failed = true;
    }

    // A refused login must leave the file exactly as it was.
    if (failed) expect(fs.readFileSync(authJsonPath())).toEqual(before);
    const stored = readStore();
    expect(stored.openai_api).toEqual({ type: "api_key", key: "sk-other" });
    const accounts = stored.opencode_go;
    expect(Array.isArray(accounts)).toBe(true);
    if (!Array.isArray(accounts)) return;
    expect(accounts).toContainEqual(healthy);
    expect(accounts).toContainEqual(damaged);
  });
});

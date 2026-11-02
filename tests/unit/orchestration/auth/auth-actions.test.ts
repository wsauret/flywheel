import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Schema } from "effect";
import { AuthSettlementConflictError, disconnectProviderInstance, getAuthStatus, loginWithApiKey, logoutProvider, reconnectWithApiKey, renameProviderInstance } from "../../../../src/orchestration/auth/auth-actions.js";
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js";
import { isCredentialCollection, MeteredCredentialRecordSchema, type CredentialInstance } from "../../../../src/infra/auth/auth-store-types.js";
import { loadAuthStoreWithDiagnostics } from "../../../../src/infra/auth/auth-store.js";
import { apiKey } from "../../../../src/infra/auth/auth-context.js";
import { fileTemporaryDirectory } from "../../../helpers/directories.js";
import { refusingLauncher } from "../../../helpers/launcher-fake.js";

// Account layout the locked store expects: an account home with the auth
// directory nested inside it.
const ACCOUNT_HOME = fileTemporaryDirectory("flywheel-test-auth-actions-");
const AUTH_DIR = `${ACCOUNT_HOME}/.flywheel/auth`;
const TEST_DIR = AUTH_DIR;

const resolveKey = async (value: string) => (await import("effect")).Redacted.make(value);
const settleCatalog = async (): Promise<void> => {};

function ensureCleanDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function authJsonPath(dir: string): string {
  return path.join(dir, "auth.json");
}

interface JsonObject { [key: string]: unknown }
function writeStore(dir: string, store: JsonObject): void {
  fs.writeFileSync(authJsonPath(dir), JSON.stringify(store, null, 2), { mode: 0o600 });
}

function readStore(dir: string): JsonObject {
  const p = authJsonPath(dir);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function subscriptionInstances(providerId: string): readonly CredentialInstance[] {
  const credentials = loadAuthStoreWithDiagnostics(AUTH_DIR).store[providerId];
  if (!isCredentialCollection(credentials)) throw new Error(`expected ${providerId} accounts`);
  return credentials;
}

describe("auth-actions", () => {
  beforeEach(() => {
    ensureCleanDir(ACCOUNT_HOME);
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(ACCOUNT_HOME)) fs.rmSync(ACCOUNT_HOME, { recursive: true });
  });

  it("stores api_key credential and reads it back", () => {
    writeStore(TEST_DIR, { anthropic_api: { type: "api_key", key: "test-key" } });
    const store = readStore(TEST_DIR);
    const value = store.anthropic_api;
    if (typeof value !== "object" || value === null || !("type" in value) || !("key" in value)) throw new Error("expected API key credential");
    expect(value.type).toBe("api_key");
    expect(value.key).toBe("test-key");
  });

  it("writes through manager-issued access after the profile display name changes", async () => {
    const manager = new AuthProfileManager({ userDataRoot: ACCOUNT_HOME, projectRoot: ACCOUNT_HOME, env: {} });
    await manager.create("Work");
    await manager.select("work");
    const access = await manager.acquireAccess();
    const capturedDirectory = (await manager.resolve()).directory;

    await manager.rename("work", "Renamed");
    const settlementOrder: string[] = [];
    await loginWithApiKey("anthropic_api", "profile-key", capturedDirectory, resolveKey, access, async (account, directory) => {
      settlementOrder.push(`${account.providerId}:${String(readStore(directory).anthropic_api !== undefined)}`);
    });
    access.close();

    expect(readStore(path.join(ACCOUNT_HOME, "auth", "profiles", "work"))).toEqual({
      anthropic_api: { type: "api_key", key: "profile-key", lineageId: expect.any(String) },
    });
    expect(fs.existsSync(path.join(ACCOUNT_HOME, "auth", "profiles", "work"))).toBe(true);
    expect(settlementOrder).toEqual(["anthropic_api:true"]);
  });

  it("mints a new opaque lineage on every direct credential login", async () => {
    await loginWithApiKey("anthropic_api", "first-key", AUTH_DIR, resolveKey, undefined, settleCatalog);
    const first = Schema.decodeUnknownSync(MeteredCredentialRecordSchema)(readStore(AUTH_DIR).anthropic_api);
    await loginWithApiKey("anthropic_api", "second-key", AUTH_DIR, resolveKey, undefined, settleCatalog);
    const second = Schema.decodeUnknownSync(MeteredCredentialRecordSchema)(readStore(AUTH_DIR).anthropic_api);
    expect(first.lineageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.lineageId).not.toBe(first.lineageId);
    expect(second).toEqual({ type: "api_key", key: "second-key", lineageId: expect.any(String) });
  });

  it("restores the old direct key when catalog settlement rejects", async () => {
    await loginWithApiKey("anthropic_api", "first-key", AUTH_DIR, resolveKey, undefined, settleCatalog);
    const before = Schema.decodeUnknownSync(MeteredCredentialRecordSchema)(readStore(AUTH_DIR).anthropic_api);

    await expect(loginWithApiKey("anthropic_api", "second-key", AUTH_DIR, resolveKey, undefined, async () => {
      throw new Error("catalog rejected");
    })).rejects.toThrow("catalog rejected");

    expect(Schema.decodeUnknownSync(MeteredCredentialRecordSchema)(readStore(AUTH_DIR).anthropic_api)).toEqual({
      type: "api_key",
      key: "first-key",
      lineageId: before.lineageId,
    });
  });

  it("removes a new direct key when catalog settlement rejects", async () => {
    await expect(loginWithApiKey("anthropic_api", "first-key", AUTH_DIR, resolveKey, undefined, async () => {
      throw new Error("catalog rejected");
    })).rejects.toThrow("catalog rejected");

    expect(readStore(AUTH_DIR).anthropic_api).toBeUndefined();
  });

  it("preserves a same-secret concurrent login with a new lineage", async () => {
    const failed = loginWithApiKey("anthropic_api", "same-key", AUTH_DIR, resolveKey, undefined, async () => {
      await loginWithApiKey("anthropic_api", "same-key", AUTH_DIR, resolveKey, undefined, settleCatalog);
      throw new Error("catalog rejected");
    });

    await expect(failed).rejects.toBeInstanceOf(AuthSettlementConflictError);
    expect(Schema.decodeUnknownSync(MeteredCredentialRecordSchema)(readStore(AUTH_DIR).anthropic_api)).toMatchObject({
      key: "same-key",
      lineageId: expect.any(String),
    });
  });

  it("removes only the appended subscription when catalog settlement rejects", async () => {
    await expect(loginWithApiKey("opencode_go", "new-key", AUTH_DIR, resolveKey, undefined, async () => {
      throw new Error("catalog rejected");
    })).rejects.toThrow("catalog rejected");

    expect(readStore(AUTH_DIR).opencode_go).toBeUndefined();
  });

  it("appends OpenCode Go accounts using the resolved key tail without storing the resolved value", async () => {
    const resolveCalls: string[] = [];
    const command = "!security find-generic-password -w -s go-api-key";
    await loginWithApiKey("opencode_go", command, AUTH_DIR, async (value) => {
      resolveCalls.push(value);
      return (await import("effect")).Redacted.make("resolved-secret-1234");
    }, undefined, settleCatalog);

    const instances = readStore(AUTH_DIR).opencode_go;
    expect(resolveCalls).toEqual([command]);
    expect(instances).toEqual([expect.objectContaining({ identity: "••••1234", credential: { type: "api_key", key: command } })]);
  });

  it("settles a new subscription credential against its canonical exact account", async () => {
    let settledAccount: unknown
    await loginWithApiKey("opencode_go", "secret-tail", AUTH_DIR, resolveKey, undefined, async (account) => {
      settledAccount = account
    })
    const [instance] = subscriptionInstances("opencode_go")
    expect(settledAccount).toEqual({ kind: "subscription", providerId: "opencode_go", instanceId: instance?.id })
  })

  it("writes nothing when an OpenCode Go credential cannot resolve", async () => {
    await expect(loginWithApiKey("opencode_go", "!missing", AUTH_DIR, async () => undefined, undefined, settleCatalog)).rejects.toThrow("could not be resolved");
    expect(readStore(AUTH_DIR).opencode_go).toBeUndefined();
  });

  it("repairs a rejected provider without replacing a damaged account collection", async () => {
    writeStore(AUTH_DIR, {
      openai_api: { type: "api_key" },
      removed_provider: { arbitrary: "preserved" },
    });
    await loginWithApiKey("openai_api", "sk-valid-repair", AUTH_DIR, resolveKey, undefined, settleCatalog);
    expect(readStore(AUTH_DIR)).toEqual({
      openai_api: expect.objectContaining({ type: "api_key", key: "sk-valid-repair" }),
      removed_provider: { arbitrary: "preserved" },
    });

    writeStore(AUTH_DIR, {
      ...readStore(AUTH_DIR),
      opencode_go: [
        { id: "healthy", identity: "Healthy", lineageId: crypto.randomUUID(), credential: { type: "api_key", key: "healthy-key" } },
        { id: "damaged", identity: "Damaged", lineageId: crypto.randomUUID(), credential: { type: "api_key", key: 7 } },
      ],
    });
    const before = fs.readFileSync(authJsonPath(AUTH_DIR));
    await expect(loginWithApiKey("opencode_go", "new-key", AUTH_DIR, resolveKey, undefined, settleCatalog))
      .rejects.toThrow("Cannot update auth.json");
    expect(fs.readFileSync(authJsonPath(AUTH_DIR))).toEqual(before);
  });

  it("reconnects an OpenCode Go instance without exposing its expected credential", async () => {
    await loginWithApiKey("opencode_go", "first-1234", AUTH_DIR, resolveKey, undefined, settleCatalog);
    const first = subscriptionInstances("opencode_go")[0];
    if (!first) throw new Error("expected OpenCode Go account");
    await renameProviderInstance("opencode_go", first.id, "Work", AUTH_DIR);

    expect(await reconnectWithApiKey("opencode_go", first.id, "next-5678", AUTH_DIR, resolveKey, settleCatalog)).toBe(true);
    expect(subscriptionInstances("opencode_go")[0]).toEqual({
      id: first.id,
      identity: first.identity,
      label: "Work",
      lineageId: expect.any(String),
      credential: { type: "api_key", key: "next-5678" },
    });
  });

  it("does not recreate an OpenCode Go instance deleted during reconnect", async () => {
    await loginWithApiKey("opencode_go", "first-1234", AUTH_DIR, resolveKey, undefined, settleCatalog);
    const first = subscriptionInstances("opencode_go")[0];
    if (!first) throw new Error("expected OpenCode Go account");
    let finishResolution: ((value: Awaited<ReturnType<typeof resolveKey>>) => void) | undefined;
    const reconnect = reconnectWithApiKey("opencode_go", first.id, "next-5678", AUTH_DIR, () => new Promise((resolve) => { finishResolution = resolve; }), settleCatalog);
    await Promise.resolve();
    await disconnectProviderInstance("opencode_go", first.id, AUTH_DIR, { launcher: refusingLauncher });
    finishResolution?.((await import("effect")).Redacted.make("next-5678"));

    expect(await reconnect).toBe(false);
    expect(readStore(AUTH_DIR).opencode_go).toEqual([]);
  });

  describe("web search providers", () => {
    it("reports exa as unconfigured when nothing is stored, even with EXA_API_KEY exported", () => {
      const original = process.env.EXA_API_KEY;
      process.env.EXA_API_KEY = "exa_0123456789abcdef";
      try {
        const statuses = getAuthStatus(AUTH_DIR);
        const exa = statuses.find((s) => s.providerId === "exa");
        expect(exa?.source).toBe("unconfigured");
      } finally {
        if (original === undefined) delete process.env.EXA_API_KEY;
        else process.env.EXA_API_KEY = original;
      }
    });

    it("stores an exa key through loginWithApiKey and reports stored_key", async () => {
      const auth = await loginWithApiKey("exa", "exa_stored", AUTH_DIR, resolveKey, undefined, settleCatalog);
      expect(apiKey(auth, "exa")).toBeDefined();
      const exa = getAuthStatus(AUTH_DIR).find((s) => s.providerId === "exa");
      expect(exa?.source).toBe("stored_key");
    });

    it("logout removes the stored exa key and falls back to unconfigured", async () => {
      await loginWithApiKey("exa", "exa_stored", AUTH_DIR, resolveKey, undefined, settleCatalog);
      await logoutProvider("exa", AUTH_DIR, resolveKey, { launcher: refusingLauncher });
      const exa = getAuthStatus(AUTH_DIR).find((s) => s.providerId === "exa");
      expect(exa?.source).toBe("unconfigured");
    });
  });

  describe("getAuthStatus", () => {
    it("names a stored key by its masked tail and a helper by its indirection", () => {
      writeStore(TEST_DIR, { anthropic_api: { type: "api_key", key: "sk-ant-abcd1234wxyz" }, openrouter: { type: "api_key", key: "!op read op://vault/openrouter" } });
      const statuses = getAuthStatus(AUTH_DIR);
      expect(statuses.find((s) => s.providerId === "anthropic_api")).toEqual(expect.objectContaining({ source: "stored_key", keyHint: "••••wxyz" }));
      expect(statuses.find((s) => s.providerId === "openrouter")).toEqual(expect.objectContaining({ source: "stored_key", keyHint: "!command" }));
      expect(statuses.find((s) => s.providerId === "openai_api")?.keyHint).toBeUndefined();
    });

  });
});

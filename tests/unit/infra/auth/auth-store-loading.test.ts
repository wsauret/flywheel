import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authStoreObservationKey, authStoreObservedRevision, getCredential, loadAuthStoreWithDiagnostics, storedApiKeyHint } from "../../../../src/infra/auth/auth-store.js";
import type { Credential } from "../../../../src/infra/auth/auth-store-types.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const slots = (providerId: string): "subscription" | "metered" => providerId === "chatgpt" ? "subscription" : "metered";
const temporaryDirectory = temporaryDirectories();
const makeTmpDir = (): string => temporaryDirectory("auth-store-loading-test-");
const authJsonPath = (dir: string): string => join(dir, "auth.json");
function writeAuthJson(dir: string, data: { [key: string]: unknown }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(authJsonPath(dir), JSON.stringify(data, null, 2), "utf-8");
}
const metered = (credential: Credential) => ({ lineageId: crypto.randomUUID(), credential });

describe("loadAuthStore", () => {
  test("names a metered key by its masked tail and a helper by its indirection", () => {
    const store = {
      anthropic_api: { type: "api_key" as const, key: "sk-ant-abcd1234wxyz" },
      openrouter: { type: "api_key" as const, key: "!op read op://vault/openrouter" },
      chatgpt: [{ id: "one", identity: "me@example.com", credential: { type: "oauth" as const, access: "a", expires: 1 } }],
    };
    expect(storedApiKeyHint(store, "anthropic_api")).toBe("••••wxyz");
    expect(storedApiKeyHint(store, "openrouter")).toBe("!command");
    expect(storedApiKeyHint(store, "chatgpt")).toBeUndefined();
    expect(storedApiKeyHint(store, "exa")).toBeUndefined();
  });

  test("returns empty store when auth.json does not exist", () => {
    expect(loadAuthStoreWithDiagnostics(makeTmpDir()).store).toEqual({});
  });

  test("returns parsed store when auth.json contains valid data", () => {
    const dir = makeTmpDir();
    const data = {
      anthropic_api: { type: "api_key", key: "test-key" },
      github_copilot: { type: "oauth", access: "cop", refresh: "gh", expires: 999 },
    } satisfies { [providerId: string]: Credential };
    writeAuthJson(dir, Object.fromEntries(Object.entries(data).map(([id, credential]) => [id, metered(credential)])));
    expect(loadAuthStoreWithDiagnostics(dir).store).toEqual(data);
  });

  test("returns empty store and does not throw on invalid JSON", () => {
    const dir = makeTmpDir();
    writeFileSync(authJsonPath(dir), "not json{{{", "utf-8");
    const result = loadAuthStoreWithDiagnostics(dir);
    expect(result.store).toEqual({});
    expect(result.conditions).toEqual([{ kind: "malformed", scope: "file", authDirectory: dir, path: authJsonPath(dir), revision: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  });

  test("reports unknown providers without loading their credentials", () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, {
      openai_api: metered({ type: "api_key", key: "known-secret" }),
      removed_provider: metered({ type: "api_key", key: "removed-secret" }),
    });
    const result = loadAuthStoreWithDiagnostics(dir, ["openai_api"]);
    expect(result.store).toEqual({ openai_api: { type: "api_key", key: "known-secret" } });
    expect(result.diagnostics).toEqual([{
      kind: "unknown_provider",
      providerId: "removed_provider",
      message: 'Credential provider "removed_provider" is not installed. Remove its entry from auth.json.',
    }]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("removed-secret");
  });

  test("reports non-object JSON with a file revision and secret-safe diagnostics", () => {
    const dir = makeTmpDir();
    writeFileSync(authJsonPath(dir), JSON.stringify("do-not-report"), "utf-8");
    const result = loadAuthStoreWithDiagnostics(dir);
    expect(result.store).toEqual({});
    expect(result.conditions).toEqual([{
      kind: "malformed",
      scope: "file",
      authDirectory: dir,
      path: authJsonPath(dir),
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(JSON.stringify(result)).not.toContain("do-not-report");
  });

  test("recovers from an oversized auth file without reading or changing it", () => {
    const dir = makeTmpDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(authJsonPath(dir), Buffer.alloc(16 * 1024 * 1024 + 1, 97));
    const result = loadAuthStoreWithDiagnostics(dir);
    expect(result.store).toEqual({});
    expect(result.conditions).toEqual([{
      kind: "refused",
      category: "oversized",
      scope: "file",
      authDirectory: dir,
      path: authJsonPath(dir),
    }]);
    expect(statSync(authJsonPath(dir)).size).toBe(16 * 1024 * 1024 + 1);
  });

  test("salvages valid credentials and reports rejected providers", () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { anthropic_api: { type: "api_key" }, openai_api: metered({ type: "api_key", key: "sk-oai" }), chatgpt: { type: "oauth", access: "token" } });
    const result = loadAuthStoreWithDiagnostics(dir);
    expect(result.store.openai_api).toEqual({ type: "api_key", key: "sk-oai" });
    expect(result.dropped).toEqual(["anthropic_api", "chatgpt"]);
    expect(result.conditions.map((condition) => condition.kind)).toEqual(["malformed", "malformed"]);
  });

  test("reports an unsafe contained path without exposing its target", () => {
    const root = makeTmpDir();
    const outside = join(root, "outside");
    const dir = join(root, "profile");
    mkdirSync(outside);
    symlinkSync(outside, dir);
    const refused = loadAuthStoreWithDiagnostics(dir);
    expect(refused.conditions).toEqual([{ kind: "refused", category: "unsafe_path", scope: "file", authDirectory: dir, path: authJsonPath(dir) }]);
    expect(JSON.stringify(refused.conditions)).not.toContain(outside);
    expect(existsSync(join(outside, "auth.json"))).toBe(false);
    unlinkSync(dir);
    mkdirSync(dir);
    expect(loadAuthStoreWithDiagnostics(dir).conditions).toEqual([]);
  });

  test("states the identity a full load observes, without decoding the store, for every file state", () => {
    const identity = (dir: string) => {
      const load = loadAuthStoreWithDiagnostics(dir, undefined, undefined, false);
      return load.conditions.some((condition) => condition.kind === "refused") ? authStoreObservationKey(load) : load.revision;
    };
    const absent = makeTmpDir();
    const valid = makeTmpDir();
    writeAuthJson(valid, { openai_api: metered({ type: "api_key", key: "sk-oai" }), anthropic_api: { type: "api_key" } });
    const malformed = makeTmpDir();
    writeFileSync(authJsonPath(malformed), "{");
    const oversized = makeTmpDir();
    writeFileSync(authJsonPath(oversized), Buffer.alloc(16 * 1024 * 1024 + 1, 97));
    const root = makeTmpDir();
    mkdirSync(join(root, "outside"));
    const unsafe = join(root, "profile");
    symlinkSync(join(root, "outside"), unsafe);
    const states = [absent, valid, malformed, oversized, unsafe];
    for (const dir of states) expect(authStoreObservedRevision(dir)).toBe(identity(dir));
    // A refused file never shares an identity with a missing one.
    expect(new Set(states.map(authStoreObservedRevision)).size).toBe(states.length);
    unlinkSync(unsafe);
  });

  test("reads a credential from an existing provider", () => {
    const dir = makeTmpDir();
    const credential = { type: "api_key" as const, key: "sk-x" };
    writeAuthJson(dir, { anthropic_api: metered(credential) });
    expect(getCredential("anthropic_api", dir)).toEqual(credential);
    expect(getCredential("missing", dir)).toBeUndefined();
  });

  test("excludes legacy instances", () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { chatgpt: [{ id: "legacy", identity: "legacy", credential: { type: "oauth", access: "old", expires: 1 } }] });
    expect(loadAuthStoreWithDiagnostics(dir, undefined, slots).store.chatgpt).toEqual([]);
  });
});

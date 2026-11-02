import { describe, expect, test } from "bun:test";
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStoreMutationError,
  appendCredentialInstance,
  appendCredentialInstanceWithReceipt,
  deleteCredential,
  deleteCredentialInstance,
  ensureCredentialLineages,
  renameCredentialInstance,
  replaceCredentialInstanceWithReceipt,
  rollbackAuthStoreMutation,
  replaceCredential,
  replaceCredentialInstance,
  setCredential,
  setMeteredCredential,
  setMeteredCredentialWithReceipt,
} from "../../../../src/infra/auth/auth-store-mutations.js";
import { getCredential, loadAuthStoreWithDiagnostics } from "../../../../src/infra/auth/auth-store.js";
import type { Credential } from "../../../../src/infra/auth/auth-store-types.js";
import { AuthProfileDirectoryNotFoundError, openExistingAuthProfileDirectory } from "../../../../src/infra/auth/auth-profile-store.js";
import { temporaryDirectories } from "../../../helpers/directories.js";


const slots = (providerId: string): "subscription" | "metered" =>
  providerId === "chatgpt" ? "subscription" : "metered";
const temporaryDirectory = temporaryDirectories();
// A mutation creates `profile-locks` beside the profile directory, so the
// profile directory is one level inside the temporary directory that the
// cleanup removes.
function makeTmpDir(): string {
  const dir = join(temporaryDirectory("auth-store-test-"), "profile");
  mkdirSync(dir);
  return dir;
}

function authJsonPath(dir: string): string {
  return join(dir, "auth.json");
}

function writeAuthJson(dir: string, data: { [key: string]: unknown }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(authJsonPath(dir), JSON.stringify(data, null, 2), "utf-8");
}

function metered(credential: Credential) {
  return { lineageId: crypto.randomUUID(), credential };
}

describe("strict auth mutation", () => {
  test("reports safe typed conditions through pre-opened profile access", async () => {
    const dir = makeTmpDir();
    const malformed = '{"anthropic_api":{"key":"do-not-report"}';
    mkdirSync(dir, { recursive: true });
    writeFileSync(authJsonPath(dir), malformed);
    const access = openExistingAuthProfileDirectory(dir);

    try {
      const malformedFailure = await setCredential("openai_api", { type: "api_key", key: "new-secret" }, access).catch((error) => error);
      expect(malformedFailure).toBeInstanceOf(AuthStoreMutationError);
      expect(malformedFailure.conditions).toEqual([{
        kind: "malformed",
        scope: "file",
        authDirectory: dir,
        path: authJsonPath(dir),
        revision: expect.any(String),
      }]);
      expect(JSON.stringify(malformedFailure)).not.toContain("do-not-report");
      expect(readFileSync(authJsonPath(dir), "utf-8")).toBe(malformed);

      writeAuthJson(dir, { anthropic_api: { type: "api_key" } });
      const partial = readFileSync(authJsonPath(dir), "utf-8");
      const partialFailure = await setCredential("google_api", { type: "api_key", key: "new-secret" }, access).catch((error) => error);
      expect(partialFailure).toBeInstanceOf(AuthStoreMutationError);
      expect(partialFailure.conditions).toEqual([{
        kind: "malformed",
        scope: "provider",
        providerId: "anthropic_api",
        authDirectory: dir,
        revision: expect.any(String),
      }]);
      expect(readFileSync(authJsonPath(dir), "utf-8")).toBe(partial);

      writeFileSync(authJsonPath(dir), Buffer.alloc(16 * 1024 * 1024 + 1, 97));
      const oversizedFailure = await setCredential("google_api", { type: "api_key", key: "new-secret" }, access).catch((error) => error);
      expect(oversizedFailure).toBeInstanceOf(AuthStoreMutationError);
      expect(oversizedFailure.conditions).toEqual([{
        kind: "refused",
        category: "oversized",
        scope: "file",
        authDirectory: dir,
        path: authJsonPath(dir),
      }]);
      expect(statSync(authJsonPath(dir)).size).toBe(16 * 1024 * 1024 + 1);
    } finally {
      access.close();
    }
  });

  test("preserves malformed bytes and rejects the write with the safe typed condition", async () => {
    const dir = makeTmpDir();
    const malformed = '{"anthropic_api":{"key":"do-not-report"}';
    mkdirSync(dir, { recursive: true });
    writeFileSync(authJsonPath(dir), malformed);

    const failure = await setCredential("openai_api", { type: "api_key", key: "new-secret" }, dir).catch((error) => error);

    expect(failure).toBeInstanceOf(AuthStoreMutationError);
    expect(failure.conditions).toEqual([{ kind: "malformed", scope: "file", authDirectory: dir, path: authJsonPath(dir), revision: expect.any(String) }]);
    expect(JSON.stringify(failure)).not.toContain("do-not-report");
    expect(readFileSync(authJsonPath(dir), "utf-8")).toBe(malformed);
    unlinkSync(authJsonPath(dir));
    await expect(setCredential("openai_api", { type: "api_key", key: "recovered" }, dir)).resolves.toBeUndefined();
  });

  test("rejects an unsafe path with a secret-free typed condition", async () => {
    const root = makeTmpDir();
    const outside = join(root, "outside");
    const dir = join(root, "profile");
    mkdirSync(outside);
    symlinkSync(outside, dir);
    const failure = await setCredential("openai_api", { type: "api_key", key: "new-secret" }, dir).catch((error) => error);
    expect(failure).toBeInstanceOf(AuthStoreMutationError);
    expect(failure.conditions).toEqual([{
      kind: "refused",
      category: "unsafe_path",
      scope: "file",
      authDirectory: dir,
      path: authJsonPath(dir),
    }]);
    expect(JSON.stringify(failure)).not.toContain(outside);
    expect(existsSync(join(outside, "auth.json"))).toBe(false);
  });
});

describe("subscription credential collections", () => {
  test("preserves lineage across refresh and rename, renews it on reconnect, and restores it on rollback", async () => {
    const dir = makeTmpDir();
    const original = { type: "oauth" as const, access: "first", expires: 1 };
    const appendReceipt = await appendCredentialInstanceWithReceipt("chatgpt", { id: "account", identity: "person", credential: original }, dir, slots);
    const first = JSON.parse(readFileSync(authJsonPath(dir), "utf8")).chatgpt[0];

    await replaceCredentialInstance("chatgpt", "account", original, { type: "oauth", access: "refreshed", expires: 2 }, dir, slots);
    await renameCredentialInstance("chatgpt", "account", "Primary", dir, slots);
    const refreshed = JSON.parse(readFileSync(authJsonPath(dir), "utf8")).chatgpt[0];
    expect(refreshed.lineageId).toBe(first.lineageId);

    const reconnect = await replaceCredentialInstanceWithReceipt("chatgpt", "account", refreshed.credential, { type: "oauth", access: "reconnected", expires: 3 }, dir, slots, undefined, "new-person");
    expect(reconnect).toBeDefined();
    const reconnected = JSON.parse(readFileSync(authJsonPath(dir), "utf8")).chatgpt[0];
    expect(reconnected.lineageId).not.toBe(first.lineageId);
    expect(await rollbackAuthStoreMutation(reconnect!, dir, slots)).toBe(true);
    expect(JSON.parse(readFileSync(authJsonPath(dir), "utf8")).chatgpt[0]).toEqual(refreshed);
    expect(appendReceipt.before).toBeUndefined();
  });

  test("rolls back when persisted entry keys have equivalent ordering", async () => {
    const dir = makeTmpDir();
    const receipt = await appendCredentialInstanceWithReceipt("chatgpt", {
      id: "account",
      identity: "person",
      label: "Primary",
      credential: { type: "oauth", access: "access", refresh: "refresh", expires: 1 },
    }, dir, slots);
    const persisted = JSON.parse(readFileSync(authJsonPath(dir), "utf8"));
    const instance = persisted.chatgpt[0];
    persisted.chatgpt[0] = {
      credential: { expires: instance.credential.expires, refresh: instance.credential.refresh, access: instance.credential.access, type: instance.credential.type },
      lineageId: instance.lineageId,
      label: instance.label,
      identity: instance.identity,
      id: instance.id,
    };
    writeAuthJson(dir, persisted);

    expect(await rollbackAuthStoreMutation(receipt, dir, slots)).toBe(true);
    expect(JSON.parse(readFileSync(authJsonPath(dir), "utf8")).chatgpt).toBeUndefined();
  });

  test("restores the exact metered entry after a failed replacement", async () => {
    const dir = makeTmpDir();
    await setMeteredCredential("anthropic_api", { type: "oauth", access: "old", refresh: "old-refresh", expires: 1, accountId: "old-account" }, dir, slots);
    const before = JSON.parse(readFileSync(authJsonPath(dir), "utf8")).anthropic_api;
    const receipt = await setMeteredCredentialWithReceipt("anthropic_api", { type: "api_key", key: "replacement" }, dir, slots);

    expect(await rollbackAuthStoreMutation(receipt, dir, slots)).toBe(true);
    expect(JSON.parse(readFileSync(authJsonPath(dir), "utf8")).anthropic_api).toEqual(before);
  });

  test("normalizes legacy subscription lineage once and keeps it stable", async () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { chatgpt: [{ id: "account", identity: "person", credential: { type: "oauth", access: "old", expires: 1 } }] });
    await ensureCredentialLineages(dir, slots);
    const first = JSON.parse(readFileSync(authJsonPath(dir), "utf8")).chatgpt[0].lineageId;
    await ensureCredentialLineages(dir, slots);
    expect(JSON.parse(readFileSync(authJsonPath(dir), "utf8")).chatgpt[0].lineageId).toBe(first);
  });
  test("rejects a scalar credential in a subscription slot", () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { chatgpt: { type: "oauth", access: "secret", expires: 1 } });
    const loaded = loadAuthStoreWithDiagnostics(dir, undefined, slots);
    expect(loaded.store.chatgpt).toBeUndefined();
    expect(loaded.dropped).toEqual(["chatgpt"]);
  });

  test("salvages valid members with provider and index diagnostics", () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { chatgpt: [
      { id: "b", identity: "b@example.com", credential: { type: "oauth", access: "b", expires: 2 } },
      { id: "broken", identity: "bad" },
      { id: "a", identity: "a@example.com", credential: { type: "oauth", access: "a", expires: 1 } },
    ] });
    const result = loadAuthStoreWithDiagnostics(dir, undefined, slots);
    expect(result.store.chatgpt).toEqual([
      { id: "a", identity: "a@example.com", credential: { type: "oauth", access: "a", expires: 1 } },
      { id: "b", identity: "b@example.com", credential: { type: "oauth", access: "b", expires: 2 } },
    ]);
    expect(result.diagnostics[0]).toMatchObject({ kind: "invalid_instance", providerId: "chatgpt", index: 1 });
  });

  test("rejects an invalid collection before appending a credential", async () => {
    const dir = makeTmpDir();
    const invalid = JSON.stringify({ chatgpt: [
      { id: "bad" },
      { id: "existing", identity: "existing@example.com", credential: { type: "oauth", access: "existing", expires: 1 } },
    ] });
    writeFileSync(authJsonPath(dir), invalid);

    await expect(appendCredentialInstance("chatgpt", {
      id: "new", identity: "new@example.com", credential: { type: "oauth", access: "new", expires: 2 },
    }, dir, slots)).rejects.toThrow();
    expect(readFileSync(authJsonPath(dir), "utf8")).toBe(invalid);
  });

  test("mutates exact credential instances without clearing profile-wide catalog files", async () => {
    const dir = makeTmpDir();
    const original = { type: "oauth" as const, access: "a", expires: 1 };
    await appendCredentialInstance("chatgpt", { id: "b", identity: "b@example.com", credential: original }, dir, slots);
    writeFileSync(join(dir, "provider-model-catalogs.json"), "unrelated-candidate-catalogs");
    await appendCredentialInstance("chatgpt", { id: "a", identity: "a@example.com", credential: original }, dir, slots);
    expect(readFileSync(join(dir, "provider-model-catalogs.json"), "utf8")).toBe("unrelated-candidate-catalogs");
    expect(JSON.parse(readFileSync(authJsonPath(dir), "utf8")).chatgpt.map((item: { id: string }) => item.id)).toEqual(["a", "b"]);
    await renameCredentialInstance("chatgpt", "a", "Primary", dir, slots);
    expect(await replaceCredentialInstance("chatgpt", "a", original, { type: "oauth", access: "next", expires: 2 }, dir, slots)).toBe(true);
    expect(readFileSync(join(dir, "provider-model-catalogs.json"), "utf8")).toBe("unrelated-candidate-catalogs");
    expect(await replaceCredentialInstance("chatgpt", "a", original, original, dir, slots)).toBe(false);
    await deleteCredentialInstance("chatgpt", "b", dir, slots);
    expect(readFileSync(join(dir, "provider-model-catalogs.json"), "utf8")).toBe("unrelated-candidate-catalogs");
    expect(loadAuthStoreWithDiagnostics(dir, undefined, slots).store.chatgpt).toEqual([{
      id: "a", identity: "a@example.com", label: "Primary", lineageId: expect.any(String), credential: { type: "oauth", access: "next", expires: 2 },
    }]);
  });

  test("a failed instance CAS does not recreate a deleted provider", async () => {
    const dir = makeTmpDir();
    expect(await replaceCredentialInstance("chatgpt", "missing", { type: "oauth", access: "old", expires: 1 }, { type: "oauth", access: "new", expires: 2 }, dir, slots)).toBe(false);
    expect(loadAuthStoreWithDiagnostics(dir, undefined, slots).store.chatgpt).toBeUndefined();
  });

  test("replaces an account identity in the same credential CAS", async () => {
    const dir = makeTmpDir();
    const original = { type: "oauth" as const, access: "old", expires: 1 };
    await appendCredentialInstance("chatgpt", { id: "account", identity: "ChatGPT account", credential: original }, dir, slots);

    expect(await replaceCredentialInstance("chatgpt", "account", original, { type: "oauth", access: "new", expires: 2 }, dir, slots, undefined, "alice")).toBe(true);
    expect(loadAuthStoreWithDiagnostics(dir, undefined, slots).store.chatgpt).toEqual([{
      id: "account", identity: "alice", lineageId: expect.any(String), credential: { type: "oauth", access: "new", expires: 2 },
    }]);
  });

  test("rejects an identity collision without changing the collection", async () => {
    const dir = makeTmpDir();
    const original = { type: "oauth" as const, access: "old", expires: 1 };
    await appendCredentialInstance("chatgpt", { id: "a", identity: "a@example.com", credential: original }, dir, slots);
    await appendCredentialInstance("chatgpt", { id: "b", identity: "b@example.com", credential: original }, dir, slots);

    await expect(replaceCredentialInstance("chatgpt", "a", original, { type: "oauth", access: "new", expires: 2 }, dir, slots, undefined, "b@example.com")).rejects.toThrow("already exists");
    expect(loadAuthStoreWithDiagnostics(dir, undefined, slots).store.chatgpt).toEqual([
      { id: "a", identity: "a@example.com", lineageId: expect.any(String), credential: original },
      { id: "b", identity: "b@example.com", lineageId: expect.any(String), credential: original },
    ]);
  });

  test("reads valid credential collections larger than the generic JSON-store limit", () => {
    const dir = makeTmpDir();
    const chatgpt = Array.from({ length: 200 }, (_, index) => ({
      id: `account-${index}`,
      identity: `account-${index}@example.com`,
      credential: { type: "oauth", access: `${index}-${"a".repeat(6_000)}`, expires: Date.now() + 60_000 },
    }));
    writeAuthJson(dir, { chatgpt });
    expect(loadAuthStoreWithDiagnostics(dir, undefined, slots).store.chatgpt).toHaveLength(200);
  });
});

describe("legacy credential instance reset", () => {
  test("excludes a legacy instance silently and keeps collection-based accounts", () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { chatgpt: [
      { id: "legacy", identity: "legacy", credential: { type: "oauth", access: "old", expires: 1 } },
      { id: "account", identity: "a@example.com", credential: { type: "oauth", access: "a", expires: 2 } },
    ] });
    const result = loadAuthStoreWithDiagnostics(dir, undefined, slots);
    expect(result.store.chatgpt).toEqual([
      { id: "account", identity: "a@example.com", credential: { type: "oauth", access: "a", expires: 2 } },
    ]);
    expect(result.dropped).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("excludes a legacy instance on the whole-store schema fast path", () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { chatgpt: [
      { id: "legacy", identity: "legacy", credential: { type: "oauth", access: "old", expires: 1 } },
    ] });
    expect(loadAuthStoreWithDiagnostics(dir).store.chatgpt).toEqual([]);
  });

  test("the next credential write persists the legacy removal", async () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { chatgpt: [
      { id: "legacy", identity: "legacy", credential: { type: "oauth", access: "old", expires: 1 } },
    ] });
    await appendCredentialInstance("chatgpt", {
      id: "account", identity: "a@example.com", credential: { type: "oauth", access: "a", expires: 2 },
    }, dir, slots);
    expect(JSON.parse(readFileSync(authJsonPath(dir), "utf8")).chatgpt).toEqual([
      { id: "account", identity: "a@example.com", lineageId: expect.any(String), credential: { type: "oauth", access: "a", expires: 2 } },
    ]);
  });
});

describe("setCredential", () => {
  test("creates auth.json with 0600 permissions when it does not exist", async () => {
    const dir = makeTmpDir();
    const cred: Credential = { type: "api_key", key: "sk-test" };
    await setCredential("anthropic_api", cred, dir);
    const filePath = authJsonPath(dir);
    expect(existsSync(filePath)).toBe(true);
    const mode = statSync(filePath).mode & 0o777;
    if (POSIX_FILE_MODES) expect(mode).toBe(0o600);
  });

  test("refuses to create a missing auth profile directory", async () => {
    const dir = join(makeTmpDir(), "nested", "auth");
    const cred: Credential = { type: "api_key", key: "[redacted secret]" };
    await expect(setCredential("anthropic_api", cred, dir)).rejects.toBeInstanceOf(AuthProfileDirectoryNotFoundError);
    expect(existsSync(dir)).toBe(false);
  });

  test("adds a new provider without clobbering others", async () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { anthropic_api: { type: "api_key", key: "sk-ant" } });
    const cred: Credential = { type: "api_key", key: "sk-oai" };
    await setCredential("openai_api", cred, dir);
    const store = loadAuthStoreWithDiagnostics(dir).store;
    expect(store.anthropic_api).toEqual({ type: "api_key", key: "sk-ant" });
    expect(store.openai_api).toEqual({ type: "api_key", key: "sk-oai" });
  });

  test("rejects invalid sibling credentials without rewriting valid entries", async () => {
    const dir = makeTmpDir();
    const chatgpt = [{ id: "account", identity: "account@example.com", credential: { type: "oauth", access: "access", expires: 1 } }];
    const invalid = JSON.stringify({ chatgpt, junk: { type: "unknown" } });
    writeFileSync(authJsonPath(dir), invalid);

    await expect(setCredential("anthropic_api", { type: "api_key", key: "replacement" }, dir)).rejects.toThrow();
    expect(readFileSync(authJsonPath(dir), "utf8")).toBe(invalid);
  });

  test("rejects unreadable auth.json without replacing its credentials", async () => {
    const dir = makeTmpDir();
    const malformed = JSON.stringify({
      anthropic_api: metered({ type: "api_key", key: "must-survive" }),
      openai_api: metered({ type: "api_key", key: "also-must-survive" }),
    }).slice(0, -1);
    writeFileSync(authJsonPath(dir), malformed);

    await expect(setCredential("exa", { type: "api_key", key: "replacement" }, dir)).rejects.toThrow();
    expect(readFileSync(authJsonPath(dir), "utf8")).toBe(malformed);
  });

  test("rejects oversized auth.json without replacing it", async () => {
    const dir = makeTmpDir();
    const oversized = "x".repeat(16 * 1024 * 1024 + 1);
    writeFileSync(authJsonPath(dir), oversized);

    await expect(setCredential("anthropic_api", { type: "api_key", key: "replacement" }, dir)).rejects.toThrow();
    expect(readFileSync(authJsonPath(dir), "utf8")).toBe(oversized);
  });

  test("rejects schema-invalid auth.json without dropping other credentials", async () => {
    const dir = makeTmpDir();
    const invalid = JSON.stringify({
      anthropic_api: metered({ type: "api_key", key: "must-survive" }),
      openai_api: { type: "unknown", key: "invalid" },
    });
    writeFileSync(authJsonPath(dir), invalid);

    await expect(setCredential("exa", { type: "api_key", key: "replacement" }, dir)).rejects.toThrow();
    expect(readFileSync(authJsonPath(dir), "utf8")).toBe(invalid);
  });
});

describe("metered credential lineages", () => {
  test("reads direct credentials and normalizes nested records on mutation", async () => {
    const dir = makeTmpDir();
    const direct = { type: "api_key" as const, key: "direct-secret" };
    const nested = { type: "api_key" as const, key: "nested-secret" };
    const nestedLineage = crypto.randomUUID();
    writeAuthJson(dir, {
      anthropic_api: direct,
      openai_api: { lineageId: nestedLineage, credential: nested },
    });

    expect(loadAuthStoreWithDiagnostics(dir, ["anthropic_api", "openai_api"], slots).store).toEqual({
      anthropic_api: direct,
      openai_api: nested,
    });

    await setMeteredCredential("exa", { type: "api_key", key: "new-secret" }, dir, slots);
    const normalized = JSON.parse(readFileSync(authJsonPath(dir), "utf8"));
    expect(normalized.anthropic_api).toEqual({ ...direct, lineageId: expect.any(String) });
    expect(normalized.openai_api).toEqual({ ...nested, lineageId: nestedLineage });
    expect(normalized.exa).toEqual({ type: "api_key", key: "new-secret", lineageId: expect.any(String) });
  });

  test("mints a lineage on every credential replacement", async () => {
    const dir = makeTmpDir();
    await setMeteredCredential("openai_api", { type: "api_key", key: "first" }, dir, slots);
    const first = JSON.parse(readFileSync(authJsonPath(dir), "utf8")).openai_api;

    await setMeteredCredential("openai_api", { type: "api_key", key: "second" }, dir, slots);
    const second = JSON.parse(readFileSync(authJsonPath(dir), "utf8")).openai_api;
    expect(second.lineageId).not.toBe(first.lineageId);
    expect(second).toEqual({ type: "api_key", key: "second", lineageId: expect.any(String) });
  });
});

describe("replaceCredential", () => {
  test("replaces only the credential version the caller refreshed", async () => {
    const dir = makeTmpDir();
    const original: Credential = { type: "oauth", access: "access-a", refresh: "refresh-a", expires: 1 };
    const refreshed: Credential = { type: "oauth", access: "access-a2", refresh: "refresh-a2", expires: 2 };
    const otherAccount: Credential = { type: "oauth", access: "access-b", refresh: "refresh-b", expires: 3 };
    await setCredential("chatgpt", original, dir);

    expect(await replaceCredential("chatgpt", original, refreshed, dir)).toBe(true);
    expect(getCredential("chatgpt", dir)).toEqual(refreshed);

    await setCredential("chatgpt", otherAccount, dir);
    expect(await replaceCredential("chatgpt", refreshed, original, dir)).toBe(false);
    expect(getCredential("chatgpt", dir)).toEqual(otherAccount);
  });
});

describe("getCredential", () => {
  test("returns credential for existing provider", () => {
    const dir = makeTmpDir();
    const cred = { type: "api_key" as const, key: "sk-x" };
    writeAuthJson(dir, { anthropic_api: metered(cred) });
    expect(getCredential("anthropic_api", dir)).toEqual(cred);
  });

  test("returns undefined for missing provider", () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, {});
    expect(getCredential("anthropic_api", dir)).toBeUndefined();
  });
});

describe("deleteCredential", () => {
  test("removes a provider and preserves others", async () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, {
      anthropic_api: { type: "api_key", key: "sk-ant" },
      openai_api: { type: "api_key", key: "sk-oai" },
    });
    await deleteCredential("anthropic_api", dir);
    const store = loadAuthStoreWithDiagnostics(dir).store;
    expect(store.anthropic_api).toBeUndefined();
    expect(store.openai_api).toEqual({ type: "api_key", key: "sk-oai" });
  });

  test("is a no-op when provider is not in store", async () => {
    const dir = makeTmpDir();
    writeAuthJson(dir, { anthropic_api: { type: "api_key", key: "sk-ant" } });
    await deleteCredential("openai_api", dir);
    const store = loadAuthStoreWithDiagnostics(dir).store;
    expect(store.anthropic_api).toEqual({ type: "api_key", key: "sk-ant" });
  });

  test("reports a missing profile directory without creating it", async () => {
    const dir = join(makeTmpDir(), "missing", "auth");
    await expect(deleteCredential("openai_api", dir)).rejects.toBeInstanceOf(AuthProfileDirectoryNotFoundError);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("concurrent writes", () => {
  test("concurrent setCredential calls do not corrupt the store", async () => {
    const dir = makeTmpDir();
    const writes = Array.from({ length: 5 }, (_, i) =>
      setCredential("anthropic_api", { type: "api_key", key: `sk-${i}` }, dir),
    );
    await Promise.all(writes);
    const credential = getCredential("anthropic_api", dir);
    expect(credential?.type).toBe("api_key");
    if (credential?.type !== "api_key") throw new Error("Expected an API key credential");
    expect(credential.key).toMatch(/^sk-\d$/);
  });
});

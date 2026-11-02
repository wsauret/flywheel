import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthProfileStore, openExistingAuthProfileDirectory, type AuthProfileAccess } from "../../../../src/infra/auth/auth-profile-store.js";
import { normalizeAuthProfile } from "../../../../src/infra/auth/auth-profile-normalization.js";
import { adoptPreviousProviderModelCatalogs, deleteProviderModelCatalog, liveModelRefusals, MODEL_REFUSAL_LIFETIME_MS, readSavedProviderModels, recordProviderModelAccess, recordProviderModelRefusal, writeProviderModelCatalog, writeProviderModelCandidates } from "../../../../src/infra/auth/provider-model-catalog-store.js";
import type { AccessProviderDefinition } from "../../../../src/infra/llm/access-provider.js";
import type { CatalogCanonicalRow } from "../../../../src/infra/llm/model-catalog-resolution.js";
import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { installedCredentialProviderIds } from "../../../../src/orchestration/credential-provider-modules.js";
import { TEST_CATALOG_LIMITS } from "../../../helpers/model-catalog-fixtures.js";
import { modelInfo } from "../../../helpers/model-tier-fixtures.js";
import { catalogProfile } from "../../../helpers/catalog-profile.js";

const roots: string[] = [];
const composition = composeFirstPartyModules();
const definitions = accessProviderRegistry(composition).selection.definitions;
const classifySlot = credentialSlotClassifier(composition);
const catalog = (access: AuthProfileAccess) => catalogProfile(access, definitions, classifySlot);
const readProviderModelCatalog = (...input: Parameters<typeof readSavedProviderModels>) => readSavedProviderModels(...input)?.rows;
const readProviderModelAudit = (...input: Parameters<typeof readSavedProviderModels>) => readSavedProviderModels(...input)?.audit;
const account = { kind: "singleton", providerId: "openai_api" } as const;
const lineage = "fda8ad92-5f10-43eb-bbaa-62079998d98f";
const newerLineage = "eb9c31a9-1059-42cd-a93b-41274c701055";
const row: CatalogCanonicalRow = {
  modelId: "gpt-5.5",
  offerings: [{
    wireModelId: "gpt-5.5-contributor",
    metadata: { wire: "exact" },
    dataUse: "contributor",
    transport: "openai-responses",
    resolvedMetadata: modelInfo("openai", "gpt-5.5", "gpt", 1, 2, "2026-01-01"),
  }],
};

function profile() {
  const root = mkdtempSync(join(tmpdir(), "flywheel-provider-catalog-"));
  roots.push(root);
  return new AuthProfileStore(root).create("default").then((access) => {
    access.writeFile("auth.json", JSON.stringify({
      openai_api: { lineageId: lineage, credential: { type: "api_key", key: "test-key" } },
      supergrok: [{ id: "primary", identity: "test-account", lineageId: lineage, credential: { type: "oauth", access: "test-token", expires: 2_000_000_000_000 } }],
    }));
    return access;
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider model catalog store", () => {
  test("round-trips canonical account, lineage, wire identity, data use, and provider metadata", async () => {
    const access = await profile();
    expect(await writeProviderModelCatalog(catalog(access), account, lineage, [row], TEST_CATALOG_LIMITS)).toBe(true);
    expect(readProviderModelCatalog(access, account, lineage, TEST_CATALOG_LIMITS)).toEqual([{
      modelId: "gpt-5.5",
      offerings: [{ wireModelId: "gpt-5.5-contributor", metadata: { wire: "exact" }, dataUse: "contributor", transport: "openai-responses", resolvedMetadata: row.offerings[0]?.resolvedMetadata }],
    }]);
    expect(readProviderModelCatalog(access, account, "other", TEST_CATALOG_LIMITS)).toBeUndefined();
    const encoded = access.readFile("provider-model-catalogs.json", 4096)?.toString("utf8") ?? "";
    expect(encoded).not.toContain("credential");
    expect(encoded).not.toContain("secret");
    expect(encoded).toContain("resolvedMetadata");
    access.close();
  });

  test("fences generation writes and deletes", async () => {
    const access = await profile();
    expect(await writeProviderModelCatalog(catalog(access), account, newerLineage, [row], TEST_CATALOG_LIMITS)).toBe(false);
    expect(await writeProviderModelCatalog(catalog(access), account, lineage, [row], TEST_CATALOG_LIMITS)).toBe(true);
    access.writeFile("auth.json", JSON.stringify({ openai_api: { lineageId: newerLineage, credential: { type: "api_key", key: "test-key" } } }));
    expect(await deleteProviderModelCatalog(catalog(access), account, lineage, TEST_CATALOG_LIMITS)).toBe(false);
    expect(readProviderModelCatalog(access, account, lineage, TEST_CATALOG_LIMITS)).toBeDefined();
    access.writeFile("auth.json", JSON.stringify({ openai_api: { lineageId: lineage, credential: { type: "api_key", key: "test-key" } } }));
    expect(await deleteProviderModelCatalog(catalog(access), account, lineage, TEST_CATALOG_LIMITS)).toBe(true);
    expect(readProviderModelCatalog(access, account, lineage, TEST_CATALOG_LIMITS)).toBeUndefined();
    access.close();
  });

  test("fences each account of an external login by its own account id, though the login stores nothing", async () => {
    const access = await profile();
    const supergrok = definitions.find(({ id }) => id === "supergrok");
    if (supergrok === undefined) throw new Error("expected the SuperGrok definition");
    const accounts = [
      { accountId: "uuid-a", identity: "a@example.com", configDir: "/scratch/a" },
      { accountId: "uuid-b", identity: "b@example.com", configDir: "/scratch/b" },
    ];
    const external: AccessProviderDefinition = {
      ...supergrok,
      id: "external_login",
      auth: { kind: "external", program: "Example CLI", statusRank: 0, accounts: () => accounts, problems: () => [], observe: () => () => {}, awaitLogin: async () => "declined", loginQuestions: () => [], answerLogin: () => undefined, settleLogin: () => {}, login: () => Promise.reject(new Error("no login")), logout: () => Promise.reject(new Error("no logout")), logoutProfile: () => Promise.reject(new Error("no logout")) },
    };
    const profileView = catalogProfile(access, [external], classifySlot);
    const first = { kind: "subscription", providerId: "external_login", instanceId: "uuid-a" } as const;
    const second = { kind: "subscription", providerId: "external_login", instanceId: "uuid-b" } as const;
    const gone = { kind: "subscription", providerId: "external_login", instanceId: "uuid-c" } as const;

    expect(await writeProviderModelCatalog(profileView, first, "uuid-a", [row], TEST_CATALOG_LIMITS)).toBe(true);
    expect(await writeProviderModelCatalog(profileView, second, "uuid-a", [row], TEST_CATALOG_LIMITS)).toBe(false);
    expect(await writeProviderModelCatalog(profileView, second, "uuid-b", [row], TEST_CATALOG_LIMITS)).toBe(true);
    expect(await writeProviderModelCatalog(profileView, gone, "uuid-c", [row], TEST_CATALOG_LIMITS)).toBe(false);
    expect(readProviderModelCatalog(access, first, "uuid-a", TEST_CATALOG_LIMITS)).toEqual([row]);
    expect(readProviderModelCatalog(access, second, "uuid-b", TEST_CATALOG_LIMITS)).toEqual([row]);
    access.close();
  });

  test("rejects malformed, incomplete metadata, row overflow, and oversized documents as absent evidence", async () => {
    const access = await profile();
    const documents = [
      "not json",
      JSON.stringify({ version: 1, accounts: [{ account, lineage, rows: [{ modelId: "x", offerings: [{ wireModelId: "x", metadata: null, dataUse: "standard", resolvedMetadata: null }] }] }] }),
      JSON.stringify({ version: 1, accounts: [{ account, lineage, rows: [{ modelId: "x", offerings: [{ wireModelId: "x", metadata: null, dataUse: "standard", resolvedMetadata: { id: "x" } }] }] }] }),
      JSON.stringify({ version: 1, accounts: [{ account, lineage, rows: Array.from({ length: TEST_CATALOG_LIMITS.canonicalRows + 1 }, (_, index) => ({ modelId: `x-${index}`, offerings: [{ wireModelId: `x-${index}`, metadata: null, dataUse: "standard" }] })) }] }),
    ];
    for (const document of documents) {
      access.writeFile("provider-model-catalogs.json", document);
      expect(readProviderModelCatalog(access, account, lineage, TEST_CATALOG_LIMITS)).toBeUndefined();
    }
    access.writeFile("provider-model-catalogs.json", "x".repeat(8 * 1024 * 1024 + 1));
    expect(readProviderModelCatalog(access, account, lineage, TEST_CATALOG_LIMITS)).toBeUndefined();
    access.close();
  });

  test("does not overwrite an unreadable future catalog during a successful refresh", async () => {
    const access = await profile();
    const future = JSON.stringify({ version: 99, accounts: [{ preserved: true }] });
    access.writeFile("provider-model-catalogs.json", future);
    expect(await writeProviderModelCatalog(catalog(access), account, lineage, [row], TEST_CATALOG_LIMITS)).toBe(false);
    expect(access.readFile("provider-model-catalogs.json", 4096)?.toString("utf8")).toBe(future);
    access.close();
  });

  test("preserves a valid document that exceeds the contribution durable limit and rejects writes", async () => {
    const access = await profile();
    const document = JSON.stringify({ version: 1, accounts: [{ account, lineage, rows: [row] }] });
    const limits = { ...TEST_CATALOG_LIMITS, durableBytes: Buffer.byteLength(document) - 1 };
    access.writeFile("provider-model-catalogs.json", document);

    expect(readProviderModelCatalog(access, account, lineage, limits)).toBeUndefined();
    expect(await writeProviderModelCatalog(catalog(access), account, lineage, [row], limits)).toBe(false);
    expect(access.readFile("provider-model-catalogs.json", 4096)?.toString("utf8")).toBe(document);
    access.close();
  });

  test("converts v1 without granting SuperGrok access and keeps ordinary rows", async () => {
    const access = await profile();
    const superGrok = { kind: "subscription", providerId: "supergrok", instanceId: "primary" } as const;
    const oldSubscriptionRow: CatalogCanonicalRow = { modelId: "grok-4.6", offerings: [{ wireModelId: "grok-4.6", metadata: null, dataUse: "standard" }] };
    access.writeFile("provider-model-catalogs.json", JSON.stringify({ version: 1, accounts: [
      { account, lineage, rows: [row] },
      { account: superGrok, lineage, rows: [oldSubscriptionRow] },
    ] }));
    expect(await adoptPreviousProviderModelCatalogs(access, TEST_CATALOG_LIMITS)).toBe(true);
    expect(readProviderModelCatalog(access, account, lineage, TEST_CATALOG_LIMITS)).toEqual([row]);
    expect(readProviderModelCatalog(access, superGrok, lineage, TEST_CATALOG_LIMITS)).toEqual([oldSubscriptionRow]);
    expect(readProviderModelAudit(access, superGrok, lineage, TEST_CATALOG_LIMITS)).toBeUndefined();
    expect(await adoptPreviousProviderModelCatalogs(access, TEST_CATALOG_LIMITS)).toBe(false);
    access.close();
  });

  test("normalizes v2 before reading and preserves completed, refused, pending, and generation evidence", async () => {
    const access = await profile();
    const auditAccount = { kind: "subscription", providerId: "supergrok", instanceId: "primary" } as const;
    const audit = { candidateIds: ["done", "pending", "refused"], dueIds: ["pending"], outcomes: { done: "completed", refused: "refused" }, generation: 7 } as const;
    access.writeFile("provider-model-catalogs.json", JSON.stringify({ version: 2, accounts: [
      { account, lineage, rows: [row] },
      { account: auditAccount, lineage, rows: [], superGrok: audit },
    ] }));
    await normalizeAuthProfile(access.authDirectory, classifySlot, installedCredentialProviderIds(), definitions);
    expect(readProviderModelCatalog(access, account, lineage, TEST_CATALOG_LIMITS)).toEqual([row]);
    expect(readProviderModelAudit(access, auditAccount, lineage, TEST_CATALOG_LIMITS)).toEqual(audit);
    expect(JSON.parse(access.readFile("provider-model-catalogs.json", 4096)?.toString("utf8") ?? "{}")).toMatchObject({ version: 5 });
    expect(await adoptPreviousProviderModelCatalogs(access, TEST_CATALOG_LIMITS)).toBe(false);
    access.close();
  });

  test.each([account, { kind: "subscription", providerId: "supergrok", instanceId: "primary" } as const])("preserves historical refusals and rechecks successes only on additions or manual audits for %j", async (superGrok) => {
    const access = await profile();
    const ids = ["grok-one", "grok-two"];
    expect(await writeProviderModelCandidates(catalog(access), superGrok, lineage, [row], ids, TEST_CATALOG_LIMITS)).toBe(true);
    expect(await recordProviderModelAccess(catalog(access), superGrok, lineage, 1, ids[0]!, "completed", TEST_CATALOG_LIMITS)).toBe(true);
    expect(await recordProviderModelAccess(catalog(access), superGrok, lineage, 1, ids[1]!, "refused", TEST_CATALOG_LIMITS)).toBe(true);
    expect(readProviderModelAudit(access, superGrok, lineage, TEST_CATALOG_LIMITS)).toMatchObject({ generation: 1, dueIds: [], outcomes: { "grok-one": "completed", "grok-two": "refused" } });
    expect(await writeProviderModelCandidates(catalog(access), superGrok, lineage, [], ids, TEST_CATALOG_LIMITS)).toBe(true);
    expect(readProviderModelAudit(access, superGrok, lineage, TEST_CATALOG_LIMITS)?.generation).toBe(1);
    expect(await writeProviderModelCandidates(catalog(access), superGrok, lineage, [], [...ids, "grok-three"], TEST_CATALOG_LIMITS)).toBe(true);
    expect(readProviderModelAudit(access, superGrok, lineage, TEST_CATALOG_LIMITS)?.dueIds).toEqual(["grok-one", "grok-three"]);
    expect(await recordProviderModelAccess(catalog(access), superGrok, lineage, 1, "grok-three", "completed", TEST_CATALOG_LIMITS)).toBe(false);
    expect(await recordProviderModelAccess(catalog(access), superGrok, lineage, 2, "grok-one", "completed", TEST_CATALOG_LIMITS)).toBe(true);
    expect(await writeProviderModelCandidates(catalog(access), superGrok, lineage, [], ["grok-one", "grok-three"], TEST_CATALOG_LIMITS)).toBe(true);
    expect(readProviderModelAudit(access, superGrok, lineage, TEST_CATALOG_LIMITS)).toMatchObject({ generation: 3, dueIds: ["grok-three"], outcomes: { "grok-two": "refused" } });
    expect(await recordProviderModelAccess(catalog(access), superGrok, lineage, 2, "grok-three", "completed", TEST_CATALOG_LIMITS)).toBe(false);
    expect(await recordProviderModelAccess(catalog(access), superGrok, lineage, 3, "grok-three", "completed", TEST_CATALOG_LIMITS)).toBe(true);
    expect(await writeProviderModelCandidates(catalog(access), superGrok, lineage, [], ["grok-one"], TEST_CATALOG_LIMITS)).toBe(true);
    expect(readProviderModelAudit(access, superGrok, lineage, TEST_CATALOG_LIMITS)?.dueIds).toEqual([]);
    const reopened = openExistingAuthProfileDirectory(access.authDirectory);
    try {
      expect(readProviderModelAudit(reopened, superGrok, lineage, TEST_CATALOG_LIMITS)).toMatchObject({ candidateIds: ["grok-one"], dueIds: [], outcomes: { "grok-one": "completed", "grok-two": "refused", "grok-three": "completed" } });
    } finally {
      reopened.close();
    }
    expect(await writeProviderModelCandidates(catalog(access), superGrok, lineage, [], ids, TEST_CATALOG_LIMITS)).toBe(true);
    expect(readProviderModelAudit(access, superGrok, lineage, TEST_CATALOG_LIMITS)?.dueIds).toEqual(["grok-one"]);
    expect(await writeProviderModelCandidates(catalog(access), superGrok, lineage, [], [...ids, "grok-three"], TEST_CATALOG_LIMITS, true)).toBe(true);
    expect(readProviderModelAudit(access, superGrok, lineage, TEST_CATALOG_LIMITS)?.dueIds).toEqual(["grok-one", "grok-three", "grok-two"]);
    access.close();
  });

  // Remove with the version 4 conversion after 2027-04-08.
  test("converts a v4 document to v5 and keeps its rows and audit evidence", async () => {
    const access = await profile();
    const superGrok = { kind: "subscription", providerId: "supergrok", instanceId: "primary" } as const;
    const audit = { candidateIds: ["done", "pending"], dueIds: ["pending"], outcomes: { done: "completed" }, generation: 7 } as const;
    access.writeFile("provider-model-catalogs.json", JSON.stringify({ version: 4, accounts: [{ account, lineage, rows: [row] }, { account: superGrok, lineage, rows: [], audit }] }));
    expect(await adoptPreviousProviderModelCatalogs(access, TEST_CATALOG_LIMITS)).toBe(true);
    expect(JSON.parse(access.readFile("provider-model-catalogs.json", 4096)?.toString("utf8") ?? "{}")).toMatchObject({ version: 5 });
    expect(readSavedProviderModels(access, account, lineage, TEST_CATALOG_LIMITS)).toEqual({ rows: [row], audit: undefined, refusals: {} });
    expect(readProviderModelAudit(access, superGrok, lineage, TEST_CATALOG_LIMITS)).toEqual(audit);
    expect(await adoptPreviousProviderModelCatalogs(access, TEST_CATALOG_LIMITS)).toBe(false);
    access.close();
  });

  test("saves a served refusal for the current account generation by wire model and keeps it through catalog and audit writes", async () => {
    const access = await profile();
    const at = 1_000_000;
    const window = { kind: "extended-context", contextLimit: 200_000, at } as const;
    expect(await recordProviderModelRefusal(catalog(access), account, newerLineage, "gpt-5.5-contributor", window, TEST_CATALOG_LIMITS)).toBe(false);
    expect(await recordProviderModelRefusal(catalog(access), account, lineage, "gpt-5.5-contributor", window, TEST_CATALOG_LIMITS)).toBe(true);
    expect(readSavedProviderModels(access, account, lineage, TEST_CATALOG_LIMITS)).toEqual({ rows: undefined, audit: undefined, refusals: { "gpt-5.5-contributor": window } });
    expect(await writeProviderModelCatalog(catalog(access), account, lineage, [row], TEST_CATALOG_LIMITS)).toBe(true);
    expect(await recordProviderModelRefusal(catalog(access), account, lineage, "gpt-4.1", { kind: "model", at }, TEST_CATALOG_LIMITS)).toBe(true);
    expect(await writeProviderModelCandidates(catalog(access), account, lineage, [row], ["gpt-5.5"], TEST_CATALOG_LIMITS)).toBe(true);
    const reopened = openExistingAuthProfileDirectory(access.authDirectory);
    try {
      expect(readSavedProviderModels(reopened, account, lineage, TEST_CATALOG_LIMITS)).toMatchObject({ rows: [row], refusals: { "gpt-5.5-contributor": window, "gpt-4.1": { kind: "model", at } } });
    } finally {
      reopened.close();
    }
    expect(await recordProviderModelRefusal(catalog(access), account, lineage, "gpt-5.5", { kind: "extended-context", contextLimit: 0, at }, TEST_CATALOG_LIMITS)).toBe(false);
    access.close();
  });

  test("a refusal applies for its lifetime, and a later refusal drops the ones that ended", async () => {
    const access = await profile();
    const at = 5 * MODEL_REFUSAL_LIFETIME_MS;
    expect(await recordProviderModelRefusal(catalog(access), account, lineage, "old", { kind: "model", at }, TEST_CATALOG_LIMITS)).toBe(true);
    const saved = readSavedProviderModels(access, account, lineage, TEST_CATALOG_LIMITS)?.refusals ?? {};
    expect(Object.keys(liveModelRefusals(saved, at + MODEL_REFUSAL_LIFETIME_MS - 1))).toEqual(["old"]);
    expect(liveModelRefusals(saved, at + MODEL_REFUSAL_LIFETIME_MS)).toEqual({});
    expect(liveModelRefusals(saved, at - MODEL_REFUSAL_LIFETIME_MS)).toEqual({});
    expect(await recordProviderModelRefusal(catalog(access), account, lineage, "new", { kind: "model", at: at + MODEL_REFUSAL_LIFETIME_MS }, TEST_CATALOG_LIMITS)).toBe(true);
    expect(Object.keys(readSavedProviderModels(access, account, lineage, TEST_CATALOG_LIMITS)?.refusals ?? {})).toEqual(["new"]);
    access.close();
  });
});

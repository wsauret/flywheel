import { expect, test } from "bun:test";
import type { AuthContext } from "../../../../../src/infra/auth/auth-context.js";
import { AuthProfileStore } from "../../../../../src/infra/auth/store/auth-profile-store.js";
import { createAccessProviderSelection } from "../../../../../src/infra/llm/access/access-provider.js";
import { createModelListingClient } from "../../../../../src/infra/llm/access/model-listing.js";
import { testCapabilityModules, testProviderSelection } from "../../../../helpers/provider-authority.js";
import { credentialSlotClassifier } from "../../../../../src/orchestration/auth/credential-slot-classifier.js";
import { AUTH_NONE } from "../../../orchestration/config/_model-listing-fixtures.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { modelInfo } from "../../../../helpers/model-tier-fixtures.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { accessProviderAccountKey } from "../../../../../src/infra/auth/provider-account.js";

const classifySlot = credentialSlotClassifier(testCapabilityModules());
const LINEAGE = "c16045ec-29e2-43c7-bcde-ea7dc1e95280";
const temporaryDirectory = temporaryDirectories();

async function vertexListingClient(refreshes: { count: number }, probes: string[]) {
  const root = temporaryDirectory("flywheel-vertex-held-listing-");
  const access = await new AuthProfileStore(root).create("default");
  access.writeFile("auth.json", JSON.stringify({ google_vertex: { type: "api_key", key: "vertex", lineageId: LINEAGE } }));
  const authDir = access.authDirectory;
  access.close();
  return createModelListingClient({
    classifySlot,
    authDir,
    providers: createAccessProviderSelection(testProviderSelection().definitions.map((definition) =>
      definition.id !== "google_vertex" || definition.dynamicCatalog === undefined ? definition : {
        ...definition,
        dynamicCatalog: {
          ...definition.dynamicCatalog, membership: undefined,
          probeAccess: async ({ wireModelId }) => { probes.push(wireModelId); return "completed"; },
        },
      })),
    modelsClient: {
      refresh: async () => { refreshes.count += 1; },
      getTokenizerIdentity: () => undefined,
      getProviderCatalog: (providers) => providers.includes("google-vertex")
        ? ["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001", "claude-sonnet-4@20250514"].map((wireModelId) => ({
            providerId: "google-vertex",
            providerName: "Vertex",
            wireModelId,
            metadata: modelInfo("google", wireModelId, "gemini", 0, 0, "2026-01-01"),
            provenance: "bundled" as const,
            canonical: { providerId: "google", modelId: wireModelId },
            transport: { npm: "@ai-sdk/google-vertex" },
          }))
        : [],
    },
  });
}

const VERTEX_AUTH: AuthContext = { ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { google_vertex: "vertex" } }), credentialLineages: { google_vertex: LINEAGE } };

test("Google Vertex derives every Gemini chat model from models.dev", async () => {
  const probes: string[] = [];
  const client = await vertexListingClient({ count: 0 }, probes);
  const catalogs = await client.getModelCatalogs(VERTEX_AUTH, { mode: "fresh" });
  const candidate = catalogs.candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "google_vertex" }));

  expect(new Set(candidate?.visibleModels?.keys())).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
  expect(catalogs.providers.get("google_vertex")).toBeUndefined();
  expect(probes).toEqual([]);
  const checked = await client.getModelCatalogs(VERTEX_AUTH, { mode: "audit" });
  expect(new Set(probes)).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
  expect(checked.providers.get("google_vertex")).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
});

test("cached-first discovery shows pending Google Vertex candidates and admits checked models without a metadata refresh", async () => {
  const refreshes = { count: 0 };
  const probes: string[] = [];
  const client = await vertexListingClient(refreshes, probes);
  const catalogs = await client.getModelCatalogs(VERTEX_AUTH, { mode: "cached-first" });
  const candidate = catalogs.candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "google_vertex" }));

  expect(new Set(candidate?.visibleModels?.keys())).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
  expect(catalogs.providers.get("google_vertex")).toBeUndefined();
  expect(candidate?.models).toBeNull();
  expect(candidate?.outcome).toEqual({ kind: "unavailable", reason: "discovery-pending" });
  expect(probes).toEqual([]);
  expect(refreshes.count).toBe(0);
  await client.getModelCatalogs(VERTEX_AUTH, { mode: "refresh" });
  await client.getModelCatalogs(VERTEX_AUTH, { mode: "audit" });
  const checked = await client.getModelCatalogs(VERTEX_AUTH, { mode: "cached-first" });
  expect(probes).toHaveLength(3);
  expect(checked.providers.get("google_vertex")).toEqual(new Set(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-embedding-001"]));
  expect(checked.candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "google_vertex" }))?.outcome).toMatchObject({ kind: "catalog", provenance: "models-dev-bundled" });
  expect(refreshes.count).toBe(0);
});

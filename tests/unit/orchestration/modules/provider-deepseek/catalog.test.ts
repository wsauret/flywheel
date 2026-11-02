import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AuthContext } from "../../../../../src/infra/auth/auth-context.js";
import { accessProviderAccountKey } from "../../../../../src/infra/llm/access-provider.js";
import { createModelListingClient } from "../../../../../src/infra/llm/model-listing.js";
import { createModelsClient } from "../../../../../src/infra/llm/models.js";
import { credentialSlotClassifier } from "../../../../../src/orchestration/auth/credential-slot-classifier.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { combinedModelsDevProviders, modelsDevDocument } from "../../../../helpers/model-catalog-fixtures.js";
import { testCapabilityModules, testProviderSelection } from "../../../../helpers/provider-authority.js";
import { AUTH_DIR, AUTH_NONE } from "../../config/_model-listing-fixtures.js";

const classifySlot = credentialSlotClassifier(testCapabilityModules());
const LINEAGE = "c16045ec-29e2-43c7-bcde-ea7dc1e95280";
const temporaryDirectory = temporaryDirectories();

test("DeepSeek names its account's models by the models.dev snapshot, requests the wire, and takes prices, efforts, and reasoning field from models.dev", async () => {
  const root = temporaryDirectory("flywheel-deepseek-listing-");
  const original = globalThis.fetch;
  const listings: { url: string; authorization: string | null }[] = [];
  const document = modelsDevDocument();
  const deepseekModel = (id: string, snapshot: string) => ({
    id, name: id, canonical_model_id: snapshot, reasoning: true, tool_call: true,
    reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
    interleaved: { field: "reasoning_content" },
    cost: { input: 0.5, output: 2, cache_read: 0.05 },
    limit: { context: 1_000_000, output: 384_000 },
  });
  document.deepseek = { id: "deepseek", name: "DeepSeek", npm: "@ai-sdk/openai-compatible", models: {
    "deepseek-flash": deepseekModel("deepseek-flash", "deepseek/deepseek-v4.1-flash-1017"),
    "deepseek-v4-pro": deepseekModel("deepseek-v4-pro", "deepseek/deepseek-v4-pro-0813"),
  } };
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.deepseek.com")) return Response.json(combinedModelsDevProviders(document));
    listings.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    return Response.json({ object: "list", data: ["deepseek-flash", "deepseek-v4-pro", "deepseek-preview"].map((id) => ({ id, object: "model", owned_by: "deepseek" })) });
  }, { preconnect: original.preconnect });
  try {
    const modelsClient = createModelsClient(join(root, "models.json"));
    await modelsClient.refresh(new AbortController().signal);
    const client = createModelListingClient({ classifySlot, authDir: AUTH_DIR, oauthPersistence: "access-only", providers: testProviderSelection(), modelsClient });
    const auth: AuthContext = { ...AUTH_NONE, providers: authProviders({ base: AUTH_NONE.providers, apiKeys: { deepseek: "deepseek-key" } }), credentialLineages: { deepseek: LINEAGE } };

    const candidate = (await client.getModelCatalogs(auth, { mode: "fresh" })).candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "deepseek" }));

    expect(listings).toEqual([{ url: "https://api.deepseek.com/models", authorization: "Bearer deepseek-key" }]);
    expect(candidate?.outcome).toMatchObject({ kind: "catalog", provenance: "first-party" });
    expect(new Map([...candidate?.models ?? []].map(([modelId, offerings]) => [modelId, offerings.map((offering) => offering.wireModelId)]))).toEqual(new Map([
      ["deepseek-v4.1-flash-1017", ["deepseek-flash"]],
      ["deepseek-v4-pro-0813", ["deepseek-v4-pro"]],
      ["deepseek-preview", ["deepseek-preview"]],
    ]));
    for (const modelId of ["deepseek-v4.1-flash-1017", "deepseek-v4-pro-0813"]) {
      expect(candidate?.models?.get(modelId)?.[0]?.resolvedMetadata).toMatchObject({
        reasoningEfforts: ["low", "high", "max"],
        interleavedReasoningField: "reasoning_content",
        pricing: { status: "available", rateCard: { input: 0.5, output: 2, cacheRead: 0.05 } },
      });
    }
  } finally {
    globalThis.fetch = original;
  }
});

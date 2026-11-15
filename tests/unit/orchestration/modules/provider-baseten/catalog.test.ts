import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AuthContext } from "../../../../../src/infra/auth/auth-context.js";
import { accessProviderAccountKey } from "../../../../../src/infra/llm/access-provider.js";
import { createModelListingClient } from "../../../../../src/infra/llm/model-listing.js";
import { createModelsClient } from "../../../../../src/infra/llm/models.js";
import { credentialSlotClassifier } from "../../../../../src/orchestration/auth/credential-slot-classifier.js";
import { resolveProviderModelCatalog } from "../../../../../src/orchestration/config/model-assignment-providers.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { combinedModelsDevProviders, modelsDevDocument } from "../../../../helpers/model-catalog-fixtures.js";
import { testCapabilityModules, testProviderSelection } from "../../../../helpers/provider-authority.js";
import { AUTH_DIR, AUTH_NONE } from "../../config/_model-listing-fixtures.js";

const temporaryDirectory = temporaryDirectories();
const WIRE = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const MODEL = "deepseek-v4.1-flash-1017";

test.each([false, true])("Baseten joins exact live wires, keeps Fast separate, and falls back to its models.dev metadata (discovery fails: %s)", async (fails) => {
  const root = temporaryDirectory("flywheel-baseten-listing-");
  const original = globalThis.fetch;
  const listings: { url: string; authorization: string | null }[] = [];
  const document = modelsDevDocument();
  document.baseten = { id: "baseten", name: "Baseten", npm: "@ai-sdk/openai-compatible", models: {
    [WIRE]: {
      id: WIRE, name: "DeepSeek V4.1 Flash 1017", reasoning: true, tool_call: true,
      reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "max"] }],
      interleaved: { field: "reasoning_content" },
      cost: { input: 0.4, output: 1.6, cache_read: 0.01 },
      limit: { context: 500_000, output: 100_000 },
    },
  } };
  const row = {
    id: WIRE, name: "DeepSeek V4.1 Flash 1017",
    context_length: 1_048_576, max_completion_tokens: 262_144,
    pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.000000007" },
    supported_features: ["tools", "reasoning"],
    input_modalities: ["text"], output_modalities: ["text"],
  };
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://inference.baseten.co")) return Response.json(combinedModelsDevProviders(document));
    listings.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    if (fails) return new Response("unavailable", { status: 503 });
    return Response.json({ data: [
      row,
      { ...row, id: `${WIRE}-Fast`, pricing: { prompt: "0.0000006", completion: "0.0000024" } },
      { ...row, id: "decision-models/classifier", supported_features: [], pricing: { prompt: "0.0000001", completion: "0" } },
      { ...row, id: "new-owner/new-vision-model", input_modalities: ["text", "image"], supported_features: ["tools"] },
    ] });
  }, { preconnect: original.preconnect });
  try {
    const modelsClient = createModelsClient(join(root, "models.json"));
    await modelsClient.refresh(new AbortController().signal);
    const providers = testProviderSelection();
    const client = createModelListingClient({ classifySlot: credentialSlotClassifier(testCapabilityModules()), authDir: AUTH_DIR, oauthPersistence: "access-only", providers, modelsClient });
    const auth: AuthContext = { ...AUTH_NONE, providers: authProviders({ apiKeys: { baseten: "baseten-test-key" } }), credentialLineages: { baseten: "c16045ec-29e2-43c7-bcde-ea7dc1e95280" } };
    const catalogs = await client.getModelCatalogs(auth, { mode: "fresh" });
    const candidate = catalogs.candidates.get(accessProviderAccountKey({ kind: "singleton", providerId: "baseten" }));
    expect(listings).toEqual([{ url: "https://inference.baseten.co/v1/models", authorization: "Bearer baseten-test-key" }]);
    expect(candidate?.models?.get(MODEL)?.map((offering) => offering.wireModelId)).toEqual([WIRE]);
    expect(candidate?.models?.get(MODEL)?.[0]?.resolvedMetadata).toMatchObject({
      family: "openai", reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "max"],
      interleavedReasoningField: "reasoning_content",
      contextLimit: fails ? 500_000 : 1_048_576,
      outputLimit: fails ? 100_000 : 262_144,
      pricing: { status: "available", rateCard: fails ? { input: 0.4, output: 1.6, cacheRead: 0.01 } : { input: 0.3, output: 1.2, cacheRead: 0.007 } },
    });
    if (!fails) {
      expect(candidate?.models?.get(MODEL)?.[0]?.resolvedMetadata?.pricing).toMatchObject({ provenance: { source: "provider-api", provider: "baseten", model: WIRE } });
      expect(candidate?.models?.get(`${MODEL}-fast`)?.map((offering) => offering.wireModelId)).toEqual([`${WIRE}-Fast`]);
      expect(candidate?.models?.get(`${MODEL}-fast`)?.[0]?.resolvedMetadata?.cost).toMatchObject({ input: 0.6, output: 2.4 });
      const visible = await resolveProviderModelCatalog({ userDataRoot: root, authDirectory: () => AUTH_DIR, auth, listingClient: { ...client, getModelCatalogs: async () => catalogs } });
      expect(visible.providers.get("baseten")?.catalog).toEqual(new Set([MODEL, `${MODEL}-fast`, "new-vision-model"]));
      expect(candidate?.models?.get("new-vision-model")?.[0]?.resolvedMetadata).toMatchObject({ attachment: true, reasoning: false, modalities: { input: ["text", "image"], output: ["text"] } });
    }
  } finally {
    globalThis.fetch = original;
  }
});

import { expect, test } from "bun:test";
import { join } from "node:path";
import { Redacted } from "effect";
import { accessProviderAccountKey } from "../../../../../src/infra/llm/access-provider.js";
import { createModelListingClient } from "../../../../../src/infra/llm/model-listing.js";
import { createModelsClient } from "../../../../../src/infra/llm/models.js";
import { credentialSlotClassifier } from "../../../../../src/orchestration/auth/credential-slot-classifier.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { combinedModelsDevProviders, modelsDevDocument } from "../../../../helpers/model-catalog-fixtures.js";
import { testCapabilityModules, testProviderSelection } from "../../../../helpers/provider-authority.js";
import { AUTH_DIR, AUTH_NONE } from "../../config/_model-listing-fixtures.js";
import { OPENCODE_GO_API_BASE } from "../../../../../src/orchestration/modules/provider-opencode-go/wire.js";

const classifySlot = credentialSlotClassifier(testCapabilityModules());
const temporaryDirectory = temporaryDirectories();

test("OpenCode Go names its models by the models.dev snapshot and makes a free wire a free route only beside a paid wire", async () => {
  const root = temporaryDirectory("flywheel-opencode-go-listing-");
  const original = globalThis.fetch;
  const document = modelsDevDocument();
  const goModel = (id: string, snapshot?: string) => ({
    id, name: id, ...(snapshot === undefined ? {} : { canonical_model_id: snapshot }), tool_call: true,
    cost: { input: 1, output: 2 }, limit: { context: 200_000, output: 32_000 },
  });
  const models = [
    goModel("minimax-m3.1-flash", "minimax/MiniMax-M3.1-Flash"),
    goModel("minimax-m3.1-flash-free", "minimax/MiniMax-M3.1-Flash"),
    goModel("beam-free", "reflection/beam-1.0-501b-a23b"),
    goModel("deepseek-v4-pro", "deepseek/deepseek-v4-pro"),
    goModel("space-bunny"),
    goModel("cat-jam-free"),
  ];
  document["opencode-go"] = { id: "opencode-go", name: "OpenCode Go", npm: "@ai-sdk/openai-compatible", models: Object.fromEntries(models.map((model) => [model.id, model])) };
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.startsWith(OPENCODE_GO_API_BASE)) return Response.json(combinedModelsDevProviders(document));
    return Response.json({ object: "list", data: models.map(({ id }) => ({ id, object: "model" })) });
  }, { preconnect: original.preconnect });
  try {
    const modelsClient = createModelsClient(join(root, "models.json"));
    await modelsClient.refresh(new AbortController().signal);
    const client = createModelListingClient({
      classifySlot, authDir: AUTH_DIR, oauthPersistence: "access-only", providers: testProviderSelection(), modelsClient,
      captureSubscriptions: () => new Map([["opencode_go", [{ instanceId: "go", credential: { type: "api_key", key: Redacted.make("go-key") } }]]]),
    });

    const candidate = (await client.getModelCatalogs(AUTH_NONE, { mode: "fresh" })).candidates.get(accessProviderAccountKey({ kind: "subscription", providerId: "opencode_go", instanceId: "go" }));

    expect(candidate?.outcome).toMatchObject({ kind: "catalog", provenance: "first-party" });
    expect(new Map([...candidate?.models ?? []].map(([modelId, offerings]) => [modelId, offerings.map(({ wireModelId, routeKind }) => ({ wireModelId, routeKind }))]))).toEqual(new Map([
      ["minimax-m3.1-flash", [{ wireModelId: "minimax-m3.1-flash", routeKind: undefined }, { wireModelId: "minimax-m3.1-flash-free", routeKind: "free" }]],
      ["beam-1.0-501b-a23b", [{ wireModelId: "beam-free", routeKind: undefined }]],
      ["deepseek-v4-pro", [{ wireModelId: "deepseek-v4-pro", routeKind: undefined }]],
      ["space-bunny", [{ wireModelId: "space-bunny", routeKind: undefined }]],
      ["cat-jam-free", [{ wireModelId: "cat-jam-free", routeKind: undefined }]],
    ]));
  } finally {
    globalThis.fetch = original;
  }
});

import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Log } from "../../../../../src/infra/log.js";
import { createModelsClient } from "../../../../../src/infra/llm/models.js";
import { authDir, modelsSnapshotFile } from "../../../../../src/infra/paths.js";
import { createClient } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import { executeStream, preparedRequest } from "./_provider-chain-harness.js";
import { FUNCTION_TOOL_PRESENTATION } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { testProviderRegistry, testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { modelsDevJson } from "../../../../helpers/model-catalog-fixtures.js";

const directories = testDirectories("/scratch");
// A catalog snapshot on disk keeps the models client off the network. Without
// one, the first attempt waits for a live models.dev fetch of up to 10 seconds.
const snapshotFile = modelsSnapshotFile(directories.userDataRoot);
mkdirSync(dirname(snapshotFile), { recursive: true });
writeFileSync(snapshotFile, modelsDevJson());
const auth = {
  providers: authProviders({ apiKeys: { openai_api: "credential-bytes" } }),
  credentialLineages: {},
  droppedCredentials: [],
};

describe("provider request admission diagnostics", () => {
  test("records one secret-free effective chain, at DEBUG, only for a real request", async () => {
    const base = testProviderRegistry();
    const providers = {
      ...base,
      factories: new Map(base.factories).set("openai_api", async ({ candidate, model, family }) => {
        const client = { historyTarget: ownHistoryTarget,
        accessProvider: "openai_api",
        accessProviderCandidate: candidate,
        model,
        modelFamily: family,
        toolPresentation: FUNCTION_TOOL_PRESENTATION,
        contextLimit: 1_000,
        outputLimit: 100,
        supportsReasoning: false,
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
        async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } as const; },
        };
        return { stage: async () => ({ attempt: client, connect: async () => client }) };
      }),
    };
    // Per request, so DEBUG: model.requested names the provider and model.
    const info = spyOn(Log.create({ service: "llm-client-factory" }), "debug").mockImplementation(() => {});
    const client = await createClient("gpt-5.5", createModelsClient(modelsSnapshotFile(directories.userDataRoot)), auth, {
      notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
      authDir: authDir(directories.userDataRoot, "default"),
      profileId: "default",
      allowTrainingRoutes: false,
      requestAdmission: async () => Object.freeze({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined }),
      projectRoot: directories.projectRoot,
      providers,
      eligibility: {
        modelUnavailableReason: () => undefined,
        candidateOffering: (candidate, model) => ({
          candidate,
          wireModelId: model,
          dataUse: "standard",
          transport: "openai-responses",
        }),
      },
    });

    await client.plannedAttempt();
    expect(info).not.toHaveBeenCalled();
    const admitted = await client.admitRequest();
    expect(info).toHaveBeenCalledTimes(1);
    await admitted.plannedAttempt();
    await admitted.run({ prepare: preparedRequest, execute: ({ client: adapter }) => executeStream(adapter, {
      messages: [{ kind: "user", content: "hello" }],
      tools: [],
      systemPrompt: stableSystemPrompt(""),
    }) });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe("provider request admitted");
    expect(info.mock.calls[0]?.[1]).toMatchObject({ model: "gpt-5.5", family: "openai", candidates: ["openai_api"] });
    expect(JSON.stringify(info.mock.calls)).not.toContain("credential-bytes");
    info.mockRestore();
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ownHistoryTarget } from "../_model-client.js";

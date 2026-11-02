import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureSubscriptionCredentials } from "../../../../../src/infra/auth/auth-context.js";
import { AuthProfileStore } from "../../../../../src/infra/auth/auth-profile-store.js";
import { accessProviderAccountKey, createAccessProviderSelection } from "../../../../../src/infra/llm/access-provider.js";
import { createModelListingClient, type ModelDiscoveryMode } from "../../../../../src/infra/llm/model-listing.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import type { CliLoginDescription, QueryLauncherConfig } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { createClaudeAgentSdkModule } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/module.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { modelInfo } from "../../../../helpers/model-tier-fixtures.js";
import { AUTH_NONE } from "../../config/_model-listing-fixtures.js";
import { LOGIN_ACCOUNTS_DIRECTORY } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js";

const temporaryDirectory = temporaryDirectories();
const ACCOUNT = { kind: "subscription", providerId: "claude_agent_sdk", instanceId: "uuid-person", spendMode: "included" } as const;

const callerScope: LauncherScope = {
  spawnOwned: () => Promise.reject(new Error("no launch in a unit test")),
  adoptOwned: () => Promise.reject(new Error("no adoption in a unit test")),
  open: () => callerScope,
  close: async () => ({ settled: true }),
};

/** The CLI lineup of a Max login: `default` and `opus` resolve to one model, and Haiku 5.5 is newer than models.dev. */
const LINEUP: ModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5", supportedEffortLevels: ["low", "high", "max"] },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "Haiku 5.5" },
];

/** models.dev knows Opus 5.5 and Fable 5.1, which the CLI lists, and Opus 4.8, which it omits. */
function modelsDevRow(wireModelId: string, modelId: string) {
  return {
    providerId: "anthropic", providerName: "Anthropic", wireModelId, dataUse: "standard" as const,
    metadata: modelInfo("anthropic", wireModelId, "claude", 5, 25, "2026-09-01"),
    provenance: "live" as const, canonical: { providerId: "anthropic", modelId }, transport: { npm: "@ai-sdk/anthropic" },
  };
}
const MODELS_DEV = [modelsDevRow("claude-opus-5-5", "claude-opus-5.5"), modelsDevRow("claude-fable-5-1", "claude-fable-5.1"), modelsDevRow("claude-opus-4-8", "claude-opus-4.8")];

async function listingFixture(describeLogin: (config: QueryLauncherConfig, signal: AbortSignal) => Promise<CliLoginDescription>) {
  // A scratch OS account whose profile holds one Claude login.
  const home = temporaryDirectory("flywheel-sdk-catalog-");
  const profile = await new AuthProfileStore(join(home, ".flywheel")).create("claude-sdk");
  profile.close();
  const authDir = profile.authDirectory;
  const configDir = join(authDir, LOGIN_ACCOUNTS_DIRECTORY, "a");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
  const { definition } = createClaudeAgentSdkModule({ account: () => ({ home, user: "person" }), enginePath: "/scratch/bin/claude", describeLogin }).contributions[0].value;
  const classifySlot = () => "subscription" as const;
  const client = createModelListingClient({
    authDir,
    classifySlot,
    providers: createAccessProviderSelection([definition]),
    modelsClient: { refresh: async () => {}, getTokenizerIdentity: () => undefined, getProviderCatalog: () => MODELS_DEV },
    captureSubscriptions: () => captureSubscriptionCredentials([definition], { kind: "persisted", authDir, classifySlot, report: false }),
  });
  const list = async (mode: ModelDiscoveryMode, launcher: LauncherScope | null = callerScope) => {
    const listed = await client.getModelCatalogs(AUTH_NONE, { mode, ...(launcher === null ? {} : { launcher }) });
    const candidate = listed.candidates.get(accessProviderAccountKey(ACCOUNT));
    const offerings = [...candidate?.models?.values() ?? []].flat();
    return {
      outcome: candidate?.outcome,
      wireModelIds: offerings.map(({ wireModelId }) => wireModelId).toSorted(),
      cliValues: Object.fromEntries(offerings.map(({ wireModelId, metadata }) => [wireModelId, typeof metadata === "object" && metadata !== null && "cli_value" in metadata ? metadata.cli_value : undefined])),
    };
  };
  return { list, configDir };
}

describe("the Agent SDK provider's live model catalog", () => {
  test("a fresh listing asks the CLI in the caller's scope, keeps one row per model, and joins the models.dev rows the CLI omits; a cached-first listing reuses the saved rows without a launch", async () => {
    const launches: { readonly launcher: LauncherScope; readonly configDir: string }[] = [];
    const { list, configDir } = await listingFixture(async (config) => {
      launches.push({ launcher: config.launcher, configDir: config.configDir });
      return { models: LINEUP, loggedIn: true };
    });

    const fresh = await list("fresh");
    expect(launches).toEqual([{ launcher: callerScope, configDir }]);
    expect(fresh.outcome).toMatchObject({ kind: "catalog", provenance: "first-party", liveOutcome: "valid" });
    expect(fresh.wireModelIds).toEqual(["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-5-5"]);
    expect(fresh.cliValues).toEqual({ "claude-opus-5-5": "opus", "claude-fable-5-1": "claude-fable-5-1[1m]", "claude-haiku-5-5": "haiku", "claude-opus-4-8": undefined });

    const cached = await list("cached-first");
    expect(launches).toHaveLength(1);
    expect(cached.outcome).toMatchObject({ kind: "catalog", provenance: "first-party-cached" });
    expect(cached.wireModelIds).toEqual(fresh.wireModelIds);
  });

  test("a CLI with no login makes the account's catalog unavailable, as a refused key does on the native provider", async () => {
    const { list } = await listingFixture(async () => ({ models: LINEUP, loggedIn: false }));

    expect((await list("fresh")).outcome).toEqual({ kind: "unavailable", reason: "authentication-invalid" });
  });

  test("a listing without launch authority, or a CLI that fails to start, falls back to the models.dev rows", async () => {
    const launches: string[] = [];
    const { list } = await listingFixture(async () => {
      launches.push("launch");
      throw new Error("spawn claude ENOENT");
    });

    const unlaunched = await list("fresh", null);
    expect(launches).toEqual([]);
    expect(unlaunched.outcome).toMatchObject({ kind: "catalog", provenance: "models-dev-live", liveOutcome: "discovery-failed" });
    expect(unlaunched.wireModelIds).toEqual(["claude-fable-5-1", "claude-opus-4-8", "claude-opus-5-5"]);
    const failed = await list("fresh");
    expect(launches).toEqual(["launch"]);
    expect(failed.outcome).toMatchObject({ kind: "catalog", provenance: "models-dev-live", liveOutcome: "discovery-failed" });
  });
});

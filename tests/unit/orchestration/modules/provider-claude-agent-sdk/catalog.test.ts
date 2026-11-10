import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureSubscriptionCredentials } from "../../../../../src/infra/auth/auth-context.js";
import { AuthProfileStore } from "../../../../../src/infra/auth/auth-profile-store.js";
import { accessProviderAccountKey, createAccessProviderSelection } from "../../../../../src/infra/llm/access-provider.js";
import { createModelListingClient, type AccessAuditProgressListener, type ModelDiscoveryMode } from "../../../../../src/infra/llm/model-listing.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import type { CliLoginDescription, CliModelProbe, QueryLauncherConfig } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
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
const LISTED = ["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-5-5"];

/** models.dev knows Opus 5.5 and Fable 5.1, which the CLI lists, and Opus 4.8 and the sentinel, which it omits. */
function modelsDevRow(wireModelId: string, modelId: string) {
  return {
    providerId: "anthropic", providerName: "Anthropic", wireModelId, dataUse: "standard" as const,
    metadata: modelInfo("anthropic", wireModelId, "claude", 5, 25, "2026-09-01"),
    provenance: "live" as const, canonical: { providerId: "anthropic", modelId }, transport: { npm: "@ai-sdk/anthropic" },
  };
}
const MODELS_DEV = [
  modelsDevRow("claude-opus-5-5", "claude-opus-5.5"), modelsDevRow("claude-fable-5-1", "claude-fable-5.1"),
  modelsDevRow("claude-opus-4-8", "claude-opus-4.8"), modelsDevRow("claude-sentinel-9", "claude-sentinel-9"),
];
/** What the engine's token count observed for a model that the login serves, one that it refuses, and a count that
 *  failed for another reason, such as a rate limit (engine 2.1.306). */
const SERVED: CliModelProbe = { totalTokens: 10, refused: false };
const REFUSED: CliModelProbe = { totalTokens: 0, refused: true };
const COUNT_FAILED: CliModelProbe = { totalTokens: 0, refused: false };

interface Probe { readonly launcher: LauncherScope; readonly wireModelId: string }

async function listingFixture(
  describeLogin: (config: QueryLauncherConfig, signal: AbortSignal) => Promise<CliLoginDescription>,
  probeReply: (wireModelId: string) => CliModelProbe = () => { throw new Error("no probe expected"); },
) {
  // A scratch OS account whose profile holds one Claude login.
  const home = temporaryDirectory("flywheel-sdk-catalog-");
  const profile = await new AuthProfileStore(join(home, ".flywheel")).create("claude-sdk");
  profile.close();
  const authDir = profile.authDirectory;
  const configDir = join(authDir, LOGIN_ACCOUNTS_DIRECTORY, "a");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com" } }));
  const probes: Probe[] = [];
  const probeModel = async (config: QueryLauncherConfig, wireModelId: string) => {
    probes.push({ launcher: config.launcher, wireModelId });
    return probeReply(wireModelId);
  };
  const { definition } = createClaudeAgentSdkModule({ account: () => ({ home, user: "person" }), enginePath: "/scratch/bin/claude", describeLogin, probeModel }).contributions[0].value;
  const classifySlot = () => "subscription" as const;
  const client = createModelListingClient({
    authDir,
    classifySlot,
    providers: createAccessProviderSelection([definition]),
    modelsClient: { refresh: async () => {}, getTokenizerIdentity: () => undefined, getProviderCatalog: () => MODELS_DEV },
    captureSubscriptions: () => captureSubscriptionCredentials([definition], { kind: "persisted", authDir, classifySlot, report: false }),
  });
  const list = async (mode: ModelDiscoveryMode, options: { readonly launcher?: LauncherScope | null; readonly recheck?: boolean; readonly onAccessAudit?: AccessAuditProgressListener } = {}) => {
    const launcher = options.launcher === undefined ? callerScope : options.launcher;
    const listed = await client.getModelCatalogs(AUTH_NONE, { mode, ...(launcher === null ? {} : { launcher }), ...(options.recheck === true ? { recheckAccount: ACCOUNT } : {}), ...(options.onAccessAudit === undefined ? {} : { onAccessAudit: options.onAccessAudit }) });
    const candidate = listed.candidates.get(accessProviderAccountKey(ACCOUNT));
    const offerings = [...candidate?.models?.values() ?? []].flat();
    return {
      outcome: candidate?.outcome,
      audit: candidate?.audit,
      wireModelIds: offerings.map(({ wireModelId }) => wireModelId).toSorted(),
      visibleWireModelIds: [...candidate?.visibleModels?.values() ?? []].flat().map(({ wireModelId }) => wireModelId).toSorted(),
      cliValues: Object.fromEntries(offerings.map(({ wireModelId, metadata }) => [wireModelId, typeof metadata === "object" && metadata !== null && "cli_value" in metadata ? metadata.cli_value : undefined])),
    };
  };
  const refuseOnSend = (wireModelId: string) => client.recordModelRefusal({ auth: AUTH_NONE, subscriptions: captureSubscriptionCredentials([definition], { kind: "persisted", authDir, classifySlot, report: false }), candidate: ACCOUNT, wireModelId, refusal: { kind: "model" } });
  return { list, configDir, probes, refuseOnSend };
}

describe("the Agent SDK provider's live model catalog", () => {
  test("the CLI's lineup serves at once in every listing mode, and the models.dev rows it omits show pending with no probe; a cached-first listing launches nothing", async () => {
    const launches: { readonly launcher: LauncherScope; readonly configDir: string }[] = [];
    const { list, configDir, probes } = await listingFixture(async (config) => {
      launches.push({ launcher: config.launcher, configDir: config.configDir });
      return { models: LINEUP, loggedIn: true };
    });

    const fresh = await list("fresh");
    expect(launches).toEqual([{ launcher: callerScope, configDir }]);
    expect(fresh.outcome).toMatchObject({ kind: "catalog", provenance: "first-party", liveOutcome: "valid" });
    expect(fresh.wireModelIds).toEqual(LISTED);
    expect(fresh.visibleWireModelIds).toEqual([...LISTED, "claude-opus-4-8", "claude-sentinel-9"].toSorted());
    expect(fresh.cliValues).toEqual({ "claude-opus-5-5": "opus", "claude-fable-5-1": "claude-fable-5-1[1m]", "claude-haiku-5-5": "haiku" });
    expect(fresh.audit).toEqual({ remaining: 2, refused: 0 });

    const cached = await list("cached-first");
    expect(launches).toHaveLength(1);
    expect(cached.outcome).toMatchObject({ kind: "catalog", provenance: "first-party-cached" });
    expect(cached.wireModelIds).toEqual(LISTED);
    expect(cached.visibleWireModelIds).toEqual(fresh.visibleWireModelIds);

    expect((await list("refresh")).wireModelIds).toEqual(LISTED);
    expect(launches).toHaveLength(2);
    expect(probes).toEqual([]);
  });

  test("an audit counts each omitted model's tokens on the login in the caller's scope: a positive count admits it, a refusal hides it, and both outlast an inconclusive recheck", async () => {
    let reply = (wireModelId: string): CliModelProbe => wireModelId === "claude-sentinel-9" ? REFUSED : SERVED;
    const { list, probes } = await listingFixture(async () => ({ models: LINEUP, loggedIn: true }), (wireModelId) => reply(wireModelId));
    await list("refresh");

    await list("audit");
    expect(probes.map(({ wireModelId }) => wireModelId).toSorted()).toEqual(["claude-opus-4-8", "claude-sentinel-9"]);
    expect(probes.every(({ launcher }) => launcher === callerScope)).toBe(true);
    const audited = await list("cached-first");
    expect(audited.wireModelIds).toEqual([...LISTED, "claude-opus-4-8"].toSorted());
    expect(audited.visibleWireModelIds).toEqual(audited.wireModelIds);
    expect(audited.audit).toEqual({ remaining: 0, refused: 1 });

    // A manual recheck makes every candidate due again. An inconclusive answer, such as a rate limit, speaks for the
    // login, so it ends the pass with one engine launch, and every earlier result stays.
    reply = () => COUNT_FAILED;
    await list("audit", { recheck: true });
    expect(probes).toHaveLength(3);
    const rechecked = await list("cached-first");
    expect(rechecked.wireModelIds).toEqual(audited.wireModelIds);
    expect(rechecked.audit).toEqual({ remaining: 2, refused: 1 });
  });

  test("every audit pass checks a refused model again and never a completed one, and a refused model that passes serves and ends its send refusal", async () => {
    let reply = (wireModelId: string): CliModelProbe => wireModelId === "claude-sentinel-9" ? REFUSED : SERVED;
    const { list, probes, refuseOnSend } = await listingFixture(async () => ({ models: LINEUP, loggedIn: true }), (wireModelId) => reply(wireModelId));
    await list("refresh");
    await list("audit");
    expect(await refuseOnSend("claude-sentinel-9")).toBe(true);
    probes.length = 0;

    // The next pass checks only the refused model; it is refused again and stays hidden.
    await list("audit");
    expect(probes.map(({ wireModelId }) => wireModelId)).toEqual(["claude-sentinel-9"]);
    expect((await list("cached-first")).visibleWireModelIds).toEqual([...LISTED, "claude-opus-4-8"].toSorted());

    // An inconclusive check keeps the refusal.
    reply = () => COUNT_FAILED;
    await list("audit");
    expect((await list("cached-first")).audit).toEqual({ remaining: 0, refused: 1 });

    // The login gains the model: the pass admits it, and the refusal that a request proved ends with it, already in the
    // listing that publishes the pass's progress.
    reply = () => SERVED;
    const progress: string[][] = [];
    await list("audit", { onAccessAudit: async () => { progress.push((await list("cached-first")).wireModelIds); } });
    expect(progress).toEqual([[...LISTED, "claude-opus-4-8", "claude-sentinel-9"].toSorted()]);
    expect(probes.map(({ wireModelId }) => wireModelId)).toEqual(["claude-sentinel-9", "claude-sentinel-9", "claude-sentinel-9"]);
    const gained = await list("cached-first");
    expect(gained.wireModelIds).toEqual([...LISTED, "claude-opus-4-8", "claude-sentinel-9"].toSorted());
    expect(gained.audit).toEqual({ remaining: 0, refused: 0 });

    // Nothing is refused or due now, so a pass checks nothing.
    await list("audit");
    expect(probes).toHaveLength(3);
  });

  test("a CLI with no login makes the account's catalog unavailable, as a refused key does on the native provider", async () => {
    const { list } = await listingFixture(async () => ({ models: LINEUP, loggedIn: false }));

    expect((await list("fresh")).outcome).toEqual({ kind: "unavailable", reason: "authentication-invalid" });
  });

  test("a listing without launch authority, or a CLI that fails to start, serves no models.dev row: each shows pending", async () => {
    const launches: string[] = [];
    const { list } = await listingFixture(async () => {
      launches.push("launch");
      throw new Error("spawn claude ENOENT");
    });

    const unlaunched = await list("fresh", { launcher: null });
    expect(launches).toEqual([]);
    expect(unlaunched.outcome).toMatchObject({ kind: "unavailable", reason: "discovery-failed" });
    expect(unlaunched.wireModelIds).toEqual([]);
    expect(unlaunched.visibleWireModelIds).toEqual(["claude-fable-5-1", "claude-opus-4-8", "claude-opus-5-5", "claude-sentinel-9"]);
    const failed = await list("refresh");
    expect(launches).toEqual(["launch"]);
    expect(failed.outcome).toEqual({ kind: "unavailable", reason: "discovery-pending" });
    expect(failed.wireModelIds).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { comparabilityProblem, modelComparisonProblem, openCampaignStore, type CampaignConfig } from "../../../bench/chat-ab/store.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();
const seat = { role: "chat", model: "claude-opus-5", effort: "medium" };
const native = { id: "anthropic-api", identity: "arm-n", provider: "anthropic_api", profileId: "bench-api" };
const sdk = { id: "anthropic-sdk", identity: "arm-s", provider: "anthropic_sdk", profileId: "bench-cli" };
function workflowConfig(arm: CampaignConfig["arm"], overrides: Partial<CampaignConfig> = {}): CampaignConfig {
  return {
    kind: "chat-ab-config", scoringVersion: "chat-ab-v3", arm,
    cell: { kind: "workflow", workflow: "debug", modelProfileIdentity: "profile-1" },
    agent: { revision: "abc", sourceIdentity: "src-1", accountSkillsIdentity: "skills-1", composedModules: [], composedTools: [] },
    tasks: [{ id: "cut-tool-args", stratum: "bug", contentIdentity: "task-1", timeoutMs: 60_000 }], repeats: 4,
    chat: seat, roles: [seat], authProfile: arm.profileId ?? "Personal", profileId: arm.profileId ?? "personal",
    authorityIncarnation: "incarnation-1", providerPlans: [{ model: "claude-opus-5", providers: [arm.provider ?? "anthropic_api"] }],
    createdAt: "2026-10-07T00:00:00.000Z", ...overrides,
  };
}

test("historical provider campaigns retain their comparison contract", () => {
  expect(comparabilityProblem(workflowConfig(native), workflowConfig(sdk))).toBeUndefined();
  expect(comparabilityProblem(workflowConfig(native), workflowConfig({ ...native, identity: "arm-n" }))).toBeUndefined();
  expect(comparabilityProblem(workflowConfig(native), workflowConfig({ ...native, profileId: "other" }))).toContain("Both campaigns ran arm anthropic-api");
  expect(comparabilityProblem(workflowConfig(native), workflowConfig({ ...native, provider: "openrouter" }))).toContain("on anthropic_api with profile bench-api and on openrouter");
  const { cell: _cell, ...chat } = workflowConfig({ id: "baseline", identity: null });
  expect(comparabilityProblem(workflowConfig(native), chat)).toBe("One campaign ran chat cells and the other ran workflow cells");
  expect(comparabilityProblem(workflowConfig(native), workflowConfig(sdk, { cell: { kind: "workflow", workflow: "debug", modelProfileIdentity: "profile-2" } }))).toContain("different agents");
  expect(comparabilityProblem(chat, { ...chat, profileId: "other" })).toContain("different agents");
  const settings = (configIdentity: string) => workflowConfig(native, { agent: { revision: "abc", sourceIdentity: "src-1", accountSkillsIdentity: "skills-1", composedModules: [], composedTools: [], configIdentity } });
  expect(comparabilityProblem(settings("settings-1"), settings("settings-2"))).toContain("different agents");
});

test("historical model-profile campaigns retain model comparison and strict decoding", async () => {
  const sonnet = { role: "chat", model: "claude-sonnet-5.5", effort: "medium" };
  const opus = workflowConfig(native);
  const other = workflowConfig(native, { chat: sonnet, roles: [sonnet], cell: { kind: "workflow", workflow: "debug", modelProfileIdentity: "profile-2" } });
  expect(comparabilityProblem(opus, other)).toContain("different agents");
  expect(modelComparisonProblem(opus, other)).toBeUndefined();
  expect(modelComparisonProblem(opus, workflowConfig(sdk, { chat: sonnet, roles: [sonnet] }))).toContain("different arms");
  expect(modelComparisonProblem(opus, { ...other, agent: { ...other.agent, sourceIdentity: "src-2" } })).toContain("different Flywheel source");
  expect(modelComparisonProblem(opus, { ...other, cell: { kind: "workflow", workflow: "gsd", modelProfileIdentity: "profile-2" } })).toBe("The campaigns ran the debug and gsd workflows");
  const { cell: _cell, ...chat } = other;
  expect(modelComparisonProblem(opus, chat)).toBe("A model comparison pairs two workflow campaigns");
  const store = await openCampaignStore(temporary("historical-workflow-store-"));
  await store.createConfig(opus);
  expect(await store.loadConfig()).toEqual(opus);
});

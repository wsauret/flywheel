import { expect, test } from "bun:test";
import { NO_MODULE_RUNTIMES } from "../../../../../src/infra/module-runtime.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { createRequestToolSurface } from "../../../../../src/orchestration/agent-runtime/request-tool-surface.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { buildSystemPrompt } from "../../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { resolveCapturedRole } from "../../../../../src/orchestration/config/role-resolution.js";
import { roleCapture } from "../../../../helpers/role-capture.js";
import { RequestToolMap, testKernelToolDeps, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import type { FlywheelConfig } from "../../../../../src/orchestration/config/schema.js";
import { createModelsTool } from "../../../../../src/orchestration/agent-runtime/tools/models.js";
import { Effect, Exit, Scope } from "effect";
import { createTurnDispatcher } from "../../../../../src/orchestration/agent-runtime/agent-loop-tools.js";
import { fixedTurnOutputBound } from "../../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js";
import { settleTurn } from "../../../../../src/orchestration/agent-runtime/agent-turn-settlement.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import type { StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { join } from "node:path";
import { normalizeModelScores } from "../../../../../src/infra/llm/model-scores-document.js";

function snapshot(models: readonly string[]) {
  return normalizeModelScores({
    items: models.map((id) => ({
      slug: id.toLowerCase().replaceAll(".", "-"), benchmarks: { coding: { a: 10, b: 20, c: 30, d: 40, e: 50 } },
    })),
  }, { items: [] }, undefined, new Date("2026-10-19T00:00:00Z"));
}

test("models reads live eligibility while its request prefix stays byte-identical", async () => {
  let enabled = ["gpt-6-luna"];
  let profileRoles: FlywheelConfig["profiles"][string]["roles"] = { "workflow-agent": { model: "gpt-6-luna", effort: "low" } };
  const capture = async () => roleCapture(enabled, profileRoles);
  const root = temporaryDirectory("models-prefix-");
  await Bun.write(join(root, "models", "benchmark-tiers.json"), JSON.stringify({ attemptedAt: Date.now(), snapshot: null }));
  const kernel = testKernelToolDeps({ captureProviderConnection: capture, userDataRoot: root });
  const owner = await createRequestToolSurface(
    () => planToolExposure({ kernel, modules: NO_MODULE_RUNTIMES }), () => kernel.moduleSnapshot, testRuntimeConfigCapture,
  );
  const prefix = async () => {
    const request = await owner.resolve();
    const prepared = await request.prepareStablePrompt(
      () => buildSystemPrompt({ corePrompt: "core", tools: [...request.tools.values()], promptKind: "chat" }),
      DEFAULT_MODEL_INTERACTION_PROFILE,
    );
    return { request, bytes: JSON.stringify({ system: renderSystemPrompt(prepared.systemPrompt), tools: prepared.definitions }) };
  };
  const before = await prefix();
  const tool = before.request.tools.get("models");
  expect(tool).toBeDefined();
  if (!tool) throw new Error("models must be available");
  const context = { executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "models", retrievalSessionId: "models" };
  const first = await tool.execute({}, context);
  expect(first.outcome).toBe("ok");
  expect(typeof first.content).toBe("string");
  if (typeof first.content !== "string") throw new Error("models must return JSON text");
  const listed = JSON.parse(first.content);
  expect(listed.models).toEqual({
    columns: ["id", "name", "providers", "releaseDate", "knowledgeCutoff", "inputPerMillion", "cachedInputPerMillion", "outputPerMillion", "supportedEfforts", "contextWindow"],
    rows: [["gpt-6-luna", "gpt-6-luna", ["OpenAI API Key"], "2026-10-01", null, 2, null, 8, ["low", "medium", "high"], 200_000]],
  });
  expect(listed.tiersUnavailableReason).toBe("Tiers unavailable: no cached benchmark data.");
  expect(listed.modelTiers).toBeUndefined();
  const current = await capture();
  for (const tier of ["cheap", "mid", "powerful"]) {
    const resolved = await resolveCapturedRole("workflow-agent", { model: tier }, {
      selection: current.providers.selection, connection: current.connection, eligibility: current.eligibility,
      allowTrainingRoutes: current.runtimeConfig.allowTrainingRoutes,
    }, "/scratch");
    expect(listed.tiers[tier]).toEqual(resolved.kind === "selected" ? { model: resolved.role.model } : { unavailable: resolved.kind });
  }
  expect(listed.workflowAgentDefault).toEqual({ model: "gpt-6-luna", effort: "low" });
  enabled = ["claude-opus-5.5"];
  profileRoles = { "workflow-agent": { model: "claude-opus-5.5", effort: "high" } };
  const second = await tool.execute({}, context);
  if (typeof second.content !== "string") throw new Error("models must return JSON text");
  const changed = JSON.parse(second.content);
  expect(changed.models.rows.map((row: unknown[]) => row[0])).toEqual(["claude-opus-5.5"]);
  expect(changed.models.rows[0][4]).toBe("June 2026");
  expect(changed.workflowAgentDefault).toEqual({ model: "claude-opus-5.5", effort: "high" });
  expect((await prefix()).bytes).toBe(before.bytes);
  enabled = [];
  const empty = await tool.execute({}, context);
  if (typeof empty.content !== "string") throw new Error("models must return JSON text");
  expect(JSON.parse(empty.content)).toMatchObject({ models: { rows: [] }, workflowAgentDefault: { unavailable: "no-selection" } });
});

test("models returns tiers per supported effort with attribution and exact absence reasons, never raw benchmarks", async () => {
  const tool = createModelsTool(async () => roleCapture(["gpt-6-luna", "claude-opus-5.5", "gpt-unmapped"]), "/scratch",
    async () => snapshot(["gpt-6-luna"]), () => ["gpt-6-luna", "gpt-unmapped"]);
  const result = await tool.execute({}, {
    executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "models-scores", retrievalSessionId: "models-scores",
  });
  if (typeof result.content !== "string") throw new Error("models must return JSON text");
  const output = JSON.parse(result.content);
  expect(output.attribution).toBe("Tiers derived by Flywheel from Terminal-Bench and BenchLM.ai data.");
  expect(output.tiersUpdatedAt).toBe("2026-10-19T00:00:00.000Z");
  expect(output.modelTiers).toEqual({
    columns: ["model", "effort", "qualityTier", "speedTier", "costTier"],
    rows: [["gpt-6-luna", "low", 10, null, null], ["gpt-6-luna", "medium", 10, null, null], ["gpt-6-luna", "high", 10, null, null]],
  });
  expect(output.models.columns.slice(-2)).toEqual(["tiersUnavailableReason", "qualityEffortNote"]);
  expect(output.models.rows.map((row: unknown[]) => [row[0], row.at(-2)])).toEqual([
    ["gpt-6-luna", null],
    ["claude-opus-5.5", "Out of scope: tiers cover recent first-party provider models only."],
    ["gpt-unmapped", "Unmatched: no exact BenchLM slug for this model."],
  ]);
  expect(Object.keys(output).sort()).toEqual(["attribution", "modelTiers", "models", "notes", "terminalBenchAvailable", "tiers", "tiersUpdatedAt", "workflowAgentDefault"]);
});

const temporaryDirectory = temporaryDirectories();

test("models preserves a complete 70-model tiered catalog through result finalization", async () => {
  const models = Array.from({ length: 70 }, (_, index) => `gpt-catalog-${index}-${"long-model-name-".repeat(3)}`);
  const tool = createModelsTool(async () => roleCapture(models), "/scratch", async () => snapshot(models), () => models);
  const root = temporaryDirectory("models-table-");
  const events: StreamEvent[] = [];
  const turnScope = Scope.makeUnsafe();
  const call = { id: "models-catalog", name: "models", input: {} };
  const onEvent = (event: StreamEvent) => { events.push(event); };
  const dispatcher = createTurnDispatcher({
    tools: new RequestToolMap([["models", tool]]), executionAdmission: () => ({ ok: true }),
    toolContext: { executionCwd: root, userDataRoot: `${root}/.test-account`, projectRoot: root, artifactScopeId: "models", retrievalSessionId: "models" },
    signal: undefined, background: undefined, turnScope, afterToolCall: undefined, onEvent, artifactScopeId: "models",
    outputBound: fixedTurnOutputBound(undefined),
  });
  try {
    dispatcher.onToolUse(call);
    await Effect.runPromise(settleTurn({
      dispatcher, stream: () => Promise.resolve(), commitAssistant: () => [call],
      commitAssistantBarrier: async () => {}, commitResults: async () => {}, commitDisplayBarrier: async () => {},
      onEvent, publishTerminal: () => {}, publishSettlement: () => {},
    }));
    const result = events.find((event) => event.kind === "tool_result");
    if (result?.kind !== "tool_result") throw new Error("expected finalized models result");
    const text = result.content[0];
    if (text?.type !== "text") throw new Error("expected JSON text");
    expect(Buffer.byteLength(text.text)).toBeGreaterThan(30_000);
    expect(result.contentTruncated).toBeUndefined();
    const output = JSON.parse(text.text);
    expect(output.models.rows).toHaveLength(70);
    expect(output.modelTiers.rows).toHaveLength(210);
    expect(output.models.rows.map((row: unknown[]) => row[0])).toEqual(models);
  } finally {
    await Effect.runPromise(Scope.close(turnScope, Exit.void));
  }
});

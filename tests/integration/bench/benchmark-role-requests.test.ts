import { afterEach, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitBenchmark } from "../../../src/orchestration/modules/development/benchmark/admission.js";
import { runPersonaTask } from "../../../src/orchestration/modules/development/benchmark/persona-run.js";
import { composeFirstPartyModules, SHIPPED_MODULES } from "../../../src/orchestration/modules.js";
import { DEVELOPMENT_MODULES } from "../../../src/orchestration/development-modules.js";
import type { AgentOptions } from "../../../src/orchestration/agent-runtime/types.js";
import { asModelClient } from "../../unit/orchestration/agent-runtime/_model-client.js";
import { newTestRunner } from "../../helpers/agent-runner.js";
import { roleCapture } from "../../helpers/role-capture.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";
import { testDirectories } from "../../helpers/directories.js";

let root: string | undefined;
let work: Promise<void> | undefined;

afterEach(async () => {
  // Bun can start teardown after a test timeout while its promise still runs.
  // Its runner and judge must settle before their evidence directory is removed.
  await Promise.allSettled(work === undefined ? [] : [work]);
  if (root) await rm(root, { recursive: true, force: true });
  work = undefined;
  root = undefined;
});

async function verifyRoleRequests(): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), "flywheel-benchmark-roles-"));
  root = projectRoot;
  const directories = testDirectories(root);
  let models = ["gpt-6-luna", "gpt-6.1-sol"];
  const outgoing: { model: string; effort: string | undefined }[] = [];
  const client = async (model: string) => asModelClient({
    model, modelFamily: model.startsWith("claude") ? "anthropic" : "openai", accessProvider: "openai_api",
    contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: true,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools(input) {
      outgoing.push({ model, effort: input.reasoningEffort });
      if (input.tools.some((tool) => tool.name === "handoff")) {
        yield { kind: "tool_use", toolCall: { id: crypto.randomUUID(), name: "handoff", input: { summary: "resolved answer", files_modified: [] } } };
        yield { kind: "done", stopReason: "tool_use" };
      } else {
        yield { kind: "text_delta", blockKey: "text", text: "resolved answer" };
        yield { kind: "done", stopReason: "end_turn" };
      }
    },
  });
  const createAgent = (options: AgentOptions) => newTestRunner(options, client);
  const admission = await admitBenchmark({
    ...directories, profileId: "default", authorityIncarnation: "test-incarnation", definitions: repoDefinitions(),
    moduleSelection: () => composeFirstPartyModules([...SHIPPED_MODULES, ...DEVELOPMENT_MODULES]),
    runOwnedCommand: () => { throw new Error("no command may be launched in this harness"); },
    captureProviderConnection: async () => ({
      ...roleCapture(models, { explorer: { model: "gpt-6.1-sol", effort: "low" }, "benchmark-judge": { model: "lost-judge", effort: "low" } }),
      admit: () => ({ createAgent, createLLMClient: client }),
    }),
  }, [{ role: "candidate", roleId: "explorer", model: "lost-candidate", effort: "low" }, { role: "judge" }]);
  const persona = { kind: "persona", name: "explorer", role: "explorer", description: "Inspect.", systemPrompt: "Inspect.", maxTurns: 1, tools: [] } as const;
  for (const [index, seat] of [{ model: "lost-candidate", effort: "low" as const }, {}].entries()) {
    await runPersonaTask(admission.runtime, {
      persona, seat, label: `candidate-${index}`, prompt: "Answer.", workspace: root,
      transcriptPath: join(root, `candidate-${index}`, "transcript.jsonl"),
    });
  }
  const judge = await admission.createJudge(undefined, undefined, undefined, join(root, "judge-requests"));
  await judge.complete("Judge.", new AbortController().signal);
  models = ["claude-haiku-4.5", "claude-opus-5.5"];
  await judge.complete("Judge again.", new AbortController().signal);
  expect(outgoing).toEqual([
    { model: "gpt-6-luna", effort: "high" },
    { model: "gpt-6.1-sol", effort: "low" },
    { model: "gpt-6.1-sol", effort: "high" },
    { model: "claude-opus-5.5", effort: "high" },
  ]);
  expect(await Bun.file(join(root, "candidate-0", "roles.json")).json()).toMatchObject({ explorer: { model: "gpt-6-luna", effort: "high" } });
  const judgeCalls = await readdir(join(root, "judge-requests", "default"));
  const judgeEvidence = await Promise.all(judgeCalls.map((id) => Bun.file(join(projectRoot, "judge-requests", "default", id, "roles.json")).json()));
  expect(judgeEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ "benchmark-judge": { model: "gpt-6.1-sol", effort: "high" } }),
    expect.objectContaining({ "benchmark-judge": { model: "claude-opus-5.5", effort: "high" } }),
  ]));
  const constrained = await admission.createJudge("lost-judge", "", "low", undefined, (model) => {
    if (model === "claude-opus-5.5") throw new Error("same-family scoring is not allowed");
  });
  await expect(constrained.complete("No provider call.", new AbortController().signal)).rejects.toThrow("same-family scoring is not allowed");
  expect(outgoing).toHaveLength(4);
}

it("resolves candidate and judge requests from current role policy and retains their selections", () => {
  work = verifyRoleRequests();
  return work;
});

import { afterEach, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitBenchmark } from "../../../src/orchestration/modules/development/benchmark/persona/admission.js";
import { runPersonaTask } from "../../../src/orchestration/modules/development/benchmark/persona/persona-run.js";
import { composeFirstPartyModules, SHIPPED_MODULES } from "../../../src/orchestration/modules.js";
import { DEVELOPMENT_MODULES } from "../../../src/orchestration/development-modules.js";
import type { AgentOptions } from "../../../src/orchestration/agent-runtime/types.js";
import { asModelClient } from "../../unit/orchestration/agent-runtime/_model-client.js";
import { newTestRunner } from "../../helpers/agent-runner.js";
import { roleCapture } from "../../helpers/role-capture.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";
import { testDirectories } from "../../helpers/directories.js";
import { testRuntimeConfigCapture } from "../../helpers/request-tool-surface.js";

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
  const admit = (profileRoles: Parameters<typeof roleCapture>[1], seats: Parameters<typeof admitBenchmark>[1]) => admitBenchmark({
    ...directories, profileId: "default", authorityIncarnation: "test-incarnation", definitions: repoDefinitions(),
    moduleSelection: () => composeFirstPartyModules([...SHIPPED_MODULES, ...DEVELOPMENT_MODULES]),
    captureRuntimeConfig: testRuntimeConfigCapture,
    runOwnedCommand: () => { throw new Error("no command may be launched in this harness"); },
    captureProviderConnection: async () => ({
      ...roleCapture(models, profileRoles),
      admit: () => ({ createAgent, createLLMClient: client }),
    }),
  }, seats);
  const roles = { explorer: { model: "gpt-6-luna", effort: "medium" }, "benchmark-judge": { model: "gpt-6.1-sol", effort: "high" } } as const;

  // A seat whose setting no account serves refuses the whole campaign at preflight and names that setting,
  // whether a candidate seat or the judge role's saved setting names it.
  expect(await admit(roles, [{ role: "candidate", roleId: "explorer", model: "lost-candidate", effort: "high" }, { role: "judge" }]).catch((error: unknown) => error))
    .toHaveProperty("message", expect.stringContaining('Benchmark candidate setting explorer "lost-candidate:high" cannot serve'));
  expect(await admit({ ...roles, "benchmark-judge": { model: "lost-judge", effort: "low" } }, [{ role: "judge" }]).catch((error: unknown) => error))
    .toHaveProperty("message", expect.stringContaining('Benchmark judge setting benchmark-judge "lost-judge:low" cannot serve'));
  expect(outgoing).toEqual([]);

  const admission = await admit(roles, [{ role: "candidate", roleId: "explorer", model: "gpt-6.1-sol", effort: "high" }, { role: "candidate", roleId: "explorer" }, { role: "judge" }]);
  const persona = { kind: "persona", name: "explorer", role: "explorer", description: "Inspect.", systemPrompt: "Inspect.", maxTurns: 1, tools: [] } as const;
  for (const [index, seat] of [{ model: "gpt-6.1-sol", effort: "high" as const }, {}].entries()) {
    await runPersonaTask(admission.runtime, {
      persona, seat, label: `candidate-${index}`, prompt: "Answer.", workspace: root,
      transcriptPath: join(root, `candidate-${index}`, "transcript.jsonl"),
    });
  }
  const judge = await admission.createJudge(undefined, undefined, undefined, join(root, "judge-requests"));
  await judge.complete("Judge.", new AbortController().signal);
  // Each seat's model is fixed at admission: a later change of the offered models never moves it (PI-MODEL-087).
  models = ["claude-haiku-4.5", "claude-opus-5.5"];
  await judge.complete("Judge again.", new AbortController().signal);
  expect(outgoing).toEqual([
    { model: "gpt-6.1-sol", effort: "high" },
    { model: "gpt-6-luna", effort: "medium" },
    { model: "gpt-6.1-sol", effort: "high" },
    { model: "gpt-6.1-sol", effort: "high" },
  ]);
  expect(await Bun.file(join(root, "candidate-0", "roles.json")).json()).toMatchObject({ explorer: { model: "gpt-6.1-sol", effort: "high" } });
  expect(await Bun.file(join(root, "candidate-1", "roles.json")).json()).toMatchObject({ explorer: { model: "gpt-6-luna", effort: "medium" } });
  const judgeCalls = await readdir(join(root, "judge-requests", "default"));
  const judgeEvidence = await Promise.all(judgeCalls.map((id) => Bun.file(join(projectRoot, "judge-requests", "default", id, "roles.json")).json()));
  expect(judgeEvidence).toEqual([
    expect.objectContaining({ "benchmark-judge": expect.objectContaining({ model: "gpt-6.1-sol", effort: "high" }) }),
    expect.objectContaining({ "benchmark-judge": expect.objectContaining({ model: "gpt-6.1-sol", effort: "high" }) }),
  ]);
  const constrained = await admission.createJudge("claude-opus-5.5", "", "high", undefined, (model) => {
    if (model === "claude-opus-5.5") throw new Error("same-family scoring is not allowed");
  });
  expect(await constrained.complete("No provider call.", new AbortController().signal).catch((error: unknown) => error)).toHaveProperty("message", expect.stringContaining("same-family scoring is not allowed"));
  expect(outgoing).toHaveLength(4);
}

it("refuses a seat no account serves, and fixes each served seat's role selection for every request and its evidence", () => {
  work = verifyRoleRequests();
  return work;
});

import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js";
import type { KernelToolDeps } from "../../../../../src/orchestration/agent-runtime/tools/kernel-tool-deps.js";
import { planToolExposure, type ToolExposureInput } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import type { AskUserController } from "../../../../../src/orchestration/runner/ask-user-controller.js";
import type { SubagentsRuntime } from "../../../../../src/orchestration/modules/subagents/execution/runtime-binding.js";
import { publishSkillRevision, type SkillDefinition, type SkillRegistryRevision } from "../../../../../src/workflows/skill-schema.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";
import { makeDeps as makeSubagentDeps } from "../subagent/_fixtures.js";

/** The account data root startup publishes. The account-global skill store
 *  every skill surface of a turn resolves against lives under it. */
export const { userDataRoot } = testDirectories(process.cwd());
/** A request that holds every optional capability. Every case that is not about
 *  policy states this: a context that owns no policy advertises no optional
 *  tool at all. */
export const ALL_CAPABILITIES = { available: () => true };

type RuntimeEntries = readonly (readonly [string, unknown])[];
/** One planned request: the kernel facts the case states over the neutral
 *  defaults, the module runtimes it wires, and the planner inputs beside them. */
export function plan(kernel: Partial<KernelToolDeps> = {}, runtimes: RuntimeEntries = [], rest: Omit<ToolExposureInput, "kernel" | "modules"> = {}) {
  return planToolExposure({ kernel: testKernelToolDeps({ userDataRoot, ...kernel }), modules: composeModuleRuntimes(runtimes), ...rest });
}

export function skillRevision(skills: readonly SkillDefinition[]): SkillRegistryRevision {
  return publishSkillRevision(1, new Map(skills.map((skill) => [skill.id, skill])));
}

export function subagentsRuntime(): SubagentsRuntime {
  return {
    toolDeps: () => makeSubagentDeps(),
    conversationId: "planner-conversation",
    resume: async () => { throw new Error("Resume is not used in this planner test") },
  };
}

export function askUserController(): AskUserController {
  return {
    ask: async () => { throw new Error("unused in this test"); },
    answerQuestion: () => {},
    cancelQuestion: () => {},
    suspendAll: () => false,
  };
}

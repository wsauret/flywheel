import { NO_MODULE_RUNTIMES } from "../../src/infra/module-runtime.js";
import { bashExecution } from "../unit/orchestration/agent-runtime/tools/bash/_bash-fixtures.js";
import type { ToolExposurePlan } from "../../src/orchestration/agent-runtime/tools/dispatch/tool-exposure-planner.js";
import { createRequestToolSurface, type PlannedRequest, type RequestToolSurfaceOwner } from "../../src/orchestration/agent-runtime/request/request-tool-surface.js";
import type { KernelToolDeps } from "../../src/orchestration/agent-runtime/tools/kernel-tool-deps.js";
import { NO_CAPABILITY_ACCESS, type RuntimeTool } from "../../src/orchestration/agent-runtime/tools/types.js";
import { composeFirstPartyModules } from "../../src/orchestration/module-contract/module-composition.js";
import { CONFIG_DEFAULTS } from "../../src/orchestration/config/schema/schema.js";
import { captureRuntimeConfigRequest, type CaptureRuntimeConfig } from "../../src/orchestration/config/request-config.js";
import { createToolRegistry } from "../../src/orchestration/agent-runtime/tools/dispatch/tool-catalog.js";
import { definitionAvailabilityOf } from "../../src/orchestration/config/policy/definition-availability.js";
import { contributedToolIdentities, treeCapabilityCheck } from "../../src/orchestration/agent-runtime/request/prompt/capability-checks.js";
import type { ProjectDefinitionRegistryRevision } from "../../src/workflows/definitions/definition-registry.js";
import type { AgentDefinition } from "../../src/infra/agent-definition.js";
import { publishSkillRevision } from "../../src/workflows/skills/skill-schema.js";
import type { ExecutionAdmission } from "../../src/orchestration/agent-runtime/tools/dispatch/tool-dispatch.js";
import type { FirstPartyModuleComposition } from "../../src/orchestration/module-contract/module-catalog.js";
const toolRegistrations = Object.fromEntries(createToolRegistry());


export const testCapabilityModules = () => composeFirstPartyModules();
export const testRuntimeConfigCapture: CaptureRuntimeConfig = () => captureRuntimeConfigRequest({
  revision: 0,
  config: CONFIG_DEFAULTS,
  warnings: [],
  diagnostics: [],
  sourceIdentity: "test",
  status: { kind: "valid" },
}, "default");

/** The general agent, which every installed persona registry holds. */
const GENERAL: ReadonlyMap<string, AgentDefinition> = new Map([["general", { kind: "general", name: "general", description: "A clone of the dispatching agent.", maxTurns: 200 }]]);

/** A definition revision that holds no skill and no persona beside the general agent. */
const NO_DEFINITIONS: ProjectDefinitionRegistryRevision = {
  skills: publishSkillRevision(1, new Map()),
  personaRevision: { revision: "none", personas: GENERAL, resolutions: [] },
  personas: GENERAL,
  resolutions: [],
};

/** The definition availability of a test request: `definitions` under `moduleIds`, for both the tree and the agent.
 *  By default only the general agent exists, as in every installed registry, so no skill term holds. */
export function testDefinitionAvailability(definitions: ProjectDefinitionRegistryRevision = NO_DEFINITIONS, moduleIds: Iterable<string> = []): KernelToolDeps["definitionAvailability"] {
  const snapshot = definitionAvailabilityOf(definitions, moduleIds, []);
  return { tree: snapshot, live: snapshot };
}

/** The kernel facts of one test request. A request that names no policy
 *  holds no optional capability, exactly as production does; every other
 *  field is the neutral value a chat turn would carry. The tree check derives
 *  from the resulting module snapshot and availability, as `requestKernel` derives it. A request that names its
 *  `skills` resolves their availability under its module snapshot, because production reads both from one
 *  definition revision. */
export function testKernelToolDeps(overrides: Partial<KernelToolDeps> = {}): KernelToolDeps {
  const moduleSnapshot = overrides.moduleSnapshot ?? testCapabilityModules();
  const deps = {
    userDataRoot: "/scratch/flywheel-test-account",
    capabilities: NO_CAPABILITY_ACCESS,
    definitionAvailability: testDefinitionAvailability(overrides.skills ? { ...NO_DEFINITIONS, skills: overrides.skills } : NO_DEFINITIONS, moduleSnapshot.enabledModuleIds),
    moduleSnapshot,
    runtimeConfig: testRuntimeConfigCapture(),
    shellWriteGuard: true,
    persistentProcessesAdvertised: false,
    purpose: { kind: "interactive-chat" } as const,
    servingModel: { model: "test-model", modelFamily: "anthropic" } as const,
    ...overrides,
  };
  return { treeCapabilities: treeCapabilityCheck(deps.moduleSnapshot, deps.definitionAvailability.tree, contributedToolIdentities(deps.moduleSnapshot)), ...deps };
}

/** Creates one explicit plan-owned request surface for loop tests. */
export async function fixedRequestToolSurface(tools: ReadonlyMap<string, RuntimeTool>): Promise<RequestToolSurfaceOwner> {
  const surface = await createRequestToolSurface(() => ({
    eligibleTools: tools,
    tools,
    omitted: [],
    usable: new Set(tools.keys()), turnedOff: [],
    registrationIds: new Map([...tools].map(([name, tool]) => [tool.name, name])),
    registrationIdentities: new Map([...tools].map(([name, tool]) => [tool.name, name])),
    kernel: testKernelToolDeps(),
  }), testCapabilityModules, testRuntimeConfigCapture);
  return {
    async resolve() {
      const resolved = await surface.resolve();
      return { ...resolved, executionAdmission: (toolName) => tools.has(toolName) ? { ok: true } : resolved.executionAdmission(toolName) };
    },
    current() {
      const current = surface.current();
      return { ...current, executionAdmission: (toolName) => tools.has(toolName) ? { ok: true } : current.executionAdmission(toolName) };
    },
  };
}

/** The capability admission of a request that plans `tools` under `moduleSnapshot`, as
 *  `RequestToolSurface.executionAdmission` decides it: a name that the snapshot's registry does not hold is refused,
 *  and so is a tool whose registration needs a module that the snapshot does not enable. */
export async function requestAdmission(tools: ReadonlyMap<string, RuntimeTool>, moduleSnapshot: FirstPartyModuleComposition = testCapabilityModules()): Promise<ExecutionAdmission> {
  const owner = await createRequestToolSurface(() => ({
    eligibleTools: tools,
    tools,
    omitted: [],
    usable: new Set(tools.keys()), turnedOff: [],
    registrationIds: new Map([...tools].map(([name, tool]) => [tool.name, name])),
    registrationIdentities: new Map([...tools].map(([name, tool]) => [tool.name, name])),
    kernel: testKernelToolDeps(),
  }), () => moduleSnapshot, testRuntimeConfigCapture);
  return (await owner.resolve()).executionAdmission;
}

/** The admission of a request that plans every tool a test hands it, for a test that does not exercise capability
 *  policy. */
export const admitEveryTool: ExecutionAdmission = () => ({ ok: true });

/** Pins the first request's surface before the loop starts, as the runtime
 *  assembly does. A loop that reads its surface before any request, such as a
 *  compaction control taken before the first request, needs this pin. */
export async function assemblyPinned<Owner extends RequestToolSurfaceOwner>(owner: Owner): Promise<Owner> {
  await owner.resolve();
  return owner;
}

/** Mutable tool map that remains a plan-owned surface for loop tests. */
export class RequestToolMap extends Map<string, RuntimeTool> {
  private readonly surface = fixedRequestToolSurface(this);
  private currentSurface: RequestToolSurfaceOwner | undefined;

  async resolve(): ReturnType<RequestToolSurfaceOwner["resolve"]> {
    const owner = await this.surface;
    this.currentSurface = owner;
    const surface = await owner.resolve();
    return { ...surface, executionAdmission: (toolName) => this.has(toolName)
      ? { ok: true }
      : surface.executionAdmission(toolName) };
  }

  current(): ReturnType<RequestToolSurfaceOwner["current"]> {
    if (this.currentSurface === undefined) throw new Error("RequestToolMap must resolve before reading its current surface");
    const surface = this.currentSurface.current();
    return { ...surface, executionAdmission: (toolName) => this.has(toolName)
      ? { ok: true }
      : surface.executionAdmission(toolName) };
  }
}

/** Static self-contained tools under one explicit plan-owned test surface:
 *  every registration a bare kernel with handoff capture and a session shell
 *  runtime of its own can build alone. */
export function testBaseTools(): ReadonlyMap<string, RuntimeTool> & RequestToolSurfaceOwner {
  const tools = new Map<string, RuntimeTool>();
  const deps = { kernel: testKernelToolDeps({ handoff: {}, ...bashExecution() }), modules: NO_MODULE_RUNTIMES };
  for (const [name, registration] of Object.entries(toolRegistrations)) {
    const result = registration.create(deps);
    if (result.tool) tools.set(name, result.tool);
  }
  return new RequestToolMap(tools);
}

/** A request plan as the request assembly hands it to its tool surface: the planner's result with the kernel that it
 *  was planned under. */
export async function plannedRequest(plan: ToolExposurePlan | Promise<ToolExposurePlan>, kernel: KernelToolDeps = testKernelToolDeps()): Promise<PlannedRequest> {
  return { ...await plan, kernel };
}

/** The module runtime contract, proven with a module the planner has never
 *  heard of: it declares a runtime, one tool, an exposure gate, and a prompt
 *  fragment, and every one of them reaches the request through the typed
 *  handle with no planner, assembly, or prompt-builder edit. */

import { describe, expect, it } from "bun:test";
import { composeModuleRuntimes, moduleRuntimeHandle, NO_MODULE_RUNTIMES } from "../../../../../src/infra/module-runtime.js";
import { composeModules } from "../../../../../src/infra/module-descriptor.js";
import type { ModuleRuntimeServices } from "../../../../../src/orchestration/agent-runtime/module-runtime-services.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { toolRegistryFromComposition, type ToolDeclaration } from "../../../../../src/orchestration/agent-runtime/tools/tool-registry.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { SHIPPED_MODULES, type FirstPartyModule, type FirstPartyModuleComposition } from "../../../../../src/orchestration/modules.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";
import { moduleRuntimeServices } from "../../../../helpers/module-runtime-services.js";

interface ProbeRuntime {
  readonly greeting: string;
  readonly forbid: readonly string[];
}

const probeRuntime = moduleRuntimeHandle<ProbeRuntime>("probe");
const constructions: string[] = [];

function probeTool(greeting: string): RuntimeTool {
  return {
    name: "probe",
    action: "ui_meta",
    description: greeting,
    inputSchema: { type: "object", properties: {} },
    isConcurrencySafe: true,
    execute: async () => ({ content: greeting, outcome: "ok" }),
  };
}

const probe = {
  category: "core",
  action: "ui_meta",
  cloneInheritance: "inherit",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: false,
  registryOrder: 999,
  registrations: {
    probe: {
      capabilities: [],
      create: ({ modules }) => {
        const runtime = modules.get(probeRuntime);
        if (!runtime) return { reason: "no probe runtime available" };
        return {
          tool: probeTool(runtime.greeting),
          refine: (planned) => ({ tool: probeTool(`${runtime.greeting} beside ${[...planned.keys()].filter((name) => name !== "probe").sort().join(", ")}`) }),
        };
      },
    },
  },
} as const satisfies ToolDeclaration;

const probeModule = {
  id: "probe",
  dependencies: [],
  availability: { kind: "available" },
  runtime: {
    handle: probeRuntime,
    create: (services: ModuleRuntimeServices): ProbeRuntime => {
      constructions.push(services.executionCwd);
      return { greeting: `hello from ${services.executionCwd}`, forbid: ["write"] };
    },
  },
  contributions: [
    { domain: "tools", id: "probe", value: { kind: "tool", name: "probe", declaration: probe } },
    { domain: "promptFragments", id: "probe-fragment", value: {
      order: 5,
      render: ({ modules, tools }) => {
        const runtime = modules.get(probeRuntime);
        return runtime ? `# Probe\n\n${runtime.greeting}; tools: ${tools.size}` : undefined;
      },
    } },
  ],
  observers: [],
  transformers: [],
  gates: [{ seam: "toolExposure", gate: ({ modules }) => new Map((modules.get(probeRuntime)?.forbid ?? []).map((name) => [name, "forbidden by the probe charter"])) }],
} as const satisfies FirstPartyModule;

describe("a synthetic module under the runtime contract", () => {
  const catalog: readonly FirstPartyModule[] = [...SHIPPED_MODULES.filter((module) => module.id === "file-tools" || module.id === "discovery"), probeModule];
  const runtimes = (composition: FirstPartyModuleComposition, services: ModuleRuntimeServices) => composeModuleRuntimes(catalog.flatMap((module) =>
    module.runtime && composition.enabledModuleIds.includes(module.id) ? [[module.id, module.runtime.create(services)] as const] : []));
  const services = moduleRuntimeServices({ executionCwd: "/scratch/probe" });

  it("composes, plans, gates, refines, and renders through its own handle with no kernel edit", async () => {
    constructions.length = 0;
    const composition = composeModules(catalog);
    const modules = runtimes(composition, services);
    expect(constructions).toEqual(["/scratch/probe"]);

    const kernel = testKernelToolDeps({ moduleSnapshot: composition });
    const plan = await planToolExposure({ kernel, modules, registry: toolRegistryFromComposition(composition) });

    expect(plan.tools.get("probe")?.description).toBe("hello from /scratch/probe beside edit, list, read, search");
    expect(plan.tools.has("write")).toBe(false);
    expect(plan.omitted).toContainEqual({ name: "write", reason: "forbidden by the probe charter" });

    const fragment = composition.contributions.find((contribution) => contribution.domain === "promptFragments" && contribution.id === "probe-fragment");
    if (fragment?.domain !== "promptFragments") throw new Error("missing probe fragment");
    expect(fragment.module).toBe("probe");
    expect(fragment.value.render({ kernel, modules, tools: plan.tools, memorySnapshot: null })).toBe("# Probe\n\nhello from /scratch/probe; tools: 5");
  });

  it("never constructs the runtime for a disabled module and omits its tool with its own reason", async () => {
    constructions.length = 0;
    const composition = composeModules(catalog, { disabledModuleIds: ["probe"] });
    const modules = runtimes(composition, services);
    expect(constructions).toEqual([]);
    expect(modules.get(probeRuntime)).toBeUndefined();

    const plan = await planToolExposure({ kernel: testKernelToolDeps({ moduleSnapshot: composition }), modules, registry: toolRegistryFromComposition(composition) });
    expect(plan.tools.has("probe")).toBe(false);
    expect(plan.tools.has("write")).toBe(true);
    expect(composition.contributions.some((contribution) => contribution.id === "probe-fragment")).toBe(false);
  });

  it("omits the tool with the factory's reason when the module is enabled but declined to build", async () => {
    const composition = composeModules(catalog);
    const plan = await planToolExposure({ kernel: testKernelToolDeps({ moduleSnapshot: composition }), modules: NO_MODULE_RUNTIMES, registry: toolRegistryFromComposition(composition) });
    expect(plan.omitted).toContainEqual({ name: "probe", reason: "no probe runtime available" });
  });
});

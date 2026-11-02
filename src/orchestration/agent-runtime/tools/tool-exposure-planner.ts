/**
 * Stateless planner that decides which tools are exposed for a single
 * model turn. Inputs are the request's kernel facts and the module runtimes
 * of this runner; output is an inspectable plan with omission reasons so
 * prompt snapshots and traces can explain the tool surface.
 *
 * The planner names no module. A registration declares its interaction contract,
 * its provider-visible name, its allowlist identity, and its capabilities;
 * everything else a tool needs comes from its own factory over `{ kernel,
 * modules }`. The same map drives both the system-prompt advertisement and
 * prepared-call dispatch (`tool-dispatch.ts`); a tool is present (advertised
 * and runnable), refused (advertised, and its call returns a refusal), or
 * omitted with a reason. The plan's one `usable` set names the tools that are
 * not refused, so the agent's tool notice and its refusals cannot disagree.
 */

import type { ModuleRuntimes } from "../../../infra/module-runtime.js";
import type { ToolAction } from "../../../infra/workflow-types.js";
import type { SkillRegistryRevision } from "../../../workflows/skill-schema.js";
import type { FirstPartyModuleComposition, ToolExposureGate } from "../../modules.js";
import type { KernelToolDeps } from "./kernel-tool-deps.js";
import { exposedToolName, toolRegistryFromComposition, type DeferredToolFactory, type RegisteredTool, type ToolFactoryResult, type ToolRegistry } from "./tool-registry.js";
import type { AdvertisedTool, RuntimeTool, ToolProfile } from "./types.js";
import { moduleDisabledReason } from "../../../protocol/module-ids.js";

const CONTRACT_MISMATCH_REASON = "not selected by the request file edit contract";
const NO_GATE_OMISSIONS: ReadonlyMap<string, string> = new Map();

/** Resolve granted ToolActions to canonical tool names, in action order. */
export function toolNamesForActions(actions: ReadonlyArray<ToolAction>, registry: ToolRegistry): string[] {
  const resolved: string[] = [];
  for (const action of actions) {
    for (const registration of registry.values()) {
      if (registration.action === action && !resolved.includes(registration.tool)) resolved.push(registration.tool);
    }
  }
  return resolved;
}

export interface ToolExposureInput {
  readonly kernel: KernelToolDeps;
  readonly modules: ModuleRuntimes;
  /** Registrations to plan from; the request's module snapshot by default. */
  readonly registry?: ToolRegistry;
  /** Ordinary selection by allowlist identity; ambient tools remain available. */
  readonly selected?: ReadonlySet<string>;
  /** What this agent may call. Every other tool stays advertised, so the
   *  request's tool bytes match an agent that holds them all and share its
   *  prompt cache, but its call is refused. */
  readonly granted?: ToolGrant;
  /** Closed authority that takes precedence over ordinary selection. */
  readonly profile?: ToolProfile;
  /** Pre-construction omissions; the request's module snapshot gate by default. */
  readonly exposureGate?: ToolExposureGate;
  /** The agent's own module selection when it plans from its chat tree's module capture (`SharedTree.modules`),
   *  which is then the kernel's module snapshot. A tool of a module that this selection turned off stays advertised
   *  and refuses its calls, so the tree's agents advertise the same tools (ARCH-RUNTIME-068). */
  readonly live?: FirstPartyModuleComposition;
}

/** The tools an agent may call: `tools` by allowlist identity, and every
 *  ambient tool that `withheld` does not name when `ambient` is set. */
export interface ToolGrant {
  readonly tools: ReadonlySet<string>;
  readonly ambient: boolean;
  readonly withheld?: ReadonlySet<string>;
}

export interface ToolExposurePlan {
  /** Provider-visible name to its exact registration id. */
  registrationIds: ReadonlyMap<string, string>;
  /** Provider-visible name to the tool its registration serves. */
  registrationIdentities: ReadonlyMap<string, string>;
  /** Canonical post-capability and post-allowlist set for this request. */
  eligibleTools: ReadonlyMap<string, RuntimeTool>;
  /** Provider-visible projection. Exclusive code-mode entries are absent. */
  tools: ReadonlyMap<string, RuntimeTool>;
  /** Tools rejected before either provider or code-mode projection. */
  omitted: ReadonlyArray<{ name: string; reason: string }>;
  /** Provider-visible names of `tools` whose call this agent may make: every
   *  planned tool that is neither ungranted nor unusable. The one source of
   *  the agent's tool notice and of its refusals. */
  usable: ReadonlySet<string>;
  /** Complete skill revision advertised and executed by this request. */
  skillRegistry?: SkillRegistryRevision;
}

interface Refinement {
  readonly name: string;
  readonly refine: NonNullable<ToolFactoryResult["refine"]>;
  /** The reason that the agent may not call the settled tool, which stays advertised. */
  readonly unusable?: string;
}

interface Deferred {
  readonly create: DeferredToolFactory;
  readonly registrationId: string;
  readonly identity: string;
  readonly granted: boolean;
  /** The reason that the agent may not call the deferred tool, which stays advertised. */
  readonly unusable?: string;
}

export async function planToolExposure(input: ToolExposureInput): Promise<ToolExposurePlan> {
  const { kernel, modules } = input;
  const registry = input.registry ?? toolRegistryFromComposition(kernel.moduleSnapshot);
  if (input.profile === "none") {
    return {
      tools: new Map(),
      eligibleTools: new Map(),
      registrationIds: new Map(),
      registrationIdentities: new Map(),
      usable: new Set(),
      omitted: [...new Set([...registry].map(([id, registration]) => exposedToolName(id, registration)))]
        .map((name) => ({ name, reason: "excluded by the no-tool profile" })),
    };
  }
  const exposureGate = input.exposureGate ?? kernel.moduleSnapshot.gates
    .find((gate): gate is Extract<FirstPartyModuleComposition["gates"][number], { readonly seam: "toolExposure" }> => gate.seam === "toolExposure")?.gate;
  const gateOmissions = await exposureGate?.({ kernel, modules }) ?? NO_GATE_OMISSIONS;
  const interactionContract = `file-edit:${kernel.fileEditContract ?? "edit"}`;
  const skillRegistry = kernel.skills;

  const tools = new Map<string, RuntimeTool>();
  const omitted: Array<{ name: string; reason: string }> = [];
  const registrationIds = new Map<string, string>();
  const registrationIdentities = new Map<string, string>();
  const refinements: Refinement[] = [];
  // A registration outside the request's file edit contract explains an absence
  // only when no registration inside it provides the same provider-visible name.
  const contractMismatches = new Set<string>();
  let deferred: Deferred | undefined;
  const ungranted = new Set<string>();
  const unusable = new Set<string>();
  const liveRegistry = input.live && toolRegistryFromComposition(input.live);
  const liveModuleIds = new Set(input.live?.enabledModuleIds);

  for (const [registrationId, registration] of registry) {
    const exposedName = exposedToolName(registrationId, registration);
    const identity = registration.tool;
    if (registration.interactionContract !== undefined && registration.interactionContract !== interactionContract) {
      contractMismatches.add(exposedName);
      continue;
    }
    if (input.selected && registration.category !== "ambient" && !input.selected.has(identity)) {
      omitted.push({ name: exposedName, reason: "not in selected allowlist" });
      continue;
    }
    const gateOmission = gateOmissions.get(identity);
    if (gateOmission) {
      omitted.push({ name: exposedName, reason: gateOmission });
      continue;
    }
    const admission = moduleAdmission(kernel, liveRegistry, registrationId, registration);
    if ("omitted" in admission) {
      omitted.push({ name: exposedName, reason: admission.omitted });
      continue;
    }
    const turnedOffReason = admission.turnedOff;
    const built = registration.create({ kernel, modules });
    const advertisedUnusable = kernel.treeHosted
      ? turnedOffReason !== undefined ? advertisedOf(built, turnedOffReason) : built.unusable
      : undefined;
    if (built.unusable && !advertisedUnusable) omitted.push({ name: exposedName, reason: built.unusable.reason });
    const tool = advertisedUnusable ? unusableTool(advertisedUnusable.tool, advertisedUnusable.reason) : built.tool;
    if (tool) {
      if (!grants(input.granted, registration)) ungranted.add(tool.name);
      if (advertisedUnusable) unusable.add(tool.name);
      tools.set(tool.name, tool);
      registrationIds.set(tool.name, registrationId);
      registrationIdentities.set(tool.name, identity);
      if (built.refine) refinements.push({ name: tool.name, refine: built.refine, ...(advertisedUnusable ? { unusable: advertisedUnusable.reason } : {}) });
    }
    if (built.reason) omitted.push({ name: exposedName, reason: built.reason });
    if (built.omissions) omitted.push(...built.omissions);
    if (built.deferred) {
      if (deferred) throw new Error(`Tool registrations '${deferred.registrationId}' and '${registrationId}' both defer construction`);
      deferred = { create: built.deferred, registrationId, identity, granted: grants(input.granted, registration), ...(turnedOffReason === undefined ? {} : { unusable: turnedOffReason }) };
    }
  }
  for (const name of contractMismatches) {
    if (!tools.has(name)) omitted.push({ name, reason: CONTRACT_MISMATCH_REASON });
  }

  // Every refinement settles against the same planned set, so no tool decides
  // from another tool's settlement. An unusable tool is advertised only to
  // keep the tree's tool list whole, so it carries no channel or authority.
  const planned: ReadonlyMap<string, RuntimeTool> = new Map([...tools].filter(([name]) => !unusable.has(name)));
  for (const { name, refine, unusable: refusal } of refinements) {
    const settled = refine(planned);
    if (settled.tool) {
      tools.set(name, refusal === undefined ? settled.tool : unusableTool(settled.tool, refusal));
    } else {
      tools.delete(name);
      registrationIds.delete(name);
      registrationIdentities.delete(name);
      omitted.push({ name, reason: settled.reason });
    }
  }

  for (const name of ungranted) {
    const tool = tools.get(name);
    if (tool) tools.set(name, ungrantedTool(tool));
  }

  const namespaces = new Set<string>();
  if (deferred) {
    for (const contribution of kernel.moduleSnapshot.contributions) {
      if (contribution.domain !== "codeTools") continue;
      for (const namespace of contribution.value.namespaces?.({ kernel, modules }) ?? []) namespaces.add(namespace);
      const turnedOff = input.live && !liveModuleIds.has(contribution.module) ? moduleDisabledReason([contribution.module]) : undefined;
      for (const created of contribution.value.create({ kernel, modules })) {
        const tool = turnedOff === undefined ? created : unusableTool(created, turnedOff);
        if (turnedOff !== undefined) unusable.add(tool.name);
        tools.set(tool.name, tool);
        // A module's code-only tools execute only through the deferred tool,
        // so its registration is their capability authority for dispatch-time admission.
        registrationIdentities.set(tool.name, deferred.identity);
        registrationIds.set(tool.name, deferred.registrationId);
      }
    }
  }
  const eligibleTools = tools;
  const providerTools = new Map([...eligibleTools].filter(([, tool]) => tool.codeMode !== "exclusive"));
  if (deferred) {
    const built = deferred.create(eligibleTools, namespaces);
    omitted.push(...built.omissions);
    const tool = !deferred.granted ? ungrantedTool(built.tool) : deferred.unusable === undefined ? built.tool : unusableTool(built.tool, deferred.unusable);
    if (!deferred.granted) ungranted.add(tool.name);
    if (deferred.unusable !== undefined) unusable.add(tool.name);
    eligibleTools.set(tool.name, tool);
    providerTools.set(tool.name, tool);
    registrationIdentities.set(tool.name, deferred.identity);
    registrationIds.set(tool.name, deferred.registrationId);
  }
  const usable = new Set([...providerTools.keys()].filter((name) => !ungranted.has(name) && !unusable.has(name)));
  return { eligibleTools, tools: providerTools, omitted, usable, registrationIds, registrationIdentities, ...(skillRegistry ? { skillRegistry } : {}) };
}

/** Whether the grant lets the agent call this registration's tool. */
function grants(granted: ToolGrant | undefined, registration: RegisteredTool): boolean {
  return !granted || granted.tools.has(registration.tool)
    || (granted.ambient && registration.category === "ambient" && granted.withheld?.has(registration.tool) !== true);
}

/** A tool the agent sees but may not call. Its advertised fields are the
 *  definition's, and its call returns the refusal before any body runs. */
function refusedTool(tool: AdvertisedTool, refusal: string): RuntimeTool {
  const { prepareAdmission: _admission, reservedPaths: _paths, ...advertised } = tool;
  return { ...advertised, isConcurrencySafe: true, execute: async () => ({ content: refusal, outcome: "error" }) };
}

/** Whether the agent's modules admit a registration. An agent omits a registration whose capability it lacks, except
 *  a tree-hosted agent, which omits only what its whole tree omits: a module that the tree's capture holds and the
 *  agent's own selection turned off (`ToolExposureInput.live`) leaves the tool advertised, and `turnedOff` names why
 *  the agent may not call it. */
function moduleAdmission(kernel: KernelToolDeps, liveRegistry: ToolRegistry | undefined, registrationId: string, registration: RegisteredTool): { readonly omitted: string } | { readonly turnedOff?: string } {
  const missing = registration.capabilities.filter((capability) => !kernel.capabilities.available(capability));
  if (missing.length > 0 && (!kernel.treeHosted || missing.some((capability) => !kernel.moduleSnapshot.enabledModuleIds.includes(capability)))) {
    return { omitted: moduleDisabledReason(missing) };
  }
  const turnedOff = [...liveRegistry?.has(registrationId) === false ? toolOwners(kernel.moduleSnapshot, registration.tool) : [], ...missing];
  return turnedOff.length === 0 ? {} : { turnedOff: moduleDisabledReason(turnedOff) };
}

/** The modules whose tool contributions name `tool` in `composition`. */
function toolOwners(composition: FirstPartyModuleComposition, tool: string): string[] {
  return composition.contributions.flatMap((contribution) => contribution.domain === "tools" && contribution.value.name === tool ? [contribution.module] : []);
}

/** The advertised form of a registration's result that the agent may not call for `reason`. */
function advertisedOf(built: ToolFactoryResult, reason: string): { readonly tool: AdvertisedTool; readonly reason: string } | undefined {
  const tool = built.tool ?? built.unusable?.tool;
  return tool && { tool, reason };
}

function ungrantedTool(tool: AdvertisedTool): RuntimeTool {
  return refusedTool(tool, `The ${tool.name} tool is not granted to this agent. Do not call ${tool.name} again; use the tools your task names.`);
}

function unusableTool(tool: AdvertisedTool, reason: string): RuntimeTool {
  return refusedTool(tool, `The ${tool.name} tool is unavailable to this agent now: ${reason}. Do not call ${tool.name} again.`);
}

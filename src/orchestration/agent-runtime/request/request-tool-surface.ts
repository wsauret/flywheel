/**
 * The capability-sensitive surface of one provider request, pinned.
 *
 * A capability can be enabled or disabled while a runner is parked, so
 * everything a request contributes under one capability reading must be
 * resolved again for that request: the tools it advertises and the durable
 * memory bytes its system prompt carries. Once a request opens, every consumer
 * downstream of it must read the same surface: the schemas sent to the
 * provider, the system prompt built for it, the dispatcher that runs what the
 * model called back, the omission evidence recorded in the request audit, and
 * the forced budget-exhaustion turn. This owner is that single source.
 * `resolve()` captures and pins the next request; `current()` reads only the
 * request already in flight. What a pinned request derives from inputs that
 * equal the previous request's is held across requests (`HeldPreparation`).
 */

import { createHash } from "node:crypto";
import { errorMessage } from "../../../infra/error-message.js";
import type { CapabilityCheck } from "../../../infra/capability-text.js";
import { agentCapabilityCheck } from "./prompt/capability-checks.js";
import { isRecord } from "../../../infra/record.js";
import type { ToolExposurePlan } from "../tools/dispatch/tool-exposure-planner.js";
import type { KernelToolDeps } from "../tools/kernel-tool-deps.js";
import type { RuntimeTool } from "../tools/types.js";
import type { RequestRoleSelection } from "../types.js";
import { moduleDisabledReason } from "../../../protocol/module-ids.js";
import { exposedToolName, toolRegistryFromComposition } from "../tools/dispatch/tool-registry.js";
import type { ExecutionAdmission } from "../tools/dispatch/tool-dispatch.js";
import type { AdmittedModelRequest, ModelClient, ModelRequestRoute, ServingAttempt, StreamOptions, ToolPresentation } from "../llm/types.js";
import type { ModelInteractionProfile } from "./prompt/model-interaction-profile.js";
import type { FirstPartyModuleComposition } from "../../modules.js";
import { hashToolInputFormat } from "../../session/provider-request-audit-hash.js";
import type { CaptureRuntimeConfig, RuntimeConfigRequestCapture } from "./request-config.js";
import type { ModelRuntimeCapture, ProviderConnectionCapture } from "./model-runtime-capture.js";
import { tokenCountingPolicy, type TokenCountingPolicyIdentity } from "../compaction/token-counter.js";
import { renderSystemPrompt, type SystemPromptTiers } from "../llm/system-prompt-tiers.js";

import { accessProviderRegistry, type AccessProviderRegistry } from "../llm/routing/access-provider-registry.js";
import { resolveModelInteractionProfile } from "./prompt/model-interaction-profile.js";
type ProviderToolDef = StreamOptions["tools"][number];
type AuditToolDef = import("../../session/provider-request-audit-types.js").ProviderRequestAuditTool;

/** The provider definitions of `tools`. When every definition equals the one at its place in `held` by identity, it
 *  returns `held`, so the projections and token counts that the run holds for those bytes stay valid. */
function projectProviderToolDefinitions(tools: ReadonlyMap<string, RuntimeTool>, held: readonly ProviderToolDef[] | undefined): readonly ProviderToolDef[] {
  const definitions = [...tools.values()].map((tool): ProviderToolDef => ({
    name: tool.name,
    description: tool.description,
    input_schema: materializedInputSchema(tool),
    ...(tool.wire ? { wire: tool.wire } : {}),
  }));
  const unchanged = held?.length === definitions.length && definitions.every((definition, index) => {
    const previous = held[index];
    return previous?.name === definition.name && previous.description === definition.description
      && previous.input_schema === definition.input_schema && previous.wire === definition.wire;
  });
  return unchanged && held ? held : definitions;
}

/** The materialized schema of each tool input schema object. A registration's schema object is immutable, and a
 *  plan that recreates a tool keeps the schema object, so each schema is serialized and checked once. */
const materializedSchemas = new WeakMap<object, ProviderToolDef["input_schema"]>();

function materializedInputSchema(tool: RuntimeTool): ProviderToolDef["input_schema"] {
  const held = materializedSchemas.get(tool.inputSchema);
  if (held) return held;
  const materialized = materializeToolInputSchema(tool);
  materializedSchemas.set(tool.inputSchema, materialized);
  return materialized;
}

class ToolInputSchemaMaterializationError extends Error {}

type JsonSchemaMaterializationValue = string | number | boolean | null | object;

function requireSupportedSchemaValue(toolName: string, value: unknown): JsonSchemaMaterializationValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (Number.isFinite(value)) return value;
      throw new ToolInputSchemaMaterializationError(`Tool '${toolName}' input schema contains unsupported non-finite number`);
    case "object":
      return value;
    default:
      throw new ToolInputSchemaMaterializationError(`Tool '${toolName}' input schema contains unsupported ${value === undefined ? "undefined" : typeof value}`);
  }
}

function materializeToolInputSchema(tool: RuntimeTool): ProviderToolDef["input_schema"] {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(tool.inputSchema, (_key, value: unknown) => requireSupportedSchemaValue(tool.name, value));
  } catch (error) {
    if (error instanceof ToolInputSchemaMaterializationError) throw error;
    throw new ToolInputSchemaMaterializationError(`Tool '${tool.name}' input schema is not JSON-serializable: ${errorMessage(error)}`, { cause: error });
  }
  if (serialized === undefined) throw new ToolInputSchemaMaterializationError(`Tool '${tool.name}' input schema is not JSON-serializable`);
  const materialized: unknown = JSON.parse(serialized);
  if (!isRecord(materialized)) throw new ToolInputSchemaMaterializationError(`Tool '${tool.name}' input schema must materialize to a JSON object`);
  // Providers reject a tool schema whose root is not an object, a bare
  // `oneOf` union included. Refuse it here, where every tool crosses, so the
  // defect fails a unit test instead of the user's first model request.
  if (materialized.type !== "object") throw new ToolInputSchemaMaterializationError(`Tool '${tool.name}' input schema root must declare type "object"`);
  // An MCP client parses a tool schema root into `type`, `properties`, `required`, then every other key, so a route
  // that serves the tools over MCP sends that order. Every route sends it, so the wire bytes and the prompt cache
  // do not depend on the route.
  const { type, properties, required, ...rest } = materialized;
  return { type, ...(properties === undefined ? {} : { properties }), ...(required === undefined ? {} : { required }), ...rest };
}
interface RequestStablePrompt {
  readonly systemPrompt: SystemPromptTiers;
  readonly definitions: readonly ProviderToolDef[];
  readonly interactionProfileId: ModelInteractionProfile["id"];
  readonly omittedTools: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

export interface PreparedRequestAttempt {
  readonly systemPrompt: SystemPromptTiers;
  readonly tools: readonly ProviderToolDef[];
  readonly auditTools: readonly AuditToolDef[];
  readonly attemptStaticTokens: number;
  readonly interactionProfileId: ModelInteractionProfile["id"];
  readonly omittedTools: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

export type RequestModelSelection = RequestRoleSelection & {
  readonly capture?: { readonly runtime: ModelRuntimeCapture; readonly connection?: ProviderConnectionCapture };
};

export function requestModelSelectionKey(selection: RequestModelSelection): string {
  return JSON.stringify({ roleId: selection.roleId, model: selection.model, effort: selection.effort, providerOptions: selection.providerOptions, setting: selection.setting, fixedModel: selection.fixedModel });
}

export interface RequestProviderRuntime {
  readonly mainRoute: ModelRequestRoute;
  readonly plannedAttempt: ServingAttempt;
  readonly admittedRequest?: AdmittedModelRequest;
  readonly interactionProfile: ModelInteractionProfile;
  /** Effective request role, when request-time role refresh selected one. */
  readonly role?: { readonly model: string; readonly effort?: string; readonly providerOptions?: import("../../../infra/llm/provider-options.js").ProviderRequestOptions };
  readonly selectionKey?: string;
  readonly selectionGeneration?: WeakKey;
  readonly selectionEligibility?: ProviderConnectionCapture["eligibility"];
  readonly runtimeConfig?: RuntimeConfigRequestCapture;
}

/** What one request was admitted under: its module composition, its runtime policy, and the provider clients
 *  prepared from both. A capability plan has no provider runtime. */
export interface RequestCapture {
  /** Immutable module composition that admitted this request. */
  readonly moduleSnapshot: FirstPartyModuleComposition;
  /** Next-request policy captured at the same admission boundary as tools and providers. */
  readonly runtimeConfig: RuntimeConfigRequestCapture;
  /** Main and auxiliary provider clients prepared from `moduleSnapshot`. */
  readonly providerRuntime?: RequestProviderRuntime;
}

interface RequestToolSurface extends RequestCapture {
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  /** Provider-visible tool name to its exact selected registration id. */
  readonly registrationIds: ReadonlyMap<string, string>;
  /** Logical names of the tools this agent may call (`ToolExposurePlan.usable`),
   * the vocabulary of grants and nested authorization. Provider adapters can
   * expose a different name and schema without changing this vocabulary. */
  readonly usableToolNames: ReadonlySet<string>;
  /** Provider-visible tool name to its logical registration id. */
  readonly registrationIdentities: ReadonlyMap<string, string>;
  /** The kernel that this request was planned under. The request's prompt and turn reminders read the same kernel. */
  readonly kernel: KernelToolDeps;
  /** The agent check (ARCH-CONTEXT-033): `usableToolNames` and the availability of this agent's own selection.
   *  Text that this agent alone reads renders from it. */
  readonly capabilities: CapabilityCheck;
  /** The modules whose advertised tools this agent's calls are refused because its own selection turned them off
   *  (`ToolExposurePlan.turnedOff`). */
  readonly turnedOff: ToolExposurePlan["turnedOff"];
  /** Resolves old unstamped calls only when their recorded model profile selects
   *  exactly one registration for the recorded provider-visible name. */
  historicalRegistrationId(name: string, model: string | undefined, provider: import("../../../infra/llm/model-family.js").ModelFamily | undefined): string | undefined;
  /** Capability admission fixed with the advertised tool surface. */
  readonly executionAdmission: ExecutionAdmission;
  /** Provider planning, factories, and billing derived from this exact request composition. */
  readonly providerRegistry: AccessProviderRegistry;
  /** Complete skill revision captured with this request's prompt and executable tools. */
  readonly skillRegistry?: ToolExposurePlan["skillRegistry"];
  /** The hash of the tool definitions that this surface sends, which a conversation's fixed prompt renders again
   *  for when it changes (ARCH-CONTEXT-044). Each schema is serialized once for the process. */
  definitionsIdentity(): string;
  prepareStablePrompt(build: () => SystemPromptTiers | Promise<SystemPromptTiers>, profile: ModelInteractionProfile): Promise<RequestStablePrompt>;
  prepareAttempt(attempt: Pick<ServingAttempt, "model" | "toolPresentation"> & Partial<Pick<ServingAttempt, "modelFamily" | "tokenizerIdentity">>): PreparedRequestAttempt;
  /** Captures the one immutable provider candidate chain this surface plans and dispatches. */
  admitProviderRequest(client: ModelClient, signal?: AbortSignal): Promise<AdmittedModelRequest>;
}

export interface RequestToolSurfaceOwner {
  resolve(): Promise<RequestToolSurface>;
  current(): RequestToolSurface;
}

/** The tool definitions of one attempt's presentation, with the audit evidence and the serialized bytes that its
 *  token count reads. */
interface PresentedDefinitions {
  readonly auditDefinitions: readonly AuditToolDef[];
  readonly serializedDefinitions: string;
}

/**
 * What a run's requests share across hops. Tools are planned for every request (ARCH-TOOLS-002), because a plan reads
 * live state that no revision covers, such as the process tool's background work and the web tool's credential. What
 * a plan derives is held by the identity of its inputs instead: the definitions of equal tools (`definitions`), the
 * presentation of equal definitions (`presentations`), the rendered text of the prompt that the run's prompt build
 * returns again (`prompt`), and the token count of equal bytes (`staticTokens`). A changed input is a new object and
 * misses, so a held value is never stale.
 */
interface HeldPreparation {
  definitions?: readonly ProviderToolDef[];
  presentations: WeakMap<readonly ProviderToolDef[], WeakMap<ToolPresentation, PresentedDefinitions & { readonly registrationIds: readonly string[] }>>;
  prompt?: { readonly tiers: SystemPromptTiers; readonly rendered: string };
  staticTokens?: {
    readonly tiers: SystemPromptTiers;
    readonly definitions: PresentedDefinitions;
    readonly policyIdentity: TokenCountingPolicyIdentity | undefined;
    readonly tokens: number;
  };
}

/** One request's tool plan with the kernel that it was planned under. */
export type PlannedRequest = ToolExposurePlan & { readonly kernel: KernelToolDeps };

/** The logical identities of the tools that a planned request can call. */
function usableIdentities(plan: PlannedRequest): ReadonlySet<string> {
  return new Set([...plan.usable].map((name) => plan.registrationIdentities.get(name) ?? name));
}

/** The agent check of a planned request (ARCH-CONTEXT-033): the tools that it can call, the availability of the
 *  agent's own selection, and the personas it may dispatch. */
export function requestCapabilities(plan: PlannedRequest): CapabilityCheck {
  return agentCapabilityCheck(usableIdentities(plan), plan.kernel.definitionAvailability.live, plan.kernel.allowedSubagentTypes);
}

/** The presentation of `definitions` for `presentation`, held while the definitions and the registration ids that the
 *  plan selected for them stay the same. */
function presentedDefinitions(held: HeldPreparation, plan: PlannedRequest, definitions: readonly ProviderToolDef[], presentation: ToolPresentation): PresentedDefinitions {
  const selected = definitions.map((definition) => {
    const registrationId = plan.registrationIds.get(definition.name);
    if (!registrationId) throw new Error(`Tool '${definition.name}' has no admitted executable registration identity`);
    return { definition, registrationId };
  });
  let byPresentation = held.presentations.get(definitions);
  if (!byPresentation) {
    byPresentation = new WeakMap();
    held.presentations.set(definitions, byPresentation);
  }
  const cached = byPresentation.get(presentation);
  if (cached?.registrationIds.every((id, index) => id === selected[index]?.registrationId)) return cached;
  const presented = {
    registrationIds: selected.map(({ registrationId }) => registrationId),
    auditDefinitions: selected.map(({ definition, registrationId }) => {
      const descriptor = presentation.present(definition);
      return {
        name: presentation.wireName?.(definition.name) ?? definition.name,
        description: descriptor.description,
        input_schema: definition.input_schema,
        registrationId,
        executableId: definition.name,
        kind: descriptor.kind,
        inputFormatSha256: hashToolInputFormat(descriptor.inputFormat),
      };
    }),
    serializedDefinitions: JSON.stringify(definitions.map((definition) => ({
      ...definition, name: presentation.wireName?.(definition.name) ?? definition.name,
    }))),
  };
  byPresentation.set(presentation, presented);
  return presented;
}

/** The rendered text of `tiers`, held while the run's prompt build returns the same tiers. */
function renderedPrompt(held: HeldPreparation, tiers: SystemPromptTiers): string {
  if (held.prompt?.tiers !== tiers) held.prompt = { tiers, rendered: renderSystemPrompt(tiers) };
  return held.prompt.rendered;
}

/** The static tokens of one attempt: its rendered prompt and its serialized definitions under the serving model's
 *  counting policy. They are counted again only when the prompt, the definitions, or the policy changed. */
function staticTokens(held: HeldPreparation, tiers: SystemPromptTiers, definitions: PresentedDefinitions, attempt: Pick<ServingAttempt, "model"> & Partial<Pick<ServingAttempt, "modelFamily" | "tokenizerIdentity">>): number {
  const policy = attempt.modelFamily === undefined ? undefined : tokenCountingPolicy(attempt.model, attempt.modelFamily, attempt.tokenizerIdentity);
  const cached = held.staticTokens;
  if (cached?.tiers === tiers && cached.definitions === definitions && cached.policyIdentity === policy?.identity) return cached.tokens;
  const prompt = renderedPrompt(held, tiers);
  const tokens = policy?.kind === "local"
    ? policy.countText(prompt) + policy.countText(definitions.serializedDefinitions)
    : Math.ceil((prompt.length + definitions.serializedDefinitions.length) / 4);
  held.staticTokens = { tiers, definitions, policyIdentity: policy?.identity, tokens };
  return tokens;
}

function sameTiers(left: SystemPromptTiers, right: SystemPromptTiers): boolean {
  return left.stable === right.stable && left.session === right.session && left.conversation === right.conversation;
}

function pin(
  plan: PlannedRequest,
  { moduleSnapshot, runtimeConfig, providerRuntime }: RequestCapture,
  held: HeldPreparation,
): RequestToolSurface {
  const tools = plan.tools;
  const enabledModuleIds = new Set(moduleSnapshot.enabledModuleIds);
  const requestRegistry = toolRegistryFromComposition(moduleSnapshot);
  const usableToolNames = usableIdentities(plan);
  let stablePrompt: RequestStablePrompt | undefined;
  let identity: string | undefined;
  let admittedProviderRequest: Promise<AdmittedModelRequest> | undefined;
  return {
    tools,
    registrationIds: plan.registrationIds,
    usableToolNames,
    registrationIdentities: plan.registrationIdentities,
    kernel: plan.kernel,
    capabilities: requestCapabilities(plan),
    turnedOff: plan.turnedOff,
    historicalRegistrationId(name, model, provider) {
      if (model === undefined || provider === undefined) return undefined;
      const profile = resolveModelInteractionProfile(model, provider);
      const candidates = [...requestRegistry].filter(([id, registration]) => exposedToolName(id, registration) === name
        && (registration.interactionContract === undefined || registration.interactionContract === `file-edit:${profile.fileEditContract}`));
      return candidates.length === 1 ? candidates[0]?.[0] : undefined;
    },
    moduleSnapshot,
    runtimeConfig,
    providerRegistry: accessProviderRegistry(moduleSnapshot),
    ...(providerRuntime ? { providerRuntime } : {}),
    ...(plan.skillRegistry ? { skillRegistry: plan.skillRegistry } : {}),
    executionAdmission(toolName) {
      const registrationId = plan.registrationIds.get(toolName)
      const registration = registrationId ? requestRegistry.get(registrationId) : undefined
      if (!registration) return { ok: false, refusal: { content: `Tool '${toolName}' is not registered in this request capability snapshot`, outcome: "error" } }
      const missing = registration.capabilities.filter((capability) => !enabledModuleIds.has(capability))
      return missing.length === 0
        ? { ok: true }
        : { ok: false, refusal: { content: moduleDisabledReason(missing), outcome: "error" } }
    },
    definitionsIdentity() {
      identity ??= createHash("sha256").update(JSON.stringify([...tools.values()].map((tool) => [tool.name, tool.description, materializedInputSchema(tool)]))).digest("hex");
      return identity;
    },
    async prepareStablePrompt(build, profile) {
      // A surface that a compaction admitted serves the request after the reset, whose fresh context renders its own
      // fixed prompt (ARCH-CONTEXT-044), so the prompt builds again and an equal prompt keeps what was prepared.
      const systemPrompt = await build();
      if (stablePrompt && sameTiers(stablePrompt.systemPrompt, systemPrompt)) return stablePrompt;
      const definitions = projectProviderToolDefinitions(tools, held.definitions);
      held.definitions = definitions;
      stablePrompt = {
        systemPrompt,
        definitions,
        interactionProfileId: profile.id,
        omittedTools: plan.omitted.map((tool) => ({ ...tool })),
      };
      return stablePrompt;
    },
    admitProviderRequest(client, signal) {
      signal?.throwIfAborted();
      admittedProviderRequest ??= client.admitRequest();
      return admittedProviderRequest;
    },
    prepareAttempt(attempt) {
      if (!stablePrompt) throw new Error("Prepare the request-stable prompt before preparing a serving attempt");
      const { systemPrompt, definitions } = stablePrompt;
      const presented = presentedDefinitions(held, plan, definitions, attempt.toolPresentation);
      return {
        systemPrompt,
        tools: definitions,
        auditTools: presented.auditDefinitions,
        attemptStaticTokens: staticTokens(held, systemPrompt, presented, attempt),
        interactionProfileId: stablePrompt.interactionProfileId,
        omittedTools: stablePrompt.omittedTools,
      };
    },
  };
}

/** Owner that captures one coherent capability composition for every request. */
export async function createRequestToolSurface(
  plan: (request: RequestCapture) => PlannedRequest | Promise<PlannedRequest>,
  moduleSelection: () => FirstPartyModuleComposition,
  captureRuntimeConfig: CaptureRuntimeConfig,
  prepareProviderRuntime?: (moduleSnapshot: FirstPartyModuleComposition, runtimeConfig: RuntimeConfigRequestCapture, selection?: RequestModelSelection) => Promise<RequestProviderRuntime>,
  captureSelection?: (runtimeConfig: RuntimeConfigRequestCapture, moduleSnapshot: FirstPartyModuleComposition) => Promise<RequestModelSelection>,
  initialProvider?: RequestCapture & { readonly providerRuntime: RequestProviderRuntime },
): Promise<RequestToolSurfaceOwner> {
  const held: HeldPreparation = { presentations: new WeakMap() };
  const capture = async (request: RequestCapture): Promise<RequestToolSurface> => pin(await plan(request), request, held);
  let initialRequest = initialProvider ? await capture(initialProvider) : undefined;
  let pinned: RequestToolSurface | undefined = initialRequest;
  const resolve = async (): Promise<RequestToolSurface> => {
    const moduleSnapshot = moduleSelection();
    const requestedConfig = captureRuntimeConfig();
    // Assembly already admitted the first request to obtain its serving model.
    // Consume that capture once; changed policy requires a new admission.
    const initial = initialRequest;
    initialRequest = undefined;
    const selection = await captureSelection?.(requestedConfig, moduleSnapshot);
    const runtimeConfig = selection?.capture?.connection?.runtimeConfig ?? requestedConfig;
    const reuseInitial = initial?.moduleSnapshot === moduleSnapshot
      && initial.runtimeConfig.revision === runtimeConfig.revision
      && initial.runtimeConfig.profileId === runtimeConfig.profileId
      && (selection === undefined || initial.providerRuntime?.selectionKey === requestModelSelectionKey(selection))
      && initial.providerRuntime?.selectionGeneration === (selection?.capture?.connection ? selection.capture.runtime.generation : undefined)
      && initial.providerRuntime?.selectionEligibility === selection?.capture?.connection?.eligibility;
    if (reuseInitial) pinned = initial;
    else {
      const providerRuntime = await prepareProviderRuntime?.(moduleSnapshot, runtimeConfig, selection);
      pinned = await capture({ moduleSnapshot, runtimeConfig: providerRuntime?.runtimeConfig ?? runtimeConfig, ...(providerRuntime ? { providerRuntime } : {}) });
    }
    return pinned;
  };
  return {
    resolve,
    current() {
      if (!pinned) throw new Error("Resolve the request capability composition before reading it");
      return pinned;
    },
  };
}

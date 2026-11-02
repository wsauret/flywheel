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
 * request already in flight.
 */

import { errorMessage } from "../../infra/error-message.js";
import { isRecord } from "../../infra/record.js";
import type { ToolExposurePlan } from "./tools/tool-exposure-planner.js";
import type { RuntimeTool } from "./tools/types.js";
import { moduleDisabledReason } from "../../protocol/module-ids.js";
import { exposedToolName, toolRegistryFromComposition } from "./tools/tool-registry.js";
import type { PreparedCallCapabilityAdmission } from "./tools/tool-dispatch.js";
import type { AdmittedModelRequest, ModelClient, ModelRequestRoute, ServingAttempt, StreamOptions, ToolPresentation } from "./llm/types.js";
import type { ModelInteractionProfile } from "./model-interaction-profile.js";
import type { FirstPartyModuleComposition } from "../modules.js";
import { runModuleTransformerChain } from "../module-hooks.js";
import type { ProviderRequestAuditContextApplication } from "../session/provider-request-audit-types.js";
import { hashToolInputFormat } from "../session/provider-request-audit-hash.js";
import type { CaptureRuntimeConfig, RuntimeConfigRequestCapture } from "./request-config.js";
import type { ModelRuntimeCapture, ProviderConnectionCapture } from "./factory.js";
import { tokenCountingPolicy, type TokenCountingPolicyIdentity } from "./compaction/token-counter.js";
import { renderSystemPrompt, SYSTEM_PROMPT_SEPARATOR, type SystemPromptTiers } from "./llm/system-prompt-tiers.js";

import { accessProviderRegistry, type AccessProviderRegistry } from "./llm/access-provider-registry.js";
import { resolveModelInteractionProfile } from "./model-interaction-profile.js";
type ProviderToolDef = StreamOptions["tools"][number];
type AuditToolDef = import("../session/provider-request-audit-types.js").ProviderRequestAuditTool;

function projectProviderToolDefinitions(tools: ReadonlyMap<string, RuntimeTool>): readonly ProviderToolDef[] {
  return [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: materializeToolInputSchema(tool),
    ...(tool.wire ? { wire: tool.wire } : {}),
  }));
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
  readonly staticContextTokens: number;
  readonly contextApplication: ProviderRequestAuditContextApplication;
  readonly definitions: readonly ProviderToolDef[];
  readonly definitionChars: number;
  readonly literalOverride: boolean;
  readonly interactionProfileId: ModelInteractionProfile["id"];
  readonly omittedTools: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

export interface PreparedRequestAttempt {
  readonly systemPrompt: SystemPromptTiers;
  readonly tools: readonly ProviderToolDef[];
  readonly auditTools: readonly AuditToolDef[];
  readonly attemptStaticTokens: number;
  readonly contextApplication: ProviderRequestAuditContextApplication;
  readonly interactionProfileId: ModelInteractionProfile["id"];
  readonly omittedTools: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

export type RequestModelSelection = {
  readonly roleId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly providerOptions?: import("../../infra/llm/provider-options.js").ProviderRequestOptions;
  readonly setting?: import("../session/schemas.js").RoleSettingEntry & { readonly fixedEffort?: string };
  readonly capture?: { readonly runtime: ModelRuntimeCapture; readonly connection?: ProviderConnectionCapture };
};

export function requestModelSelectionKey(selection: RequestModelSelection): string {
  return JSON.stringify({ roleId: selection.roleId, model: selection.model, effort: selection.effort, providerOptions: selection.providerOptions, setting: selection.setting });
}

export interface RequestProviderRuntime {
  readonly mainRoute: ModelRequestRoute;
  readonly plannedAttempt: ServingAttempt;
  readonly admittedRequest?: AdmittedModelRequest;
  readonly interactionProfile: ModelInteractionProfile;
  /** Effective request role, when request-time role refresh selected one. */
  readonly role?: { readonly model: string; readonly effort?: string; readonly providerOptions?: import("../../infra/llm/provider-options.js").ProviderRequestOptions };
  readonly selectionKey?: string;
  readonly selectionGeneration?: WeakKey;
  readonly selectionEligibility?: ProviderConnectionCapture["eligibility"];
  readonly runtimeConfig?: RuntimeConfigRequestCapture;
}

interface RequestToolSurface {
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  /** Provider-visible tool name to its exact selected registration id. */
  readonly registrationIds: ReadonlyMap<string, string>;
  /** Logical names of the tools this agent may call (`ToolExposurePlan.usable`),
   * the vocabulary of grants and nested authorization. Provider adapters can
   * expose a different name and schema without changing this vocabulary. */
  readonly usableToolNames: ReadonlySet<string>;
  /** Provider-visible tool name to its logical registration id. */
  readonly registrationIdentities: ReadonlyMap<string, string>;
  /** Resolves old unstamped calls only when their recorded model profile selects
   *  exactly one registration for the recorded provider-visible name. */
  historicalRegistrationId(name: string, model: string | undefined, provider: import("../../infra/llm/model-family.js").ModelFamily | undefined): string | undefined;
  /** Immutable module composition that admitted this request. */
  readonly moduleSnapshot: FirstPartyModuleComposition;
  /** Next-request policy captured at the same admission boundary as tools and providers. */
  readonly runtimeConfig: RuntimeConfigRequestCapture;
  /** Capability admission fixed with the advertised tool surface. */
  executionAdmission(toolName: string): PreparedCallCapabilityAdmission;
  /** Provider planning, factories, and billing derived from this exact request composition. */
  readonly providerRegistry: AccessProviderRegistry;
  /** Main and auxiliary provider clients prepared from `moduleSnapshot`. */
  readonly providerRuntime?: RequestProviderRuntime;
  /** Complete skill revision captured with this request's prompt and executable tools. */
  readonly skillRegistry?: ToolExposurePlan["skillRegistry"];
  prepareStablePrompt(build: () => SystemPromptTiers | Promise<SystemPromptTiers>, profile: ModelInteractionProfile, literalOverride?: boolean): Promise<RequestStablePrompt>;
  prepareAttempt(attempt: Pick<ServingAttempt, "model" | "promptNotes" | "toolPresentation"> & Partial<Pick<ServingAttempt, "modelFamily" | "tokenizerIdentity">>): PreparedRequestAttempt;
  /** Captures the one immutable provider candidate chain this surface plans and dispatches. */
  admitProviderRequest(client: ModelClient, signal?: AbortSignal): Promise<AdmittedModelRequest>;
}

export interface RequestToolSurfaceOwner {
  resolve(): Promise<RequestToolSurface>;
  current(): RequestToolSurface;
}

interface StaticTokenCache {
  value?: {
    readonly systemPrompt: string;
    readonly serializedDefinitions: string;
    readonly policyIdentity: TokenCountingPolicyIdentity | undefined;
    readonly tokens: number;
  };
}

function pin(
  plan: ToolExposurePlan,
  moduleSnapshot: FirstPartyModuleComposition,
  runtimeConfig: RuntimeConfigRequestCapture,
  staticTokenCache: StaticTokenCache,
  providerRuntime?: RequestProviderRuntime,
): RequestToolSurface {
  const tools = plan.tools;
  const enabledModuleIds = new Set(moduleSnapshot.enabledModuleIds);
  const requestRegistry = toolRegistryFromComposition(moduleSnapshot);
  const usableToolNames = new Set([...plan.usable].map((name) => plan.registrationIdentities.get(name) ?? name));
  const applicationIdentity = crypto.randomUUID();
  let stablePrompt: RequestStablePrompt | undefined;
  let admittedProviderRequest: Promise<AdmittedModelRequest> | undefined;
  const projections = new WeakMap<ToolPresentation, { definitions: readonly ProviderToolDef[]; auditDefinitions: readonly AuditToolDef[]; serializedDefinitions: string; omittedTools: ReadonlyArray<{ readonly name: string; readonly reason: string }> }>();
  return {
    tools,
    registrationIds: plan.registrationIds,
    usableToolNames,
    registrationIdentities: plan.registrationIdentities,
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
    async prepareStablePrompt(build, profile, literalOverride = false) {
      if (stablePrompt) return stablePrompt;
      const built = await build();
      // Each cache tier crosses the modelContext seam on its own so a transformer
      // cannot move bytes across the tier boundary, and each tier's applications
      // carry their own identity so the audit tells the passes apart. An
      // empty tier has no context to transform and stays empty so it renders as
      // absent.
      const transform = (tier: keyof SystemPromptTiers, value: string) => literalOverride || value.length === 0
        ? { value, applications: [] }
        : runModuleTransformerChain({
            seam: "modelContext",
            value,
            applicationIdentity: `${applicationIdentity}\u0000${tier}`,
            transformers: moduleSnapshot.transformers,
          });
      const stable = transform("stable", built.stable);
      const session = transform("session", built.session);
      const conversation = transform("conversation", built.conversation);
      const systemPrompt: SystemPromptTiers = { stable: stable.value, session: session.value, conversation: conversation.value };
      const definitions = projectProviderToolDefinitions(tools);

      const definitionChars = JSON.stringify(definitions).length;
      const omittedTools = plan.omitted.map((tool) => ({ ...tool }));

      stablePrompt = {
        systemPrompt,
        staticContextTokens: Math.ceil((renderSystemPrompt(systemPrompt).length + definitionChars) / 4),
        contextApplication: { identity: applicationIdentity, applications: [...stable.applications, ...session.applications, ...conversation.applications] },
        definitionChars,
        literalOverride,
        definitions,

        interactionProfileId: profile.id,
        omittedTools,
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
      let projection = projections.get(attempt.toolPresentation);
      if (!projection) {
        const { definitions } = stablePrompt;
        const auditDefinitions = definitions.map((definition) => {
          const registrationId = plan.registrationIds.get(definition.name);
          if (!registrationId) throw new Error(`Tool '${definition.name}' has no admitted executable registration identity`);
          const descriptor = attempt.toolPresentation.present(definition);
          return {
            name: attempt.toolPresentation.wireName?.(definition.name) ?? definition.name,
            description: descriptor.description,
            input_schema: definition.input_schema,
            registrationId,
            executableId: definition.name,
            kind: descriptor.kind,
            inputFormatSha256: hashToolInputFormat(descriptor.inputFormat),
          };
        });
        projection = {
          definitions,
          auditDefinitions,
          serializedDefinitions: JSON.stringify(definitions.map((definition) => ({
            ...definition, name: attempt.toolPresentation.wireName?.(definition.name) ?? definition.name,
          }))),
          omittedTools: stablePrompt.omittedTools,
        };
        projections.set(attempt.toolPresentation, projection);
      }
      const promptNotes = attempt.promptNotes ?? { progress: "", modelNotes: "" };
      const noteText = [promptNotes.progress, promptNotes.modelNotes].filter(Boolean).join("\n\n");
      // Provider notes vary by serving model, so they join the session tier.
      const systemPrompt: SystemPromptTiers = stablePrompt.literalOverride || noteText.length === 0
        ? stablePrompt.systemPrompt
        : { ...stablePrompt.systemPrompt, session: [stablePrompt.systemPrompt.session, `# Provider Interaction Notes\n\n${noteText}`].filter(Boolean).join(SYSTEM_PROMPT_SEPARATOR) };
      const renderedPrompt = renderSystemPrompt(systemPrompt);
      const policy = attempt.modelFamily === undefined
        ? undefined
        : tokenCountingPolicy(attempt.model, attempt.modelFamily, attempt.tokenizerIdentity);
      const cachedStaticTokens = staticTokenCache.value;
      const attemptStaticTokens = cachedStaticTokens?.systemPrompt === renderedPrompt
        && cachedStaticTokens.serializedDefinitions === projection.serializedDefinitions
        && cachedStaticTokens.policyIdentity === policy?.identity
        ? cachedStaticTokens.tokens
        : policy?.kind === "local"
          ? policy.countText(renderedPrompt) + policy.countText(projection.serializedDefinitions)
          : Math.ceil((renderedPrompt.length + projection.serializedDefinitions.length) / 4);
      staticTokenCache.value = {
        systemPrompt: renderedPrompt,
        serializedDefinitions: projection.serializedDefinitions,
        policyIdentity: policy?.identity,
        tokens: attemptStaticTokens,
      };
      return {
        systemPrompt,
        tools: projection.definitions,
        auditTools: projection.auditDefinitions,
        attemptStaticTokens,
        contextApplication: stablePrompt.contextApplication,
        interactionProfileId: stablePrompt.interactionProfileId,
        omittedTools: projection.omittedTools,
      };
    },
  };
}

/** Owner that captures one coherent capability composition for every request. */
export async function createRequestToolSurface(
  plan: (moduleSnapshot: FirstPartyModuleComposition, runtimeConfig: RuntimeConfigRequestCapture, providerRuntime: RequestProviderRuntime | undefined) => ToolExposurePlan | Promise<ToolExposurePlan>,
  moduleSelection: () => FirstPartyModuleComposition,
  captureRuntimeConfig: CaptureRuntimeConfig,
  prepareProviderRuntime?: (moduleSnapshot: FirstPartyModuleComposition, runtimeConfig: RuntimeConfigRequestCapture, selection?: RequestModelSelection) => Promise<RequestProviderRuntime>,
  captureSelection?: (runtimeConfig: RuntimeConfigRequestCapture, moduleSnapshot: FirstPartyModuleComposition) => Promise<RequestModelSelection>,
  initialProvider?: {
    readonly moduleSnapshot: FirstPartyModuleComposition;
    readonly runtimeConfig: RuntimeConfigRequestCapture;
    readonly providerRuntime: RequestProviderRuntime;
  },
): Promise<RequestToolSurfaceOwner> {
  const staticTokenCache: StaticTokenCache = {};
  const capture = async (moduleSnapshot: FirstPartyModuleComposition, runtimeConfig: RuntimeConfigRequestCapture, providerRuntime?: RequestProviderRuntime): Promise<RequestToolSurface> =>
    pin(await plan(moduleSnapshot, runtimeConfig, providerRuntime), moduleSnapshot, runtimeConfig, staticTokenCache, providerRuntime);
  let initialRequest = initialProvider
    ? await capture(initialProvider.moduleSnapshot, initialProvider.runtimeConfig, initialProvider.providerRuntime)
    : undefined;
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
      pinned = await capture(moduleSnapshot, providerRuntime?.runtimeConfig ?? runtimeConfig, providerRuntime);
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

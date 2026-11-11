import type { ModelFamily } from "../../infra/llm/model-family.js";
import { mergeProviderOptions } from "../../infra/llm/provider-options.js";
import { canonicalModelId } from "../../infra/llm/model-id.js";
import { Log } from "../../infra/log.js";
import type { AdmittedFailoverPlan, AccessProviderModelEligibility, AccessProviderSelection } from "../../infra/llm/access-provider.js";
import type { ProviderConnection } from "../../infra/auth/auth-context.js";
import type { ModelInfo } from "../../infra/llm/models.js";
import { EFFORT_VALUES } from "../../infra/workflow-types.js";
import { clampReasoningEffort } from "../agent-runtime/llm/model-compat.js";
import { parseBriefRoleId, briefPersonaRoleId } from "../../protocol/brief-role-id.js";
import { beginTierResolutionOperation, resolveModelForTierAcrossFamilies, type TierResolutionOptions } from "./model-tiers.js";
import { modelTierForReference } from "../../protocol/model-tier-reference.js";
import { ROLE_MODEL_DEFAULTS, roleModelDefault, selectRoleModelDefault } from "./role-model-defaults.js";
import { canonicalRoleId } from "./retired-config-names.js";
import { DEFAULT_ROLES, parentRoleId, type RoleId, type ResolvedRole, type ResolvedRoles } from "./roles.js";
import type { FlywheelConfig } from "./schema.js";
import { profileRoleSettings } from "./env.js";

const log = Log.create({ service: "role-resolution" });
type RoleConfig = Pick<FlywheelConfig, "profiles">;
type ProfileRoles = FlywheelConfig["profiles"][string]["roles"];

export interface RoleResolutionOptions extends TierResolutionOptions {
  readonly roleEnvironment?: Parameters<typeof profileRoleSettings>[1];
}

function canonicalizeRoleKeys(record: ProfileRoles): ProfileRoles {
  const out = new Map<string, ProfileRoles[string]>();
  for (const [roleId, value] of Object.entries(record)) {
    const canonical = canonicalRoleId(roleId);
    if (parseBriefRoleId(canonical) !== undefined) continue;
    // A canonical key wins over its retired spelling when both are present.
    if (canonical !== roleId && canonical in record) continue;
    out.set(canonical, value);
  }
  return Object.fromEntries(out);
}

/** The role whose configured setting `roleId` falls back to when the configuration has none for it: the family role
 *  of a persona role, the family seat of the same brief for a brief seat of a persona role, and the Workflow Agent
 *  for a brief's own seat. A brief seat resolves through the Workflow Agent, so a person's Workflow Agent setting wins
 *  over the seat's shipped default. A record seat holds a pair that a launch bound, which no other seat reaches. */
function fallbackRoleId(roleId: RoleId): RoleId | undefined {
  const selector = parseBriefRoleId(roleId);
  if (selector === undefined) return parentRoleId(roleId);
  if (selector.personaRole === undefined) return selector.definitionId === undefined ? "workflow-agent" : undefined;
  const parent = parentRoleId(selector.personaRole);
  return parent === undefined ? undefined : briefPersonaRoleId(selector.briefId, parent);
}

function configuredRole(
  configuredRoles: ProfileRoles,
  roleId: RoleId,
): ProfileRoles[string] | undefined {
  const parentId = fallbackRoleId(roleId);
  return configuredRoles[roleId]
    ?? (parentId ? configuredRoles[parentId] : undefined);
}

export type RoleSetting = { readonly model?: string; readonly effort?: string; readonly fixedEffort?: string; readonly provider_options?: ResolvedRole["providerOptions"] };

export type CapturedRoleSelection =
  | { readonly kind: "selected"; readonly role: ResolvedRole; readonly plan: AdmittedFailoverPlan }
  | { readonly kind: "no-selection" }
  | { readonly kind: "access-pending" };

interface RoleAccessCapture {
  readonly selection: AccessProviderSelection;
  readonly connection: ProviderConnection;
  readonly eligibility?: AccessProviderModelEligibility;
  readonly allowTrainingRoutes: boolean;
}

/** Resolves authored settings using only this capture's exact-account plans.
 * Pending discovery remains distinct from a ready profile with no reachable model. */
export function resolveCapturedRole(
  roleId: RoleId,
  setting: RoleSetting,
  capture: RoleAccessCapture,
  userDataRoot: string,
): Promise<CapturedRoleSelection> {
  return captureRoleResolver(capture, userDataRoot)(roleId, setting);
}

/** Builds exact-account plans once for all role previews from one immutable capture. */
export function captureRoleResolver(
  capture: RoleAccessCapture,
  userDataRoot: string,
): (roleId: RoleId, setting: RoleSetting) => Promise<CapturedRoleSelection> {
  return captureRoleCatalog(capture, userDataRoot).resolve;
}

/** Shares the admitted model inventory with read-only catalog inspection.
 * The resolver and inventory come from the same immutable eligibility capture. */
interface CapturedRoleCatalog {
  readonly plans: ReadonlyMap<string, AdmittedFailoverPlan>;
  readonly resolve: (roleId: RoleId, setting: RoleSetting) => Promise<CapturedRoleSelection>;
}

export function captureRoleCatalog(
  capture: RoleAccessCapture,
  userDataRoot: string,
): CapturedRoleCatalog {
  const plans = new Map<string, AdmittedFailoverPlan>();
  const available = new Map<ModelFamily, Set<string>>();
  const modelInfos = new Map<string, ModelInfo>();
  for (const model of capture.eligibility?.modelIds ?? []) {
    const plan = capture.selection.plan(model, capture.connection, capture.eligibility, capture.allowTrainingRoutes);
    if (plan.kind !== "admitted") continue;
    plans.set(plan.model, plan);
    const models = available.get(plan.family) ?? new Set<string>();
    models.add(plan.model);
    available.set(plan.family, models);
    const metadata = plan.candidateAttributions[0]?.resolvedModelMetadata;
    if (metadata) modelInfos.set(plan.model, metadata);
  }
  const options = beginTierResolutionOperation({ userDataRoot, modelInfos });
  const resolve = async (roleId: RoleId, setting: RoleSetting): Promise<CapturedRoleSelection> => {
    const role = await resolveRoleFromModels(roleId, setting, available, options);
    if (!role) return { kind: capture.eligibility?.accessPending?.(capture.allowTrainingRoutes) ? "access-pending" : "no-selection" };
    const plan = plans.get(role.model);
    if (!plan) throw new Error(`Selected role has no captured plan: ${roleId}`);
    return { kind: "selected", role, plan };
  };
  return { plans, resolve };
}

/** Resolves one authored setting against admitted models; returns undefined for empty availability. */
export async function resolveRoleFromModels(
  roleId: RoleId,
  configured: RoleSetting,
  available: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined,
  options: TierResolutionOptions,
): Promise<ResolvedRole | undefined> {
  if (!available || ![...available.values()].some((models) => models.size > 0)) return undefined;
  const defaults = roleModelDefault(roleId);
  const savedModel = configured.model ? canonicalModelId(configured.model) : undefined;
  const savedTier = modelTierForReference(savedModel);
  const savedReachable = savedModel !== undefined && [...available.values()]
    .some((models) => [...models].some((model) => canonicalModelId(model) === savedModel));
  const preference = selectRoleModelDefault(roleId, available);
  const selected = savedTier
    ? { model: (await resolveModelForTierAcrossFamilies(savedTier, available, options)).model, effort: configured.effort ?? defaults.tier.effort }
    : savedReachable
      ? { model: savedModel, effort: configured.effort ?? (savedModel === defaults.anthropic.model ? defaults.anthropic.effort : defaults.tier.effort) }
      : preference ?? { model: (await resolveModelForTierAcrossFamilies(defaults.tier.tier, available, options)).model, effort: defaults.tier.effort };
  const requestedEffort = configured.fixedEffort ?? (configured.model === undefined ? configured.effort ?? selected.effort : selected.effort);
  const canonicalEffort = EFFORT_VALUES.find((effort) => effort === requestedEffort);
  const effort = canonicalEffort === undefined ? requestedEffort : clampReasoningEffort(canonicalEffort, options.modelInfos?.get(selected.model) ?? null, ["low", "medium", "high"]);
  const providerOptions = mergeProviderOptions(configured.provider_options);
  return { roleId, model: selected.model, effort, ...(providerOptions ? { providerOptions } : {}) };
}

/** Resolves the selected profile's role settings against the supplied model catalog.
 * When onlyRoleIds is supplied, unrelated roles do not request model metadata. */
export function resolveRoles(
  config: RoleConfig,
  availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined,
  options: RoleResolutionOptions,
  activeProfileId?: string,
  additionalRoleIds: Iterable<RoleId> = [],
  onlyRoleIds?: ReadonlySet<RoleId>,
): Promise<ResolvedRoles> {
  return resolveRolesForProfile(profileRoleSettings(activeProfileId === undefined ? undefined : config.profiles[activeProfileId]?.roles, options.roleEnvironment), availableModels, options, additionalRoleIds, onlyRoleIds);
}

/** Every role the registries declare: the role metadata, the roles with a
 *  shipped model default, and the caller's additional roles (persona and
 *  brief roles), canonicalized. Role resolution resolves these and any role
 *  the configuration names. */
export function registeredRoleIds(additionalRoleIds: Iterable<RoleId> = []): ReadonlySet<RoleId> {
  return new Set<RoleId>([
    ...Object.keys(DEFAULT_ROLES),
    ...Object.keys(ROLE_MODEL_DEFAULTS),
    ...[...additionalRoleIds].map(canonicalRoleId),
  ]);
}

/** Resolves roles from one request's selected profile settings.
 * onlyRoleIds limits resolution without adding roles absent from the configuration and registry. */
export async function resolveRolesForProfile(
  configuredRolesRaw: ProfileRoles,
  availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined,
  options: TierResolutionOptions,
  additionalRoleIds: Iterable<RoleId> = [],
  onlyRoleIds?: ReadonlySet<RoleId>,
): Promise<ResolvedRoles> {
  const operationOptions = beginTierResolutionOperation(options);
  const configuredRoles = canonicalizeRoleKeys(configuredRolesRaw);
  const roleIds = new Set<RoleId>([
    ...registeredRoleIds(additionalRoleIds),
    ...Object.keys(configuredRoles),
  ]);
  const roles = new Map<RoleId, ResolvedRole>();
  for (const roleId of roleIds) {
    if (onlyRoleIds !== undefined && !onlyRoleIds.has(roleId)) continue;
    const configured = configuredRole(configuredRoles, roleId) ?? {};
    const role = await resolveRoleFromModels(roleId, configured, availableModels, operationOptions);
    if (role) roles.set(roleId, role);
  }
  log.debug("roles resolved", Object.fromEntries([...roles].map(([id, role]) => [id, `${role.model}/${role.effort}`])));
  return roles;
}

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
import { ROLE_MODEL_DEFAULTS, reachableRoleModelDefaults, roleModelDefault } from "./role-model-defaults.js";
import type { CapacityReset } from "../../infra/llm/provider-error-copy.js";
import type { ModelStanding } from "../agent-runtime/llm/model-standing.js";
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

/** A role preference that an agent's request passed over because its included quota is spent until `reset`. */
export interface PassedPreference {
  readonly model: string;
  readonly effort: string;
  readonly reset: CapacityReset;
  readonly providers: readonly string[];
}

export type CapturedRoleSelection =
  | {
      readonly kind: "selected"; readonly role: ResolvedRole; readonly plan: AdmittedFailoverPlan;
      /** The highest preference, when the selection passed it over for its spent quota (PI-MODEL-056). */
      readonly passed?: PassedPreference;
      /** The earliest moment a preference serves again, when none can serve now (PI-MODEL-039). */
      readonly spentUntil?: CapacityReset;
    }
  | { readonly kind: "no-selection" }
  | { readonly kind: "access-pending" };

/** Reads one admitted model's standing from the request's captured availability under the role's effective provider
 *  options (ARCH-PROVIDERS-080). */
export type ModelStandingReader = (plan: AdmittedFailoverPlan, providerOptions: ResolvedRole["providerOptions"]) => Promise<ModelStanding>;

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
  standing?: ModelStandingReader,
): Promise<CapturedRoleSelection> {
  return captureRoleCatalog(capture, userDataRoot).resolve(roleId, setting, standing);
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
  /** With `standing`, an agent's request passes over a preference that cannot serve now (PI-MODEL-087): the first
   *  preference that serves on included quota wins, then the first that serves on a paid route, then the first. */
  readonly resolve: (roleId: RoleId, setting: RoleSetting, standing?: ModelStandingReader) => Promise<CapturedRoleSelection>;
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
  const planOf = (model: string): AdmittedFailoverPlan => {
    const plan = plans.get(model);
    if (!plan) throw new Error(`Selected role has no captured plan: ${model}`);
    return plan;
  };
  const resolve = async (roleId: RoleId, setting: RoleSetting, standing?: ModelStandingReader): Promise<CapturedRoleSelection> => {
    if (!hasModels(available)) return { kind: capture.eligibility?.accessPending?.(capture.allowTrainingRoutes) ? "access-pending" : "no-selection" };
    const preferences = rolePreferences(roleId, setting, available, options);
    if (standing === undefined) {
      const first = await firstOf(preferences);
      return { kind: "selected", role: finalizedRole(roleId, setting, first, options), plan: planOf(first.model) };
    }
    const providerOptions = mergeProviderOptions(setting.provider_options);
    let first: { readonly preference: RolePreference; readonly standing: ModelStanding } | undefined;
    let paid: RolePreference | undefined;
    let served: RolePreference | undefined;
    let earliest: CapacityReset | undefined;
    const judged = new Set<string>();
    for await (const preference of preferences) {
      if (judged.has(preference.model)) continue;
      judged.add(preference.model);
      const current = await standing(planOf(preference.model), providerOptions);
      first ??= { preference, standing: current };
      if (current.kind === "serves") {
        served = preference;
        break;
      }
      if (current.kind === "paid") paid ??= preference;
      else if (current.kind === "spent" && (earliest === undefined || current.spent.reset.atMs < earliest.atMs)) earliest = current.spent.reset;
    }
    if (first === undefined) throw new Error(`Role has no preference: ${roleId}`);
    const selected = served ?? paid ?? first.preference;
    const spentQuota = first.standing.kind === "spent" || first.standing.kind === "paid" ? first.standing.spent : undefined;
    const passed = selected !== first.preference && spentQuota !== undefined
      ? { model: first.preference.model, effort: first.preference.effort, ...spentQuota }
      : undefined;
    const spentUntil = served === undefined && paid === undefined ? earliest : undefined;
    return {
      kind: "selected", role: finalizedRole(roleId, setting, selected, options), plan: planOf(selected.model),
      ...(passed === undefined ? {} : { passed }),
      ...(spentUntil === undefined ? {} : { spentUntil }),
    };
  };
  return { plans, resolve };
}

interface RolePreference {
  readonly model: string;
  readonly effort: string;
}

function hasModels(available: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined): available is ReadonlyMap<ModelFamily, ReadonlySet<string>> {
  return available !== undefined && [...available.values()].some((models) => models.size > 0);
}

/** The role's reachable preferences in PI-MODEL-016 order: the saved tier or the saved model, the coded OpenAI
 *  preference, the coded Anthropic preference, and the price tier. Lazy, so a request whose first preference serves
 *  resolves no tier.
 *  @yields {RolePreference} Each preference with its own effort; the tier preference always comes last. */
async function* rolePreferences(
  roleId: RoleId,
  configured: RoleSetting,
  available: ReadonlyMap<ModelFamily, ReadonlySet<string>>,
  options: TierResolutionOptions,
): AsyncGenerator<RolePreference> {
  const defaults = roleModelDefault(roleId);
  const savedModel = configured.model ? canonicalModelId(configured.model) : undefined;
  const savedTier = modelTierForReference(savedModel);
  const reachable = (model: string) => [...available.values()].some((models) => [...models].some((listed) => canonicalModelId(listed) === model));
  if (savedTier) yield { model: (await resolveModelForTierAcrossFamilies(savedTier, available, options)).model, effort: configured.effort ?? defaults.tier.effort };
  else if (savedModel !== undefined && reachable(savedModel)) {
    yield { model: savedModel, effort: configured.effort ?? (savedModel === defaults.anthropic.model ? defaults.anthropic.effort : defaults.tier.effort) };
  }
  yield* reachableRoleModelDefaults(roleId, available);
  yield { model: (await resolveModelForTierAcrossFamilies(defaults.tier.tier, available, options)).model, effort: defaults.tier.effort };
}

/** The resolved role of `selected`: a fixed effort wins, an authored effort applies when no model is saved, and the
 *  effort maps to the nearest one the model supports. */
function finalizedRole(roleId: RoleId, configured: RoleSetting, selected: RolePreference, options: TierResolutionOptions): ResolvedRole {
  const requestedEffort = configured.fixedEffort ?? (configured.model === undefined ? configured.effort ?? selected.effort : selected.effort);
  const canonicalEffort = EFFORT_VALUES.find((effort) => effort === requestedEffort);
  const effort = canonicalEffort === undefined ? requestedEffort : clampReasoningEffort(canonicalEffort, options.modelInfos?.get(selected.model) ?? null, ["low", "medium", "high"]);
  const providerOptions = mergeProviderOptions(configured.provider_options);
  return { roleId, model: selected.model, effort, ...(providerOptions ? { providerOptions } : {}) };
}

/** Resolves one authored setting against admitted models; returns undefined for empty availability. */
export async function resolveRoleFromModels(
  roleId: RoleId,
  configured: RoleSetting,
  available: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined,
  options: TierResolutionOptions,
): Promise<ResolvedRole | undefined> {
  if (!hasModels(available)) return undefined;
  return finalizedRole(roleId, configured, await firstOf(rolePreferences(roleId, configured, available, options)), options);
}

async function firstOf(preferences: AsyncIterator<RolePreference>): Promise<RolePreference> {
  const first = await preferences.next();
  if (first.done === true) throw new Error("A role always yields its tier preference");
  return first.value;
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

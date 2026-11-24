import type { ModelFamily } from "../../../infra/llm/models/model-family.js";
import { mergeProviderOptions } from "../../../infra/llm/access/provider-options.js";
import { canonicalCatalogModelId, canonicalModelId } from "../../../infra/model-id.js";
import { isCustomProviderModel } from "../../../infra/llm/custom-provider-registry.js";
import { installedAccessProviderDefinitions } from "../../credential-provider-modules.js";
import { getSharedModelsClient } from "./llm-clients.js";
import { AuthProfileDirectoryNotFoundError, openExistingAuthProfileDirectory, type AuthProfileAccess } from "../../../infra/auth/store/auth-profile-store.js";
import { savedProviderModelIds } from "../../../infra/auth/provider-models/provider-model-catalog-store.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS } from "../../../infra/model-catalog-rows.js";
import { normalizeSelectableModelId } from "./model-compatibility.js";
import { Log } from "../../../infra/diagnostics/log.js";
import type { AdmittedFailoverPlan, AccessProviderModelEligibility, AccessProviderSelection } from "../../../infra/llm/access/access-provider.js";
import type { ProviderConnection } from "../../../infra/auth/auth-context.js";
import type { ModelInfo } from "../../../infra/llm/models/models.js";
import { EFFORT_VALUES } from "../../../infra/workflow-types.js";
import { clampReasoningEffort, newestLaterModelVersion } from "../../agent-runtime/llm/model-compat.js";
import { parseBriefRoleId, briefPersonaRoleId } from "../../../protocol/brief-role-id.js";
import { beginTierResolutionOperation, modelPriceTier, resolveModelForTierAcrossFamilies, type TierResolutionOptions } from "./model-tiers.js";
import { modelTierForReference } from "../../../protocol/model-tier-reference.js";
import { ROLE_MODEL_DEFAULTS, reachableRoleModelDefaults, roleModelDefault } from "./role-model-defaults.js";
import { canonicalRoleId } from "../retired-config-names.js";
import { DEFAULT_ROLES, parentRoleId, SUBAGENT_SUMMARY_ROLE_ID, TITLE_GENERATION_ROLE_ID, type RoleId, type ResolvedRole, type ResolvedRoles } from "../roles.js";
import type { FlywheelConfig } from "../schema/schema.js";
import { profileRoleSettings } from "../env.js";

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

export type RoleSetting = { readonly model?: string; readonly effort?: string; readonly defaultEffort?: string; readonly provider_options?: ResolvedRole["providerOptions"]; readonly fixedModel?: boolean };

/** The roles of background work that is no agent: an unreachable saved model yields to the role's default, so a
 *  session title or a failure summary is never held back (PI-MODEL-019). Every other role keeps its saved model and
 *  its agent waits for it (PI-MODEL-087). */
const FALLBACK_ROLE_IDS: ReadonlySet<RoleId> = new Set([TITLE_GENERATION_ROLE_ID, SUBAGENT_SUMMARY_ROLE_ID]);

export type CapturedRoleSelection =
  | { readonly kind: "selected"; readonly role: ResolvedRole; readonly plan: AdmittedFailoverPlan }
  /** The role's saved model, which no admitted account or enabled provider serves now: its agent waits for it. When
   *  no catalog lists the model (`listed` false), the id is a configuration error that no wait can clear. */
  | { readonly kind: "unserved"; readonly role: ResolvedRole; readonly listed: boolean }
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
  return captureRoleCatalog(capture, userDataRoot).resolve(roleId, setting);
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

/** The catalogs already built, by the capture's selection, connection, and eligibility objects, then by the
 *  training-route permission and the data root. Every object level is weak: a long-lived connection meets a new
 *  eligibility object on each publication, and the catalogs of an earlier eligibility go with it. */
const capturedCatalogs = new WeakMap<AccessProviderSelection, WeakMap<ProviderConnection, WeakMap<AccessProviderModelEligibility, Map<string, CapturedRoleCatalog>>>>();

/** The role catalog of one capture. A capture's selection, connection, and eligibility are immutable, so every
 *  resolve of one capture, such as a request's session roles and its serving role, shares one catalog and plans each
 *  eligible model once. A new capture is a new object and builds a new catalog. A capture with no eligibility plans no
 *  model, so its catalog is not held. */
export function captureRoleCatalog(
  capture: RoleAccessCapture,
  userDataRoot: string,
): CapturedRoleCatalog {
  if (!capture.eligibility) return buildRoleCatalog(capture, userDataRoot);
  let byConnection = capturedCatalogs.get(capture.selection);
  if (!byConnection) {
    byConnection = new WeakMap();
    capturedCatalogs.set(capture.selection, byConnection);
  }
  let byEligibility = byConnection.get(capture.connection);
  if (!byEligibility) {
    byEligibility = new WeakMap();
    byConnection.set(capture.connection, byEligibility);
  }
  let catalogs = byEligibility.get(capture.eligibility);
  if (!catalogs) {
    catalogs = new Map();
    byEligibility.set(capture.eligibility, catalogs);
  }
  const key = `${capture.allowTrainingRoutes}\u0000${userDataRoot}`;
  const held = catalogs.get(key);
  if (held) return held;
  const catalog = buildRoleCatalog(capture, userDataRoot);
  catalogs.set(key, catalog);
  return catalog;
}

function buildRoleCatalog(
  capture: RoleAccessCapture,
  userDataRoot: string,
): CapturedRoleCatalog {
  const plans = new Map<string, AdmittedFailoverPlan>();
  const available = new Map<ModelFamily, Set<string>>();
  const modelInfos = new Map<string, ModelInfo>();
  // The models that a subscription offers on its included quota, which the tier fallback prefers inside each tier.
  const includedModels = new Set<string>();
  for (const model of capture.eligibility?.modelIds ?? []) {
    const plan = capture.selection.plan(model, capture.connection, capture.eligibility, capture.allowTrainingRoutes);
    if (plan.kind !== "admitted") continue;
    plans.set(plan.model, plan);
    const models = available.get(plan.family) ?? new Set<string>();
    models.add(plan.model);
    available.set(plan.family, models);
    const metadata = plan.candidateAttributions[0]?.resolvedModelMetadata;
    if (metadata) modelInfos.set(plan.model, metadata);
    if (plan.candidateAttributions.some(({ candidate }) => candidate.spendMode === "included")) includedModels.add(plan.model);
  }
  const options = beginTierResolutionOperation({ userDataRoot, modelInfos, includedModels });
  const resolve = async (roleId: RoleId, setting: RoleSetting): Promise<CapturedRoleSelection> => {
    if (!hasModels(available)) {
      const saved = savedPreference(roleId, setting, new Set());
      if (!setting.fixedModel && capture.eligibility?.accessPending(capture.allowTrainingRoutes)) return { kind: "access-pending" };
      return saved === undefined ? { kind: "no-selection" } : { kind: "unserved", role: finalizedRole(roleId, setting, saved, options), listed: catalogListsModel(saved.model, capture, userDataRoot) };
    }
    const preference = await rolePreference(roleId, setting, available, options);
    const role = finalizedRole(roleId, setting, preference, options);
    const plan = plans.get(preference.model);
    return plan === undefined ? { kind: "unserved", role, listed: catalogListsModel(preference.model, capture, userDataRoot) } : { kind: "selected", role, plan };
  };
  return { plans, resolve };
}

/** Whether any catalog Flywheel reads lists `model`: the capture's account catalogs, a custom provider's declared
 *  models, the models.dev rows of an installed provider, also of a module that is off, in the current or the
 *  bundled document, or the saved listing of any account of the profile, also of one that is signed out or whose
 *  token expired. Only the path of a model that no account serves reads it. */
function catalogListsModel(model: string, capture: RoleAccessCapture, userDataRoot: string): boolean {
  const normalized = normalizeSelectableModelId(model);
  if (capture.eligibility?.modelIds.has(normalized) || isCustomProviderModel(normalized)) return true;
  const namespaces = [...new Set(installedAccessProviderDefinitions().flatMap((provider) =>
    provider.catalogId === undefined ? provider.dynamicCatalog?.modelsDevCatalogIds ?? [] : [provider.catalogId]))];
  const client = getSharedModelsClient(userDataRoot);
  return (["current", "bundled"] as const).some((document) => client.getProviderCatalog(namespaces, Number.MAX_SAFE_INTEGER - 1, document)
    .some((row) => (row.canonical?.modelId ?? canonicalCatalogModelId(row.wireModelId).modelId) === normalized))
    || savedListingsName(normalized, capture.connection.authDir);
}

/** Whether a saved account listing of the profile at `profileDirectory` names `model`. A live listing can name a model
 *  that models.dev does not, and its account can sign out while a role keeps the model (PI-MODEL-039). */
function savedListingsName(model: string, profileDirectory: string): boolean {
  let access: AuthProfileAccess;
  try {
    access = openExistingAuthProfileDirectory(profileDirectory);
  } catch (error) {
    if (error instanceof AuthProfileDirectoryNotFoundError) return false;
    throw error;
  }
  try {
    return savedProviderModelIds(access, DEFAULT_DYNAMIC_CATALOG_LIMITS).has(model);
  } finally {
    access.close();
  }
}

interface RolePreference {
  readonly model: string;
  readonly effort: string;
}

function hasModels(available: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined): available is ReadonlyMap<ModelFamily, ReadonlySet<string>> {
  return available !== undefined && [...available.values()].some((models) => models.size > 0);
}

/** A saved model follows its family only at selection, not when admitting an already fixed model (PI-MODEL-087). */
function savedPreference(roleId: RoleId, configured: RoleSetting, available: ReadonlySet<string>): RolePreference | undefined {
  const model = configured.model ? canonicalModelId(configured.model) : undefined;
  if (model === undefined || modelTierForReference(model) !== undefined) return undefined;
  const selected = configured.fixedModel || available.has(model) ? model : newestLaterModelVersion(model, available);
  if (selected === undefined && FALLBACK_ROLE_IDS.has(roleId)) return undefined;
  const { preferences } = roleModelDefault(roleId);
  return { model: selected ?? model, effort: configured.effort ?? preferences.find((preference) => preference.model === model)?.effort ?? preferences[0].effort };
}

/** The role's selection in PI-MODEL-016 order: the saved tier or the saved model (`savedPreference`), then the first
 *  reachable coded preference in the role's order, then the role's tier fallback: its benchmark fallback, else the
 *  price tier of its first coded preference at that preference's effort. */
async function rolePreference(
  roleId: RoleId,
  configured: RoleSetting,
  available: ReadonlyMap<ModelFamily, ReadonlySet<string>>,
  options: TierResolutionOptions,
): Promise<RolePreference> {
  const { preferences, fallback } = roleModelDefault(roleId);
  const [first] = preferences;
  const savedTier = modelTierForReference(configured.model ? canonicalModelId(configured.model) : undefined);
  if (savedTier) return { model: (await resolveModelForTierAcrossFamilies(savedTier, available, options)).model, effort: configured.effort ?? first.effort };
  const saved = savedPreference(roleId, configured, new Set([...available.values()].flatMap((models) => [...models].map(canonicalModelId))));
  if (saved !== undefined) return saved;
  const coded = reachableRoleModelDefaults(preferences, available)[0];
  if (coded !== undefined) return { model: coded.model, effort: coded.effort };
  const { tier, effort } = fallback ?? { tier: modelPriceTier(first.model, first.family, options), effort: first.effort };
  return { model: (await resolveModelForTierAcrossFamilies(tier, available, options)).model, effort };
}

/** The resolved role of `selected`: a workflow's default effort wins, an authored effort applies when no model is saved, and the
 *  effort maps to the nearest one the model supports. */
function finalizedRole(roleId: RoleId, configured: RoleSetting, selected: RolePreference, options: TierResolutionOptions): ResolvedRole {
  const requestedEffort = configured.defaultEffort ?? (configured.model === undefined ? configured.effort ?? selected.effort : selected.effort);
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
  return finalizedRole(roleId, configured, await rolePreference(roleId, configured, available, options), options);
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

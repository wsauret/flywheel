import type { AuthContext } from "../../infra/auth/auth-context.js";
import { resolveAuthContext } from "../../infra/auth/auth-context.js";
import { installedCredentialProviderIds } from "../credential-provider-modules.js";
import { credentialSlotClassifier } from "../auth/credential-slot-classifier.js";
import type { ModelFamily } from "../../infra/llm/model-family.js";
import { offeringTransportFamily } from "../../infra/llm/model-catalog-resolution.js";
import type { ResolvedProviderModels } from "../../infra/llm/provider-model-preferences.js";
import { resolveEnabledProviderModelCatalog } from "./model-assignment-providers.js";
import type { EffortOptionRow, ModelAssignmentPatch, ModelAssignmentRow, ModelOptionRow, ModelSelectionEffort, ModelSelectionSlot, ModelTier } from "../../protocol/model-assignment-protocol-types.js";
import type { ModelConfigDeps, ModelPickerConfigDeps } from "./model-assignment-types.js";
import { normalizeSelectableModelId } from "./model-compatibility.js";
import {
  type ModelPowerSortRank,
  type TierResolutionOptions,
  modelPowerSortRank,
  resolveSelectedRouteRanks,
} from "./model-tiers.js";
import { isModelTierReference } from "../../protocol/model-tier-reference.js";
import { type RoleModelCandidate, selectRoleModelDefault } from "./role-model-defaults.js";
import { defaultRoleSlots, isBriefSlot, resolveSlotRole, slotLabel, roleSlot } from "./role-selection.js";
import { parentRoleId, type ResolvedRole } from "./roles.js";
import { canonicalRoleId } from "./retired-config-names.js";
import { effectiveRoleAssignments, previewSessionRoles } from "./session-role-resolver.js";
import { profileRoleSettings } from "./env.js";
import type { RoleResolutionOptions } from "./role-resolution.js";
import { parseBriefRoleId, briefPersonaRoleId, briefRoleId } from "../../protocol/brief-role-id.js";
import type { FlywheelConfig } from "./schema.js";
import { createRuntimeConfigOwner } from "./runtime-config-owner.js";
import { pruneStaleConfig, updateModelAssignments } from "./writer.js";
import { clampReasoningEffort, effortOptionsForMetadata } from "../agent-runtime/llm/model-compat.js";

/** Clears the profile's assignment of each default role that `resets` names, so it resolves to its detected default.
 *  A role that `resets` does not name keeps its saved value. The prune reads only the complete installed registry,
 *  `deps.configValidity`, so a saved custom persona role outlives a reset that leaves it out (ARCH-RUNTIME-069);
 *  without that registry it prunes nothing. */
export async function resetRoleAssignmentsToDetectedDefaults(deps: ModelConfigDeps & { readonly authProfileId: () => string }, resets: (roleId: string) => boolean): Promise<void> {
  const owner = await createRuntimeConfigOwner({ userDataRoot: deps.userDataRoot, configPath: deps.configPath, watch: false });
  try {
    updateModelAssignments({
      mutations: defaultRoleSlots().filter((slot) => resets(slot.roleId)).map((slot) => ({ slot, patch: { model: null, effort: null } })),
      validity: deps.configValidity ?? {},
    }, { userDataRoot: deps.userDataRoot, configPath: deps.configPath, authProfileId: deps.authProfileId });
    await owner.refresh();
  } finally {
    await owner.dispose();
  }
}

export async function listModelAssignments(deps: ModelConfigDeps): Promise<ModelAssignmentRow[]> {
  await pruneStaleConfigSections(deps);
  const auth = await resolveAuth(deps);
  const { availableModels, modelInfos } = await resolveModelCatalogs({ ...deps, auth });
  const options = tierOptions(deps, modelInfos);
  const slots = deps.slots ?? defaultRoleSlots();
  const requestedRoles = selectionRoleIds(slots, deps.agentPersonas);
  const roles = await assignmentRoles(deps, availableModels, options, requestedRoles);
  if (roles.size === 0) return [];
  const rows: ModelAssignmentRow[] = [];
  for (const slot of slots) {
    const resolved = resolveSlotRole(slot, roles, deps.agentPersonas);
    const selector = parseBriefRoleId(slot.roleId);
    const parentId = parentRoleId(selector?.personaRole ?? slot.roleId);
    const parentRole = selector && parentId ? briefPersonaRoleId(selector.briefId, parentId) : parentId;
    const profile = assignmentSettings(deps);
    const exactProfile = profile?.[slot.roleId];
    const parentProfile = parentRole ? profile?.[parentRole] : undefined;
    const savedModel = exactProfile?.model ?? parentProfile?.model;
    const inherited = resolveSlotRole(slot, await assignmentRoles(withoutExactAssignment(deps, slot.roleId), availableModels, options, requestedRoles), deps.agentPersonas);
    rows.push({
      slot,
      label: slotLabel(slot),
      model: resolved.model,
      effort: coerceEffort(resolved.effort),
      modelSource: assignmentFieldSource(
        exactProfile?.model && sameModelId(exactProfile.model, resolved.model) ? exactProfile.model : undefined,
        parentProfile?.model && sameModelId(parentProfile.model, resolved.model) ? parentProfile.model : undefined,
        isBriefSlot(slot),
      ),
      ...(savedModel && !isModelTierReference(savedModel) && !sameModelId(savedModel, resolved.model) ? { savedModel } : {}),
      matchesInheritedPair: sameModelId(resolved.model, inherited.model)
        && coerceEffort(resolved.effort) === coerceEffort(inherited.effort),
    });
  }
  return rows;
}

/** Resolve the full serving selection for a picker seat. Unlike its display
 * row, this retains provider options for an effort-only edit. An empty admitted
 * catalog has no selection, but does not prevent saving a later choice. */
export async function resolveModelAssignment(slot: ModelSelectionSlot, deps: ModelConfigDeps): Promise<ResolvedRole | undefined> {
  const auth = await resolveAuth(deps);
  const { availableModels, modelInfos } = await resolveModelCatalogs({ ...deps, auth });
  const roles = await assignmentRoles(deps, availableModels, tierOptions(deps, modelInfos), selectionRoleIds([slot], deps.agentPersonas));
  return roles.size === 0 ? undefined : resolveSlotRole(slot, roles, deps.agentPersonas);
}

function withoutExactAssignment(
  deps: ModelConfigDeps,
  roleId: string,
): ModelConfigDeps {
  const { config } = deps;
  const profileId = deps.authProfileId?.();
  const canonicalId = canonicalRoleId(roleId);
  const profile = profileId === undefined ? undefined : config.profiles[profileId];
  const session = deps.sessionRoleAssignments;
  return {
    ...deps,
    ...(profile && profileId !== undefined ? { config: { ...config, profiles: { ...config.profiles, [profileId]: {
      ...profile, roles: Object.fromEntries(Object.entries(profile.roles).filter(([id]) => canonicalRoleId(id) !== canonicalId)),
    } } } } : {}),
    ...(session ? { sessionRoleAssignments: { ...session, overrides: Object.fromEntries(Object.entries(session.overrides).filter(([id]) => canonicalRoleId(id) !== canonicalId)) } } : {}),
  };
}

function assignmentFieldSource(
  exactProfile: unknown,
  parentProfile: unknown,
  brief: boolean,
): ModelAssignmentRow["modelSource"] {
  if (exactProfile !== undefined) return "explicit";
  if (parentProfile !== undefined) return "inherited";
  if (brief) return "inherited";
  return "default";
}

export async function listModelOptionsForSlot(
  slot: ModelSelectionSlot,
  deps: ModelPickerConfigDeps,
): Promise<ModelOptionRow[]> {
  const auth = await resolveAuth(deps);
  const { availableModels, modelInfos } = await resolveModelCatalogs({ ...deps, auth });
  const options = tierOptions(deps, modelInfos);
  const requestedRoles = selectionRoleIds([slot], deps.agentPersonas);
  const roles = await assignmentRoles(deps, availableModels, options, requestedRoles);
  if (roles.size === 0) return [];
  const current = resolveSlotRole(slot, roles, deps.agentPersonas);
  const rows: FamilyOptionRow[] = [];
  const selector = parseBriefRoleId(slot.roleId);
  const parentId = parentRoleId(selector?.personaRole ?? slot.roleId);
  const isInheriting = Boolean((isBriefSlot(slot) || parentId) && !rawConfigForSlot(slot, deps).model);
  let inheritedSelection: ResolvedRole | undefined;
  if (isBriefSlot(slot) || parentId) {
    inheritedSelection = resolveSlotRole(slot, await assignmentRoles(withoutExactAssignment(deps, slot.roleId), availableModels, options, requestedRoles), deps.agentPersonas);
  }
  const pickerModels = deps.providerModelEligibility();
  const pickerByModel = new Map([...pickerModels].map(([model, eligibility]) => [normalizeSelectableModelId(model), eligibility] as const));
  const selectedRoutes = deps.selectedModelRoutes;
  const normalizedPickerModels = new Set(
    [...availableModels.values()].flatMap((models) => [...models].map(normalizeSelectableModelId)),
  );
  // One row per model, not per (provider, model) pair: a selection stores no
  // provider, so the family chain picks the access provider at request time.
  for (const model of normalizedPickerModels) {
    const eligibility = pickerByModel.get(model);
    const family = eligibility?.transport === undefined
      ? [...availableModels].find(([, models]) => models.has(model))?.[0]
      : offeringTransportFamily(eligibility.transport);
    if (!family) continue;
    const selectedRoute = selectedRoutes?.get(model);
    if (selectedRoute?.reason !== undefined) continue;
    const efforts = effortOptionsForMetadata(selectedRoute?.metadata);
    const isCurrentModel = sameModelId(current.model, model);
    rows.push({
      slot,
      model,
      label: model,
      family,
      selectable: true,
      current: isCurrentModel && !isInheriting,
      efforts,
      effort: effectiveOptionEffort(efforts, current.setting?.fixedEffort ?? current.effort),
      providers: selectedRoute?.providers ?? [],
      ...(eligibility?.catalog?.kind === "available" ? { catalogProvenance: eligibility.catalog.provenance } : {}),
    });
  }
  const fallback = roleDefaultForSlot(slot, availableModels);
  if (fallback) for (const row of rows) if (row.model && sameModelId(row.model, fallback.model)) row.roleDefault = true;
  const ranks = await modelOptionRanks(rows, availableModels, options, selectedRoutes);
  applyModelTiers(rows, ranks);
  if (isInheriting) for (const row of rows) if (!row.inherit) row.current = false;
  if (inheritedSelection) {
    const matching = rows.find((row) => row.model !== null && sameModelId(row.model, inheritedSelection.model));
    const efforts = matching?.efforts ?? await effortOptionsForModel(inheritedSelection.model, options);
    rows.push({
      slot,
      model: null,
      // A record seat inherits from whichever seat serves it, which can be its persona.
      label: `Inherit ${slotLabel(roleSlot(selector?.definitionId !== undefined ? inheritedSelection.roleId : parentId ?? inheritedSelection.roleId))}`,
      ...(matching?.family === undefined ? {} : { family: matching.family }),
      tier: "default",
      selectable: true,
      current: isInheriting,
      inherit: true,
      efforts,
      effort: effectiveOptionEffort(efforts, inheritedSelection.effort),
      inheritModel: inheritedSelection.model,
      ...(matching?.cost === undefined ? {} : { cost: matching.cost }),
      providers: matching?.providers ?? [],
    });
  }
  return rows.sort((a, b) =>
    Number(Boolean(b.inherit)) - Number(Boolean(a.inherit)) ||
    powerTierSort(a, ranks) - powerTierSort(b, ranks) ||
    modelPowerSort(a, b, ranks) ||
    familySort(a.family) - familySort(b.family) ||
    Number(Boolean(b.current)) - Number(Boolean(a.current)) ||
    a.label.localeCompare(b.label)
  ).map(({ family: _ordered, ...row }) => row);
}

/** A picker row with the API family that ranks and orders it. The family stays here: no client names it (PI-MODEL-015). */
type FamilyOptionRow = ModelOptionRow & { family?: ModelFamily };

/** Preserve the authored pair, including an explicit choice of today's default. */
export function normalizeAssignmentPatch(patch: ModelAssignmentPatch): ModelAssignmentPatch {
  return patch.model ? { ...patch, model: normalizeSelectableModelId(patch.model) } : patch;
}

/** The role default a cleared entry would resolve to, for slots that have one.
 *  Brief slots inherit from the Workflow Agent instead, which the inherit row
 *  already expresses. */
function roleDefaultForSlot(
  slot: ModelSelectionSlot,
  availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>>,
): RoleModelCandidate | undefined {
  return isBriefSlot(slot) ? undefined : selectRoleModelDefault(slot.roleId, availableModels);
}

function sameModelId(a: string, b: string): boolean {
  return normalizeSelectableModelId(a) === normalizeSelectableModelId(b);
}

async function pruneStaleConfigSections(deps: ModelConfigDeps): Promise<void> {
  if (!deps.configValidity || deps.persistConfig === false || !deps.authProfileId) return;
  const owner = await createRuntimeConfigOwner({ userDataRoot: deps.userDataRoot, configPath: deps.configPath, watch: false });
  try {
    pruneStaleConfig(deps.configValidity, { userDataRoot: deps.userDataRoot, configPath: deps.configPath, authProfileId: deps.authProfileId });
    await owner.refresh();
  } finally {
    await owner.dispose();
  }
}

export async function listEffortOptionsForSlot(
  slot: ModelSelectionSlot,
  model: string | null,
  deps: ModelPickerConfigDeps,
): Promise<EffortOptionRow[]> {
  const auth = await resolveAuth(deps);
  const { availableModels, modelInfos } = await resolveModelCatalogs({ ...deps, auth });
  const options = tierOptions(deps, modelInfos);
  const requestedRoles = selectionRoleIds([slot], deps.agentPersonas);
  if (model === null) requestedRoles.add("workflow-agent");
  const roles = await assignmentRoles(deps, availableModels, options, requestedRoles);
  if (roles.size === 0) return [];
  const selector = parseBriefRoleId(slot.roleId);
  const parentId = parentRoleId(selector?.personaRole ?? slot.roleId);
  const briefParentId = selector && parentId ? briefPersonaRoleId(selector.briefId, parentId) : undefined;
  const inheritedRoleId = briefParentId ?? parentId ?? selector?.personaRole ?? "workflow-agent";
  const inherited = resolveSlotRole(slot, await assignmentRoles(withoutExactAssignment(deps, slot.roleId), availableModels, options, requestedRoles), deps.agentPersonas);
  const effectiveModel = model ?? inherited?.model;
  if (effectiveModel === undefined) throw new Error(`Resolved role missing: ${inheritedRoleId}`);
  const raw = rawConfigForSlot(slot, deps);
  const resolved = resolveSlotRole(slot, roles, deps.agentPersonas);
  const rows: EffortOptionRow[] = [];
  if (isBriefSlot(slot) || parentId) {
    if (!inherited) throw new Error(`Resolved role missing: ${inheritedRoleId}`);
    rows.push({
      slot,
      effort: null,
      // A record seat inherits from whichever seat serves it, which can be its persona.
      label: `Inherit ${slotLabel(roleSlot(selector?.definitionId !== undefined ? inherited.roleId : parentId ?? inheritedRoleId))}: ${inherited.effort}`,
      selectable: true,
      current: !raw.effort,
      inherit: true,
    });
  }
  const selectedRoute = deps.selectedModelRoutes?.get(normalizeSelectableModelId(effectiveModel));
  const efforts = effortOptionsForMetadata(selectedRoute?.reason === undefined ? selectedRoute?.metadata : undefined);
  for (const effort of efforts) rows.push({ slot, effort, label: effort, selectable: true, current: resolved.effort === effort });
  return rows;
}

/** The roles that the selections of `slots` read, as `resolveSlotRole` walks them. */
function selectionRoleIds(slots: readonly ModelSelectionSlot[], personas: ModelConfigDeps["agentPersonas"]): Set<string> {
  const ids = new Set<string>();
  for (const slot of slots) {
    ids.add(canonicalRoleId(slot.roleId));
    const selector = parseBriefRoleId(slot.roleId);
    const parent = parentRoleId(selector?.personaRole ?? slot.roleId);
    if (parent) ids.add(parent);
    if (selector) {
      ids.add("workflow-agent");
      if (selector.personaRole) ids.add(selector.personaRole);
      if (parent) ids.add(briefPersonaRoleId(selector.briefId, parent));
    }
    if (selector?.definitionId !== undefined) {
      ids.add(briefRoleId(selector.briefId));
      for (const role of personas?.get(selector.definitionId)?.roles ?? []) ids.add(role).add(briefPersonaRoleId(selector.briefId, role));
    }
  }
  return ids;
}

function assignmentSettings(deps: ModelConfigDeps) {
  const profile = profileRoleSettings(deps.config.profiles[deps.authProfileId?.() ?? ""]?.roles, deps.roleEnvironment);
  return effectiveRoleAssignments(deps.sessionRoleAssignments ?? { defaults: {}, overrides: {} }, Object.fromEntries(Object.entries(profile).map(([id, role]) => [id, {
    model: role.model, effort: role.effort, providerOptions: role.provider_options,
  }])));
}

function assignmentRoles(deps: ModelConfigDeps, available: ReadonlyMap<ModelFamily, ReadonlySet<string>>, options: TierResolutionOptions, requested: ReadonlySet<string>) {
  const profile = profileRoleSettings(deps.config.profiles[deps.authProfileId?.() ?? ""]?.roles, deps.roleEnvironment);
  return previewSessionRoles(deps.sessionRoleAssignments ?? { defaults: {}, overrides: {} }, profile, available, options, requested);
}

async function effortOptionsForModel(model: string, options: TierResolutionOptions): Promise<readonly ModelSelectionEffort[]> {
  return effortOptionsForMetadata(options.modelInfos?.get(normalizeSelectableModelId(model)));
}

/** Tier resolution reads the account snapshot the caller names. */
function tierOptions(deps: ModelConfigDeps, modelInfos: TierResolutionOptions["modelInfos"] = deps.modelInfos): RoleResolutionOptions {
  return { userDataRoot: deps.userDataRoot, modelInfos, roleEnvironment: deps.roleEnvironment };
}

async function resolveAuth(deps: ModelConfigDeps): Promise<AuthContext> {
  const authDirectory = deps.authDirectory();
  return deps.auth ?? await resolveAuthContext({ authDir: authDirectory, resolveKey: deps.resolveKey, credentialProviderIds: installedCredentialProviderIds(), credentialSlotClassifier: credentialSlotClassifier(deps.moduleSelection()) });
}

async function resolveModelCatalogs(
  deps: ModelConfigDeps & { auth: AuthContext },
): Promise<{
  readonly providerCatalogs: ReadonlyMap<string, ResolvedProviderModels>;
  readonly availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>>;
  readonly modelInfos: TierResolutionOptions["modelInfos"];
}> {
  const injectedCatalogs = deps.providerModelCatalogs?.();
  if (injectedCatalogs !== undefined) {
    return {
      providerCatalogs: injectedCatalogs,
      availableModels: deps.availableModels ?? availableModelsFromCatalogs(injectedCatalogs, deps.modelInfos),
      modelInfos: deps.modelInfos,
    };
  }
  if (deps.availableModels !== undefined) {
    return { providerCatalogs: new Map(), availableModels: deps.availableModels, modelInfos: deps.modelInfos };
  }
  const resolved = await resolveEnabledProviderModelCatalog(deps);
  return { providerCatalogs: resolved.providers, availableModels: availableModelsFromCatalogs(resolved.providers, resolved.modelInfos), modelInfos: resolved.modelInfos };
}

function availableModelsFromCatalogs(
  catalogs: ReadonlyMap<string, ResolvedProviderModels>,
  modelInfos: TierResolutionOptions["modelInfos"],
): ReadonlyMap<ModelFamily, ReadonlySet<string>> {
  const byFamily = new Map<ModelFamily, Set<string>>();
  for (const models of catalogs.values()) {
    for (const model of models.catalog) {
      const family = modelInfos?.get(model)?.family;
      if (!family) continue;
      const familyModels = byFamily.get(family) ?? new Set<string>();
      familyModels.add(model);
      byFamily.set(family, familyModels);
    }
  }
  return byFamily;
}

interface RawSlotConfig {
  readonly model: FlywheelConfig["profiles"][string]["roles"][string]["model"];
  readonly effort: FlywheelConfig["profiles"][string]["roles"][string]["effort"];
}

function rawConfigForSlot(
  slot: ModelSelectionSlot,
  deps: ModelConfigDeps,
): RawSlotConfig {
  const profile = assignmentSettings(deps)[slot.roleId];
  return { model: profile?.model, effort: profile?.effort === undefined ? undefined : coerceEffort(profile.effort) };
}

function familySort(family: ModelFamily | undefined): number {
  if (!family) return 99;
  if (family === "anthropic") return 1;
  if (family === "openai") return 2;
  return 3;
}

type OptionRank = ModelPowerSortRank;
const MODEL_TIER_BY_INDEX: readonly ModelTier[] = ["powerful", "mid", "cheap"];

async function modelOptionRanks(
  rows: readonly FamilyOptionRow[],
  availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>>,
  options: TierResolutionOptions,
  selectedRoutes: ModelPickerConfigDeps["selectedModelRoutes"],
): Promise<ReadonlyMap<string, OptionRank>> {
  const ranks = new Map<string, OptionRank>();
  const routeRequests = new Map<string, { readonly key: string; readonly wireModelId: string; readonly providerHint: string; readonly metadata?: import("../../infra/llm/models.js").ModelInfo }>();
  for (const row of rows) {
    if (!row.family || !row.model) continue;
    const route = optionsForSelectedRoute(row.model);
    if (route) routeRequests.set(route.key, {
      key: route.key,
      wireModelId: route.wireModelId,
      providerHint: route.providerHint,
      ...(route.metadata === undefined ? {} : { metadata: route.metadata }),
    });
  }
  const selectedRouteRanks = await resolveSelectedRouteRanks([...routeRequests.values()], options);
  for (const row of rows) {
    const family = row.family;
    if (!family || !row.model) continue;
    const route = optionsForSelectedRoute(row.model);
    const rank = route
      ? selectedRouteRanks.get(route.key)
      : await modelPowerSortRank(family, row.model, availableModels.get(family), options);
    if (rank) ranks.set(optionKey(row), rank);
  }
  const ordered = [...ranks.entries()].sort(([, a], [, b]) =>
    a.tier - b.tier || b.releaseMs - a.releaseMs
    || (a.cost?.input ?? Number.POSITIVE_INFINITY) - (b.cost?.input ?? Number.POSITIVE_INFINITY),
  );
  const tierIndexes = new Map<number, number>();
  for (const [key, rank] of ordered) {
    const index = tierIndexes.get(rank.tier) ?? 0;
    ranks.set(key, { ...rank, index });
    tierIndexes.set(rank.tier, index + 1);
  }
  return ranks;

  function optionsForSelectedRoute(model: string) {
    const route = selectedRoutes?.get(model);
    if (!route?.wireModelId) return undefined;
    return {
      ...route,
      wireModelId: route.wireModelId,
      key: `${route.providerHint}\0${route.wireModelId}`,
    };
  }
}

function applyModelTiers(rows: readonly FamilyOptionRow[], ranks: ReadonlyMap<string, OptionRank>): void {
  for (const row of rows) {
    const rank = row.family && row.model ? ranks.get(optionKey(row)) : undefined;
    const tier = rank && rank.tier >= 0 ? MODEL_TIER_BY_INDEX[rank.tier] : undefined;
    if (tier) row.tier = tier;
    if (rank?.cost) row.cost = rank.cost;
  }
}

function modelPowerSort(a: FamilyOptionRow, b: FamilyOptionRow, ranks: ReadonlyMap<string, OptionRank>): number {
  const aRank = a.family && a.model ? ranks.get(optionKey(a)) : undefined;
  const bRank = b.family && b.model ? ranks.get(optionKey(b)) : undefined;
  if (!aRank && !bRank) return 0;
  if (!aRank) return 1;
  if (!bRank) return -1;
  return bRank.releaseMs - aRank.releaseMs
    || (aRank.cost?.input ?? Number.POSITIVE_INFINITY) - (bRank.cost?.input ?? Number.POSITIVE_INFINITY)
    || aRank.index - bRank.index;
}

function powerTierSort(row: FamilyOptionRow, ranks: ReadonlyMap<string, OptionRank>): number {
  if (!row.family || !row.model) return 99;
  const tier = ranks.get(optionKey(row))?.tier;
  return tier === undefined || tier < 0 ? 98 : tier;
}

function optionKey(row: Pick<FamilyOptionRow, "family" | "model">): string {
  return `${row.family ?? ""}\0${row.model ?? ""}`;
}

/** A recorded effort as a picker names it; an effort that no picker names reads as medium. */
function coerceEffort(effort: string | undefined): ModelSelectionEffort {
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max" || effort === "ultra") return effort;
  return "medium";
}

function effectiveOptionEffort(
  efforts: readonly ModelSelectionEffort[],
  preferred: string | undefined,
): ModelSelectionEffort {
  return clampReasoningEffort(coerceEffort(preferred), { reasoningEfforts: efforts }, ["low", "medium", "high"]);
}

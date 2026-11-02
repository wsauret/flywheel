import type { ModelConfigDeps } from "./model-assignment-types.js";
import type { ResolvedRoles } from "./roles.js";
import { resolveRoles, resolveRolesForProfile, type RoleResolutionOptions } from "./role-resolution.js";
import type { FlywheelConfig } from "./schema.js";
import type { ModelAssignmentPatch, ModelSelectionSlot } from "../../protocol/model-assignment-protocol-types.js";
import { updateModelAssignments } from "./writer.js";

export async function saveModelAssignment(
  slot: ModelSelectionSlot,
  patch: ModelAssignmentPatch,
  deps: ModelConfigDeps & { readonly authProfileId: () => string },
): Promise<void> {
  updateModelAssignments({
    mutations: [{ slot, patch }],
  }, { userDataRoot: deps.userDataRoot, configPath: deps.configPath, authProfileId: deps.authProfileId });
}

/** What resolving the current roles reads: the config source, the account root
 *  tier resolution derives from, and the listing to check models against. No
 *  credential is read here, so no key resolver is needed. */
type RoleResolutionDeps = Pick<ModelConfigDeps, "userDataRoot" | "config" | "availableModels" | "modelInfos" | "modelsClient"> & { readonly authProfileId?: () => string };
type CurrentRoleResolutionDeps = Omit<RoleResolutionDeps, "config"> & (
  | { readonly config: Pick<FlywheelConfig, "profiles">; readonly profileRoles?: never }
  | { readonly config?: never; readonly profileRoles: FlywheelConfig["profiles"][string]["roles"] }
) & { readonly additionalRoleIds?: Iterable<string> };

export function resolveCurrentRoles(deps: CurrentRoleResolutionDeps): Promise<ResolvedRoles> {
  return deps.config === undefined
    ? resolveRolesForProfile(deps.profileRoles, deps.availableModels, tierOptions(deps), deps.additionalRoleIds)
    : resolveRoles(deps.config, deps.availableModels, tierOptions(deps), deps.authProfileId?.(), deps.additionalRoleIds);
}

/** Tier resolution reads the account snapshot the caller names. */
function tierOptions(deps: Pick<ModelConfigDeps, "userDataRoot" | "modelInfos" | "roleEnvironment">): RoleResolutionOptions {
  return { userDataRoot: deps.userDataRoot, modelInfos: deps.modelInfos, roleEnvironment: deps.roleEnvironment };
}

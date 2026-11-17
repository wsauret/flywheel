import type { ModelConfigDeps } from "./model-assignment-types.js";
import type { ResolvedRoles } from "./roles.js";
import { resolveRoles, resolveRolesForProfile, type RoleResolutionOptions } from "./role-resolution.js";
import type { FlywheelConfig } from "./schema.js";
import type { ModelAssignmentExpected, ModelAssignmentPatch, ModelSelectionSlot } from "../../protocol/model-assignment-protocol-types.js";
import { updateModelAssignments } from "./writer.js";

/** Writes one role of the active profile when its file entry still equals `expected`; otherwise it writes nothing and
 *  throws `ConfigStaleWriteError`. */
export async function saveModelAssignment(
  slot: ModelSelectionSlot,
  patch: ModelAssignmentPatch,
  expected: ModelAssignmentExpected,
  deps: ModelConfigDeps & { readonly authProfileId: () => string },
): Promise<void> {
  updateModelAssignments({
    mutations: [{ slot, patch, expected }],
  }, { userDataRoot: deps.userDataRoot, configPath: deps.configPath, authProfileId: deps.authProfileId });
}

/** What resolving the current roles reads: the config source, the account root
 *  tier resolution derives from, and the listing to check models against. No
 *  credential is read here, so no key resolver is needed. */
type CurrentRoleResolutionDeps = Pick<ModelConfigDeps, "userDataRoot" | "availableModels" | "modelInfos" | "modelsClient"> & { readonly authProfileId?: () => string } & (
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

import { resolveAuthContext } from "../../infra/auth/auth-context.js";
import { installedCredentialProviderIds } from "../credential-provider-modules.js";
import { credentialSlotClassifier } from "../auth/credential-slot-classifier.js";
import type { ModelFamily } from "../../infra/llm/model-family.js";
import { resolveEnabledProviderModelCatalog } from "./model-assignment-providers.js";
import type {
  EffortOptionRow,
  ModelAssignmentPatch,
  ModelAssignmentRow,
  ModelOptionRow,
  ModelSelectionSlot,
} from "../../protocol/model-assignment-protocol-types.js";
import type { ModelConfigDeps, ModelPickerConfigDeps } from "./model-assignment-types.js";
import type { FlywheelConfig } from "./schema.js";
import {
  listEffortOptionsForSlot,
  listModelAssignments,
  listModelOptionsForSlot,
  resetRoleAssignmentsToDetectedDefaults,
  normalizeAssignmentPatch,
  resolveModelAssignment,
} from "./model-assignments.js";
import { saveModelAssignment } from "./model-selection.js";
import { isBriefSlot, slotLabel, type AgentPersonaRoles } from "./role-selection.js";
import { parentRoleId } from "./roles.js";
import type { RoleSettingEntry as RoleAssignmentEntry, RoleSettings, RoleAssignments, RoleAssignmentSnapshot } from "../session/schemas.js";
import { ensureSessionRoleSnapshot, captureRoleAssignments } from "./session-role-resolver.js";
import { fixedSaveRefusal, briefAtAssignmentRow, briefAtEffortOptions, briefAtModelOptions, briefAtSeat } from "./brief-at-seat.js";
import { isProfileModelRole } from "../../protocol/brief-role-id.js";
import { Schema } from "effect";

/** Persistent brief seats are retained for compatibility, not editable defaults. */
export class PerBriefDefaultsRetiredError extends Schema.TaggedError<PerBriefDefaultsRetiredError>()(
  "PerBriefDefaultsRetiredError",
  { message: Schema.String },
) {}

/** The store travels inside the session variant so a session-scoped
 *  controller cannot be constructed without it. */
export type AssignmentScope = { kind: "defaults" } | {
  kind: "session"; sessionId: string; roleCaptureStore: RoleCaptureStore;
} | {
  kind: "workflow-agent"; sessionId: string; roleCaptureStore: RoleCaptureStore;
  inheritedRoles: RoleAssignmentSnapshot;
  /** The persona roles of each agent record of the run, which its record seats read. */
  personas: AgentPersonaRoles;
};

export interface RoleCaptureStore {
  read(id: string): Promise<{ readonly kind?: string; roleAssignments?: RoleAssignmentSnapshot } | null>;
  updateRoleAssignment(id: string, roleId: string, assignment: RoleAssignmentEntry): Promise<boolean>;
  removeRoleAssignment(id: string, roleId: string): Promise<boolean>;
  replaceRoleSnapshot(id: string, roles: RoleSettings, overrides?: RoleSettings): Promise<boolean>;
  captureRolesIfAbsent(id: string, roles: RoleSettings): Promise<boolean>;
}

export interface ModelAssignmentControllerDeps {
  /** Account and config injection every assignment read and write derives
   *  its paths from. */
  configDeps: ModelPickerConfigDeps & { readonly authProfileId: () => string };
  scope?: AssignmentScope;
  afterGlobalConfigWrite?: () => Promise<FlywheelConfig>;
}

interface SaveEffortResult {
  label: string;
}

interface ModelAssignmentController {
  loadAssignments(slots: readonly ModelSelectionSlot[]): Promise<readonly ModelAssignmentRow[]>;
  listModelOptions(slot: ModelSelectionSlot): Promise<readonly ModelOptionRow[]>;
  listEffortOptions(slot: ModelSelectionSlot, model: string | null): Promise<readonly EffortOptionRow[]>;
  saveEffort(slot: ModelSelectionSlot, model: string | null, effort: ModelAssignmentPatch["effort"]): Promise<SaveEffortResult>;
  resetDefaults(slots: readonly ModelSelectionSlot[]): Promise<readonly ModelAssignmentRow[]>;
}

export function createModelAssignmentController(
  deps: ModelAssignmentControllerDeps,
): ModelAssignmentController {
  const scope = deps.scope ?? { kind: "defaults" };
  if (scope.kind === "defaults") return createDefaultsController(deps);
  return createSessionController(scope.sessionId, scope.roleCaptureStore, deps, scope.kind === "workflow-agent" ? scope : undefined);
}

export function loadGlobalDefaultRoles(configDeps: ModelConfigDeps): Promise<RoleAssignments> {
  return materializeDefaultRoleSnapshot(configDeps);
}

function createDefaultsController(deps: ModelAssignmentControllerDeps): ModelAssignmentController {
  const { configDeps } = deps;

  // The defaults hold no run, so the record seat of an agent is its brief
  // seat.
  const seatOf = (slot: ModelSelectionSlot) => briefAtSeat(slot)?.brief ?? slot;

  async function loadAssignments(slots: readonly ModelSelectionSlot[]): Promise<readonly ModelAssignmentRow[]> {
    const rows = await listModelAssignments({ ...configDeps, slots: slots.map(seatOf) });
    return rows.map((row, index) => ({ ...row, slot: slots[index] ?? row.slot }));
  }

  return {
    loadAssignments,
    async listModelOptions(slot) {
      return (await listModelOptionsForSlot(seatOf(slot), configDeps)).map((row) => ({ ...row, slot }));
    },
    async listEffortOptions(slot, model) {
      return (await listEffortOptionsForSlot(seatOf(slot), model, configDeps)).map((row) => ({ ...row, slot }));
    },
    async saveEffort(requested, model, effort) {
      if (requested.roleId.startsWith("brief.")) {
        throw new PerBriefDefaultsRetiredError({
          message: "Per-brief defaults are retired. Set the Workflow Agent default, or set this agent's model in its workflow session.",
        });
      }
      const slot = seatOf(requested);
      await saveModelAssignment(slot, normalizeAssignmentPatch({ model, effort }), configDeps);
      await deps.afterGlobalConfigWrite?.();
      return { label: slotLabel(slot) };
    },
    async resetDefaults(slots) {
      await resetRoleAssignmentsToDetectedDefaults(configDeps);
      const config = await deps.afterGlobalConfigWrite?.() ?? configDeps.config;
      return listModelAssignments({ ...configDeps, config, slots });
    },
  };
}

function createSessionController(
  sessionId: string,
  roleCaptureStore: RoleCaptureStore,
  deps: ModelAssignmentControllerDeps,
  run?: Pick<Extract<AssignmentScope, { kind: "workflow-agent" }>, "inheritedRoles" | "personas">,
): ModelAssignmentController {
  const { configDeps } = deps;
  const inheritedRoles = run?.inheritedRoles;
  // One auth snapshot for this controller's life, resolved on first use: every
  // list and save below answers from the same credentials, and a credential
  // helper runs at most once for them.
  const authDirectory = configDeps.authDirectory();
  const auth = configDeps.auth
    ? Promise.resolve(configDeps.auth)
    : resolveAuthContext({ authDir: authDirectory, resolveKey: configDeps.resolveKey, credentialProviderIds: installedCredentialProviderIds(), credentialSlotClassifier: credentialSlotClassifier(configDeps.moduleSelection()) });
  const readSnapshot = async (): Promise<RoleAssignmentSnapshot> => {
    const transient = await ensureSessionRoleSnapshot({
      manager: roleCaptureStore,
      sessionId,
    });
    const snapshot = (await roleCaptureStore.read(sessionId))?.roleAssignments ?? { defaults: {}, overrides: transient };
    return inheritedRoles ? {
      defaults: inheritedRoles.defaults,
      overrides: { ...inheritedRoles.overrides, ...snapshot.overrides },
    } : snapshot;
  };

  async function snapshotConfigDeps(
    roleAssignments: RoleAssignmentSnapshot,
    slots?: readonly ModelSelectionSlot[],
  ): Promise<ModelPickerConfigDeps> {
    return {
      ...configDeps,
      ...(slots ? { slots } : {}),
      auth: await auth,
      sessionRoleAssignments: roleAssignments,
      ...(run === undefined ? {} : { agentPersonas: run.personas }),
      persistConfig: false,
    };
  }

  async function loadAssignments(slots: readonly ModelSelectionSlot[]): Promise<readonly ModelAssignmentRow[]> {
    const snapshot = await readSnapshot();
    const seats = slots.map((slot) => briefAtSeat(slot, snapshot));
    const rows = await listModelAssignments(await snapshotConfigDeps(snapshot, slots));
    return rows.map((row, index) => {
      const seat = seats[index];
      const slot = slots[index];
      return seat === undefined || slot === undefined ? row : briefAtAssignmentRow(row, slot, seat);
    });
  }

  async function effectiveSeat(slot: ModelSelectionSlot, snapshot: RoleAssignmentSnapshot, model: string | null) {
    const seat = briefAtSeat(slot, snapshot);
    if (seat?.fixed === undefined) return seat;
    const preview = seat.fixed.fields === "effort" && model != null
      ? { ...snapshot, overrides: { ...snapshot.overrides, [slot.roleId]: { ...snapshot.overrides[slot.roleId], model } } }
      : snapshot;
    const [pair] = await listModelAssignments(await snapshotConfigDeps(preview, [slot]));
    return { ...seat, fixed: { ...seat.fixed, pair: pair ?? seat.fixed.pair } };
  }

  return {
    loadAssignments,
    async listModelOptions(slot) {
      const snapshot = await readSnapshot();
      const seat = briefAtSeat(slot, snapshot);
      const rows = await listModelOptionsForSlot(slot, await snapshotConfigDeps(snapshot));
      return seat === undefined ? rows : briefAtModelOptions(rows, slot, seat);
    },
    async listEffortOptions(slot, model) {
      const snapshot = await readSnapshot();
      const seat = await effectiveSeat(slot, snapshot, model);
      const rows = await listEffortOptionsForSlot(slot, model, await snapshotConfigDeps(snapshot));
      return seat === undefined ? rows : briefAtEffortOptions(rows, slot, seat, model);
    },
    async saveEffort(requested, model, effort) {
      const snapshot = await readSnapshot();
      const seat = await effectiveSeat(requested, snapshot, model);
      // A person's change of an agent record whose file fixed a field is an
      // override of its fixed seat, which reaches only the other field.
      const fixed = seat?.fixed;
      const refusal = fixed === undefined ? undefined : fixedSaveRefusal(fixed, model, effort);
      if (refusal !== undefined) throw new Error(refusal);
      if (isProfileModelRole(requested.roleId) && !inheritedRoles) {
        await saveModelAssignment(requested, normalizeAssignmentPatch({ model, effort }), configDeps);
        await deps.afterGlobalConfigWrite?.();
        return { label: slotLabel(requested) };
      }
      const slot = requested;
      if (model === null) {
        if (inheritedRoles || isBriefSlot(slot) || parentRoleId(slot.roleId)) {
          await roleCaptureStore.removeRoleAssignment(sessionId, slot.roleId);
          return { label: slotLabel(slot) };
        }
        throw new Error("This role cannot inherit a model assignment");
      }
      if (effort == null) throw new Error("Effort is required for session role assignment");
      // Effort-only change (same model): keep the existing provider request
      // options; the user configured them for this model, and an effort edit
      // is not a request to drop them. A model change starts clean.
      const saved = snapshot.overrides[slot.roleId] ?? snapshot.defaults[slot.roleId];
      const existing = saved?.model === model ? saved : await resolveModelAssignment(slot, await snapshotConfigDeps(snapshot));
      const carried = existing?.model === model && existing.providerOptions
        ? { providerOptions: existing.providerOptions }
        : {};
      await roleCaptureStore.updateRoleAssignment(
        sessionId,
        slot.roleId,
        {
          ...(fixed?.fields === "both" || fixed?.fields === "model" ? {} : { model }),
          ...(fixed?.fields === "both" || fixed?.fields === "effort" ? {} : { effort }),
          ...carried,
        },
      );
      return { label: slotLabel(slot) };
    },
    async resetDefaults(slots) {
      await roleCaptureStore.replaceRoleSnapshot(sessionId, {}, {});
      return loadAssignments(slots);
    },
  };
}

/** A boundary with no published eligibility projection (a one-shot run) lists
 *  the enabled catalog itself, which reads the profile's credentials; the
 *  runtime supplies `availableModels` from the eligibility it already holds. */
async function listEnabledModels(configDeps: ModelConfigDeps): Promise<ReadonlyMap<ModelFamily, ReadonlySet<string>>> {
  const auth = configDeps.auth ?? await resolveAuthContext({ authDir: configDeps.authDirectory(), resolveKey: configDeps.resolveKey, credentialProviderIds: installedCredentialProviderIds(), credentialSlotClassifier: credentialSlotClassifier(configDeps.moduleSelection()) });
  return (await resolveEnabledProviderModelCatalog({ ...configDeps, auth })).enabledModels;
}

async function materializeDefaultRoleSnapshot(configDeps: ModelConfigDeps): Promise<RoleAssignments> {
  return captureRoleAssignments({
    userDataRoot: configDeps.userDataRoot,
    config: configDeps.config,
    availableModels: configDeps.availableModels ?? await listEnabledModels(configDeps),
    modelInfos: configDeps.modelInfos,
    activeProfileId: configDeps.authProfileId?.(),
    personaRoleIds: configDeps.configValidity?.roleIds,
  });
}

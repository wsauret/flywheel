/** One process's live projection of the global optional-capability selection,
 *  and the admission boundary every new optional operation passes (ARCH-RUNTIME-066).
 *
 *  The config file is the durable authority. This policy is a live read of it,
 *  never a second store: `admit` observes the published file at use time and
 *  re-normalizes one complete descriptor from it, so an admission is ordered
 *  before or after every write rather than deciding from a stale snapshot.
 *  The file is read under the ownership lock Flywheel settings writers take,
 *  unless it is still the file the last such read observed. That observation
 *  is the linearization point.
 *
 *  A grant is execution context, not durable state. It authorizes the one
 *  bounded operation it names, including that operation's own later tool calls
 *  and settlement after a later disable. A sibling dispatch, a later resume, a
 *  later automatic review, or an unrelated write asks for a new grant. */

import { Log } from "../../infra/log.js";
import { selectionPolicyError, type ModuleId } from "../modules.js";
import { readConfigAt, type ConfigFileLocation } from "./config-file.js";
import { defaultModuleState, moduleDescriptor, observeModuleState, type ModuleState } from "./module-descriptor.js";
import type { ConfigWriteResult } from "./writer.js";
import { migrateCapabilityModules, updateCapabilityModules } from "./module-selection-writer.js";
import { createRuntimeConfigOwner, type RuntimeConfigOwner } from "./runtime-config-owner.js";
import { canonicalModuleIds, missingModuleIds, moduleDisabledReason } from "../../protocol/module-ids.js";

/** What one admitted operation may do, fixed at its admission.
 *
 *  The descriptor fields are evidence: they record the configuration that
 *  satisfied the admission. `required` is the authority: a grant authorizes its
 *  own bounded requirement set and this operation's continuation, never every
 *  capability that happened to be selected when it was minted. */
export interface CapabilityGrant extends ModuleState {
  /** The bounded root operation this grant authorizes. */
  readonly operation: string;
  /** Exactly what was required to admit it. */
  readonly required: readonly ModuleId[];
}

export type CapabilityAdmission =
  | { readonly ok: true; readonly grant: CapabilityGrant }
  | { readonly ok: false; readonly missing: readonly ModuleId[]; readonly reason: string };

export interface CapabilityRequest {
  /** The bounded operation being started, named as the user would recognize it. */
  readonly operation: string;
  readonly required: readonly ModuleId[];
}

export interface ModulePolicy {
  /** The live projection. Rosters and prompts read this; admission does not. */
  state(): ModuleState;
  enabled(capability: ModuleId): boolean;
  /** Observe current configuration, refresh the projection, and mint the
   *  grant for this operation from that observation. */
  admit(request: CapabilityRequest): Promise<CapabilityAdmission>;
  /** Replace the complete selection. The projection changes only after the
   *  config write commits. */
  select(capabilities: readonly ModuleId[]): Promise<ConfigWriteResult>;
  /** Migrate retired IDs, then re-read and publish the committed descriptor. */
  refresh(): Promise<void>;
  onChange(listener: (state: ModuleState) => void): () => void;
}

export interface DisposableModulePolicy extends ModulePolicy {
  /** Release resources allocated by this policy wrapper. Injected owners remain caller-owned. */
  dispose(): Promise<void>;
}

/** How one run's selection differs from the account's. A headless run, such as
 *  a benchmark arm, composes without some of the account's selection, and
 *  leaves the file as its owner set it. */
export interface RunModuleSelection {
  /** Selected modules the run leaves out: no tool, prompt, service, or provider of theirs exists in it. */
  readonly excluded?: readonly ModuleId[];
}

export interface ModulePolicyStartup {
  readonly policy: ModulePolicy;
  /** One visible sentence the obsolete-setting migration produced, if any. */
  readonly notice?: string;
  /** Release resources allocated while starting this policy. */
  dispose(): Promise<void>;
  /** Why the migration could not be written. The file remains unchanged, and
   *  the live policy keeps its fallback selection until repair. */
  readonly migrationError?: string;
}

/** Prepare one root's capability policy.
 *
 *  Every mutating or work-admitting root calls this before it admits anything:
 *  retired capability authorities become canonical selection
 *  first, so no root depends on the CLI having run, and the projection returned
 *  reads the migrated file. Read-only inspection constructs no policy.
 *
 *  Invalid selection bytes remain untouched. The live policy reports them,
 *  starts on defaults, and follows the file once the selection is repaired. */
export async function startModulePolicy(location: ConfigFileLocation, owner?: RuntimeConfigOwner, run?: RunModuleSelection): Promise<ModulePolicyStartup> {
  const migration = await migrateCapabilityModules(location);
  const migrationError = !migration.write.ok && observeModuleState(readConfigAt(location)) !== undefined
    ? migration.write.error.message
    : undefined;
  const policy = await createModulePolicy(location, owner, run);
  return {
    policy,
    dispose: () => policy.dispose(),
    ...(migrationError === undefined ? {} : { migrationError }),
    ...(migration.notice === undefined ? {} : { notice: migration.notice }),
  };
}

/** `run` adjusts the selection this policy publishes, so its state, its
 *  admissions, and its grants all read the one selection the run composes. */
export async function createModulePolicy(location: ConfigFileLocation, injectedOwner?: RuntimeConfigOwner, run?: RunModuleSelection): Promise<DisposableModulePolicy> {
  const owner = injectedOwner ?? await createRuntimeConfigOwner({ ...location, watch: false });
  let disposed = false;
  let lastValidState = defaultModuleState();
  let state = runSelection(lastValidState, run);
  // Until one read states a valid selection, the selection in force is the
  // default one, not anything the file said.
  let observedValid = false;
  let reportedError: string | undefined;
  const listeners = new Set<(state: ModuleState) => void>();
  const log = Log.create({ service: "module-policy" });

  // An invalid selection keeps the last valid one and carries its error so the
  // person learns what to fix. A read that states no selection at all changes
  // nothing, so a document the process cannot read starts on the defaults.
  const publish = (observed: ModuleState | undefined): void => {
    if (observed === undefined) return;
    const next = runSelection(observed.error === undefined
      ? observed
      : moduleDescriptor(
          lastValidState.capabilities,
          lastValidState.moduleIds,
          lastValidState.requireWorkflowConfirmation,
          `${observed.error}. ${observedValid ? "Flywheel keeps the last valid module selection until you fix it." : "Flywheel uses the default modules until you fix it."}`,
          observed.identity,
        ), run);
    if (observed.error === undefined) {
      lastValidState = observed;
      observedValid = true;
    }
    if (next.error !== reportedError) {
      reportedError = next.error;
      if (next.error !== undefined) log.warn("module-selection-invalid", { code: "module-selection-invalid" });
    }
    if (sameState(state, next)) return;
    state = next;
    for (const listener of listeners) listener(state);
  };
  const reread = (): void => { publish(observeModuleState(readConfigAt(location))); };
  reread();
  const observeSelection = owner.useTimeObserver(observeModuleState);

  return {
    state: () => state,
    enabled: (capability) => state.capabilities.includes(capability),
    admit: async (request) => {
      if (disposed) throw new Error("Module policy is disposed");
      publish(await observeSelection());
      const missing = missingModuleIds(request.required, state.capabilities);
      if (missing.length > 0) {
        return { ok: false, missing, reason: refusal(request.operation, missing, state.error) };
      }
      return { ok: true, grant: mintGrant(request, state) };
    },
    select: async (capabilities) => {
      const result = await updateCapabilityModules(capabilities, location);
      // The file the write committed is the authority the projection publishes;
      // synthesizing the new descriptor here would be a second decoding of it.
      if (result.ok) reread();
      return result;
    },
    refresh: async () => {
      await migrateCapabilityModules(location);
      reread();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (injectedOwner === undefined) await owner.dispose();
    },
  };
}


/** The account's selection as one run composes it. The identity stays the
 *  file's: the adjustment is fixed for the policy's life, so the identity
 *  still changes exactly when the file's selection does. Throws when a
 *  module's selection policy refuses the adjusted selection, as decoding the
 *  file refuses one that states it: the run's caller chose the adjustment,
 *  so the run fails at its start and grants nothing the file could not. */
function runSelection(state: ModuleState, run: RunModuleSelection | undefined): ModuleState {
  if (run === undefined) return state;
  const excluded = new Set<string>(run.excluded);
  const moduleIds = state.moduleIds.filter((id) => !excluded.has(id));
  const conflict = selectionPolicyError(moduleIds, { requireWorkflowConfirmation: state.requireWorkflowConfirmation });
  if (conflict !== undefined) throw new Error(`The run's module selection is invalid: ${conflict}`);
  return moduleDescriptor(moduleIds, moduleIds, state.requireWorkflowConfirmation, state.error, state.identity);
}

function mintGrant(request: CapabilityRequest, state: ModuleState): CapabilityGrant {
  return Object.freeze({
    capabilities: state.capabilities,
    moduleIds: state.moduleIds,
    requireWorkflowConfirmation: state.requireWorkflowConfirmation,
    workflowsMode: state.workflowsMode,
    identity: state.identity,
    ...(state.error === undefined ? {} : { error: state.error }),
    operation: request.operation,
    required: Object.freeze(canonicalModuleIds(request.required)),
  });
}

function refusal(operation: string, missing: readonly ModuleId[], error: string | undefined): string {
  const reason = `${operation} is unavailable: ${moduleDisabledReason(missing)}`;
  return error === undefined ? reason : `${reason}. ${error}`;
}

function sameState(current: ModuleState, next: ModuleState): boolean {
  return current.identity === next.identity;
}

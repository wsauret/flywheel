/** Admission of one workflow launch or resume (ARCH-RUNTIME-066, ARCH-WORKFLOWS-013).
 *
 *  Two roots start workflows - the workflow controller a session owner drives
 *  and a headless run - and both must decide admission the same way, so the
 *  decision, its wording, and the values an admitted operation carries live
 *  here rather than once per root.
 *
 *  Admission is atomic: the definition the operation runs is resolved from
 *  the captured revision, its complete transitive requirements are admitted
 *  in one request, and the availability the operation holds is derived from
 *  the grant that admission minted. An admitted operation settles on that
 *  grant and on the definition object admission resolved, so a capability
 *  disabled after it started never refuses its workers mid-run, and nothing
 *  below it reads the live projection or looks the definition up again. */

import type { DefinitionAvailabilityOwner, DefinitionAvailabilitySnapshot } from "../app-service/definition-availability.js"
import { capabilityAccessFor, type CapabilityAccess } from "../agent-runtime/tools/types.js"
import type { CapabilityGrant, ModulePolicy } from "../config/module-policy.js"
import type { ProjectDefinitionRegistryRevision } from "../../workflows/definition-registry.js"
import type { WorkflowDefinition } from "../../workflows/workflow-schema.js"
import { missingModuleIds, moduleDisabledReason } from "../../protocol/module-ids.js"
import type { WorkflowFileDiagnostic } from "../../workflows/workflow-file.js"

/** What resolving one operation's definition found: at least the
 *  definition object. A path launch adds what its file pipeline found. */
export interface ResolvedWorkflowDefinition {
  readonly workflow: WorkflowDefinition
}

/** Why no definition can run: the reason, the located problems of a
 *  workflow file when the reason is that file, and what the author of a
 *  workflow file does next. */
export interface WorkflowDefinitionRefusal {
  readonly ok: false
  readonly reason: string
  readonly diagnostics?: readonly WorkflowFileDiagnostic[]
  readonly recovery?: string
}

/** The definition one operation runs, or why none can run. */
export type WorkflowDefinitionResolution<R extends ResolvedWorkflowDefinition = ResolvedWorkflowDefinition> =
  | ({ readonly ok: true } & R)
  | WorkflowDefinitionRefusal

/** Resolves the definition of one operation against the revision that
 *  admission captured (see `definition-source.ts`). */
export type WorkflowDefinitionResolver<R extends ResolvedWorkflowDefinition = ResolvedWorkflowDefinition> =
  (revision: ProjectDefinitionRegistryRevision) => WorkflowDefinitionResolution<R> | Promise<WorkflowDefinitionResolution<R>>

/** An admitted operation carries the definition object admission resolved.
 *  Every layer below admission receives that object and never looks a
 *  definition up by id. */
export type WorkflowAdmission<R extends ResolvedWorkflowDefinition = ResolvedWorkflowDefinition> =
  | ({
    readonly ok: true
    readonly grant: CapabilityGrant
    readonly availability: DefinitionAvailabilitySnapshot
  } & R)
  | WorkflowDefinitionRefusal

export interface WorkflowAdmissionInput<R extends ResolvedWorkflowDefinition = ResolvedWorkflowDefinition> {
  readonly capabilities: Pick<ModulePolicy, "admit">
  readonly availability: Pick<DefinitionAvailabilityOwner, "capture">
  /** The operation a refusal names, as the user would recognize it, for example
   *  `the triage workflow` or `resuming the triage workflow`. */
  readonly operation: string
  readonly resolve: WorkflowDefinitionResolver<R>
}

/** Admit one workflow operation, or report why it may not proceed. Every caller
 *  runs this before dependency preparation, publication, and lifecycle
 *  mutation, so a refusal leaves nothing behind. */
export async function admitWorkflowOperation<R extends ResolvedWorkflowDefinition>(input: WorkflowAdmissionInput<R>): Promise<WorkflowAdmission<R>> {
  const captured = input.availability.capture()
  const resolved = await input.resolve(captured.snapshot.definitionRevision)
  if (!resolved.ok) return { ...resolved, reason: `${input.operation} is unavailable: ${resolved.reason}` }
  const { workflow } = resolved
  // The whole closure in one request: a worker of this definition continues on
  // this grant, so anything the definition transitively needs must be
  // authorized by it rather than re-admitted mid-run.
  const required = captured.workflowRequirements(workflow)
  const admission = await input.capabilities.admit({ operation: input.operation, required })
  if (!admission.ok) return { ok: false, reason: admission.reason }
  const availability = captured.underGrant(admission.grant)
  const missing = missingModuleIds(required, availability.capabilities)
  if (missing.length > 0) return { ok: false, reason: `${input.operation} is unavailable: ${moduleDisabledReason(missing)}` }
  return { ...resolved, grant: admission.grant, availability }
}

/** The capability boundary every runner of one admitted workflow passes: this
 *  operation's own grant, plus the policy a call that needs a capability the
 *  grant does not cover admits against. */
export function workflowCapabilityAccess(
  capabilities: Pick<ModulePolicy, "admit" | "state">,
  grant: CapabilityGrant,
): CapabilityAccess {
  return capabilityAccessFor(capabilities, grant)
}

/** The recorded definition each workflow operation runs (ARCH-WORKFLOWS-013).
 *  A workflow file that a chat agent launched by path comes from that file at
 *  launch, and from the `definition.loaded` record of its run after that:
 *  the run never reads the file again, so a resume works after the file is
 *  deleted or edited. Admission resolves the definition once and every layer
 *  below it receives the object. */

import type { AsyncEventReadSurface } from "../../infra/event-store-types.js"
import { readRunDefinitionLineage } from "../../workflows/definition-provenance-projection.js"
import { recordedWorkflow } from "../../workflows/loader.js"
import { errorMessage } from "../../infra/error-message.js"
import type { WorkflowDefinitionResolution, WorkflowDefinitionResolver } from "./workflow-admission.js"

/** The definition an existing run executes. A run that a workflow file
 *  started rebuilds its definition from the record its launch committed: the
 *  inline briefs and contracts are in the record. A record in the retired step grammar converts as
 *  the loader converts the file (refer to `recordedWorkflow`). Any other run
 *  refuses execution but keeps its history viewable. */
export function runDefinition(input: {
  readonly reader: AsyncEventReadSurface
  readonly sessionId: string
  readonly workflowDefinitionId: string
}): WorkflowDefinitionResolver {
  return async (): Promise<WorkflowDefinitionResolution> => {
    const recorded = (await readRunDefinitionLineage(input.reader, input.sessionId)).definitions[`workflow:${input.workflowDefinitionId}`]
    // Past named runs retain their history, not launch authority. Remove after 2027-04-30.
    if (recorded?.provenance?.layer !== "session") return { ok: false, reason: `the ${input.workflowDefinitionId} workflow is retired and no longer runs; its history stays viewable` }
    const retired = "retiredStepGrammar" in recorded ? recorded.retiredStepGrammar : undefined
    try {
      return { ok: true, workflow: recordedWorkflow(recorded.definition, retired, recorded.provenance) }
    } catch (error) {
      return { ok: false, reason: `the recorded definition of workflow ${input.workflowDefinitionId} cannot be read: ${errorMessage(error)}` }
    }
  }
}

/** Workflow control as the last build before phases compiled it, and the
 *  control history that the legacy fixtures drove on it. The identity passes
 *  meet only rows that such a build wrote, so their fixtures stage these rows
 *  and compute only the recorded identity from the current definitions. The
 *  base build (301e51b8b) froze the rows in `golden/pre-phase-controls.json`:
 *  the compile of each shipped workflow and of the `dual-bind` project file,
 *  and two driven histories. Remove after 2027-04-30, together with the
 *  passes that these fixtures serve. */

import { Schema } from "effect"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { WorkflowControlV10Schema } from "../../../../src/workflows/vm/historical-codecs.js"
import { normalizeWorkflowControlV10 } from "../../../../src/workflows/vm/historical-normalization.js"
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js"
import type { DefinitionIdentity } from "../../../../src/workflows/vm/definition-identity.js"
import frozen from "./golden/pre-phase-controls.json"

/** Control in the shape the last build before phases recorded. */
export type PrePhaseControl = typeof WorkflowControlV10Schema.Type

/** One fact of a frozen control history, as that build stored it. */
export interface PrePhaseFact {
  readonly type: string
  readonly version: number
  readonly payload: EventPayload
}

/** A driven control history: the facts after the root, and the control
 *  that the facts commit. */
export interface PrePhaseHistory {
  readonly facts: readonly PrePhaseFact[]
  readonly final: PrePhaseControl
}

const decodeControl = Schema.decodeUnknownSync(WorkflowControlV10Schema, { onExcessProperty: "error" })

/** The control that the last build before phases compiled for `workflowId`,
 *  under `definitionIdentity`. Throws for a workflow that the frozen rows do
 *  not hold. */
export function prePhaseControl(workflowId: string, definitionIdentity: DefinitionIdentity): PrePhaseControl {
  const control = Object.entries(frozen.controls).find(([id]) => id === workflowId)?.[1]
  if (control === undefined) throw new Error(`The frozen pre-phase controls hold no workflow ${workflowId}`)
  return decodeControl({ ...control, definitionIdentity })
}

/** The frozen history `name`, whose final control takes
 *  `definitionIdentity`: `catalog`, which the skill-catalog fixture drove on
 *  the implement control with legacy ids and an authored follow-up, or
 *  `rename`, which the pre-rename fixture drove on the retired implement
 *  control with an authored follow-up. */
export function prePhaseHistory(name: keyof typeof frozen.histories, definitionIdentity: DefinitionIdentity): PrePhaseHistory {
  const { facts, final } = frozen.histories[name]
  return { facts, final: decodeControl({ ...final, definitionIdentity }) }
}

const decodeRecorded = Schema.decodeUnknownSync(WorkflowControlV10Schema)

/** The control of a staged initialized row in the current shape, under
 *  `definitionIdentity` in place of the recorded identity, which a pass may
 *  not have normalized yet. A test compares the attempts and the frontier of
 *  a staged run with those of its resume through it. */
export function stagedControl(recorded: PrePhaseControl, definitionIdentity: DefinitionIdentity): CommittedWorkflowControl {
  return normalizeWorkflowControlV10(decodeRecorded({ ...recorded, definitionIdentity }))
}

/** The initialized root of `control` at version 10, as the last build
 *  before phases built it: the root counts itself in `aggregateSeq`. */
export function prePhaseRoot(control: PrePhaseControl): PrePhaseFact & { readonly payload: { readonly control: PrePhaseControl } } {
  return { type: "workflow.control.initialized", version: 10, payload: { control: { ...control, aggregateSeq: control.aggregateSeq + 1 } } }
}

/** The pre-cutover view of a current workflow definition.
 *
 *  The identity chain passes that run before the step-content migration
 *  compare and adopt identities in the shape the last pre-cutover build
 *  recorded: bindings, a handoff registry, and skills that include the skill
 *  each binding named. The step-content migration then converts the adopted
 *  identity, so every admitted run crosses the cutover through one proof.
 *  This module rebuilds that shape from the step-grammar view of a current
 *  definition (refer to `retiredStepView`).
 *
 *  The binding each step replaced comes from the provenance the loader kept
 *  when it converted a saved file, or else from the frozen table of the
 *  shipped workflows. A definition with a step that neither source covers has
 *  no pre-cutover view: no pre-cutover build recorded it, so a run that names
 *  it reports ordinary drift.
 *
 *  Remove after 2027-04-30. */

import { hashContent, hashDefinition } from "../../../../workflows/definition-hash.js"
import { retiredBindingOf, retiredBindingSha256, type RetiredBinding } from "../../../../workflows/retired-bindings.js"
import { renderSkillContext } from "../../../../workflows/skill-render.js"
import type { SkillRegistryRevision } from "../../../../workflows/skill-schema.js"
import type { LegacyDefinitionIdentity, StepDefinitionIdentity } from "../../../../workflows/vm/definition-identity.js"
import type { StepGrammarWorkflow } from "../../../../workflows/retired-step-grammar/schema.js"
import { LEGACY_WORKFLOW_BINDINGS, type LegacyBindingPin } from "./workflow-definition-identity-step-content-pins.js"

/** What the pre-cutover build of one current definition recorded. */
export interface LegacyCapture {
  /** The binding each step replaced, keyed by step id. */
  readonly bindings: ReadonlyMap<string, RetiredBinding>
  /** The graph hash with every `reassess: X` slot written as `then: X`, the
   *  form a pre-cutover file stated. */
  readonly graphSha256: string
}

function frozenBindings(workflowId: string): ReadonlyMap<string, LegacyBindingPin> {
  const pins: readonly LegacyBindingPin[] = Object.entries(LEGACY_WORKFLOW_BINDINGS).find(([id]) => id === workflowId)?.[1] ?? []
  return new Map(pins.map((pin) => [pin.bindingId, pin]))
}

/** The pre-cutover view of one step-grammar definition, or undefined when
 *  one of its steps replaced no binding that a pre-cutover build could have
 *  recorded. */
export function legacyCaptureOf(workflow: StepGrammarWorkflow): LegacyCapture | undefined {
  const frozen = frozenBindings(workflow.id)
  const bindings = new Map<string, RetiredBinding>()
  for (const [stepId, step] of Object.entries(workflow.steps)) {
    const kept = workflow.retiredBindings?.get(stepId)
    const pin = frozen.get(stepId)
    const binding = kept ?? (pin ? retiredBindingOf(step, pin.skillId, pin.handoff, pin.toolScoping) : undefined)
    if (binding === undefined) return undefined
    bindings.set(stepId, binding)
  }
  // A pre-cutover build knew only a flat flow, so a top-level entry is the
  // only place a reassess slot can sit in a definition it recorded.
  const flow = workflow.flow.map((node) => {
    if (!("for" in node) || node.reassess === undefined) return node
    const { reassess, ...rest } = node
    return { ...rest, then: reassess }
  })
  return { bindings, graphSha256: hashDefinition(flow).sha256 }
}

/** The identity the pre-cutover build would record for a current
 *  definition. Two members are not recomputable and come from the recorded
 *  identity instead: the contract hashes of each handoff type, because the
 *  registry is gone, and the hash of each skill a binding named that is no
 *  longer installed, because its package left the catalog. `renameSkill`
 *  maps a recorded skill id and `renameHandoff` a recorded handoff type to
 *  the current name, for a pass that also renames ids. */
export function legacyIdentityOf(
  current: StepDefinitionIdentity,
  capture: LegacyCapture,
  recorded: LegacyDefinitionIdentity,
  skills: SkillRegistryRevision,
  rename: { readonly skill?: (id: string) => string; readonly handoff?: (name: string) => string } = {},
): LegacyDefinitionIdentity {
  const renameSkill = rename.skill ?? ((id: string) => id)
  const renameHandoff = rename.handoff ?? ((name: string) => name)
  const recordedRegistry = new Map(recorded.handoffRegistry.map((entry) => [renameHandoff(entry.name), entry]))
  const recordedSkills = new Map(recorded.skills.map(({ skillId, sha256 }) => [renameSkill(skillId), sha256]))
  const handoffNames = [...new Set([...capture.bindings.values()].flatMap(({ handoff }) => handoff === undefined ? [] : [handoff]))].sort()
  const composed = new Map(current.skills.map(({ skillId, sha256 }) => [skillId, sha256]))
  for (const { skill } of capture.bindings.values()) {
    if (composed.has(skill)) continue
    const installed = skills.skills.get(skill)
    composed.set(skill, installed ? hashContent(renderSkillContext(installed)).sha256 : recordedSkills.get(skill) ?? null)
  }
  return {
    workflowDefinitionId: current.workflowDefinitionId,
    graphSha256: capture.graphSha256,
    vmVersion: current.vmVersion,
    bindings: [...capture.bindings].sort(([left], [right]) => left.localeCompare(right))
      .map(([bindingId, binding]) => ({ bindingId, sha256: retiredBindingSha256(bindingId, binding) })),
    handoffRegistry: handoffNames.map((name) => {
      const entry = recordedRegistry.get(name)
      return entry
        ? { ...entry, name }
        : { name, contractRevision: null, fieldsSha256: null, rulesSha256: null, artifactPathFieldsSha256: null }
    }),
    skills: [...composed].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([skillId, sha256]) => ({ skillId, sha256 })),
    personas: current.personas,
  }
}

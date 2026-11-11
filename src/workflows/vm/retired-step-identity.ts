/** The definition identity of the step grammar, frozen as the last build
 *  before phases computed it, and the proof that adopts the phase-grammar
 *  identity for a run paused before phases.
 *
 *  A paused run recorded the identity of its definition in the step grammar.
 *  Its definition now reads in the phase grammar, so Resume first proves the
 *  recorded identity against the pre-phase view of that definition (refer to
 *  {@link retiredStepView}): the frozen builder here computes the identity
 *  that the last step-grammar build would compute for the view, with each
 *  step's brief from the current agent of the same record key. When the
 *  proven identity equals that frozen identity, or differs only in edited
 *  briefs and skills, the run adopts the phase-grammar identity, so an
 *  edited graph still drifts.
 *
 *  Remove after 2027-04-30. */
import { Array as Arr, Schema } from "effect";
import type { ResolvedAgent } from "../agent-resolution.js";
import { workflowInputContract } from "../brief.js";
import { hashDefinition } from "../definition-hash.js";
import { canonicalStepPolicy, canonicalStepWorkflowRecord } from "../retired-step-grammar/records.js";
import { walkFlow, type StepGrammarWorkflow, type WorkflowFlowEntry } from "../retired-step-grammar/schema.js";
import { CanonicalToolScopingSchema, type ToolScoping } from "../../infra/workflow-types.js";
import type { WorkflowDefinition } from "../workflow-schema.js";
import {
  briefContentSha256,
  composedIdentity,
  definitionIdentityMismatches,
  isContentOnlyIdentityChange,
  isLegacyDefinitionIdentity,
  type DefinitionIdentity,
  type DefinitionIdentityMismatch,
  type DefinitionIdentityOptions,
  type StepDefinitionIdentity,
} from "./definition-identity.js";
import { reachedByExactGrants } from "./persona-identity-proofs.js";
import { retiredBuiltInDefinition } from "./retired-built-in-definitions.js";
import { retiredOutputContractPairs } from "./retired-output-contracts.js";

const WORKFLOW_VM_VERSION = "2";

/** The step-grammar record that a definition stood for before phases: the
 *  record that the loader converted, which a converted file and a run's
 *  recorded definition keep, or the base text of a bundled built-in.
 *  Undefined for a definition first written in the phase grammar. */
export function retiredStepView(workflow: WorkflowDefinition): StepGrammarWorkflow | undefined {
  return workflow.retiredStepGrammar?.workflow
    ?? (workflow.provenance?.layer === "bundled" ? retiredBuiltInDefinition(workflow.id) : undefined);
}

/** One flow list with each phase container reduced to its id and `after`.
 *  The graph hashed the shallow top-level flow, so a change inside a phase
 *  container changed that container's record only. */
function shallowFlow(flow: readonly WorkflowFlowEntry[]): readonly unknown[] {
  return flow.map((entry) => "phase" in entry
    ? { phase: entry.phase, ...(entry.after === undefined ? {} : { after: entry.after }) }
    : entry);
}

/** One record for each phase container of a flow, sorted by path. */
function phaseIdentities(flow: readonly WorkflowFlowEntry[]): readonly { readonly phaseId: string; readonly sha256: string }[] {
  const phases: { readonly phaseId: string; readonly sha256: string }[] = [];
  walkFlow(flow, (entry, { phases: path }) => {
    if (!("phase" in entry)) return;
    const own = { ...(entry.limits === undefined ? {} : { limits: entry.limits }), flow: shallowFlow(entry.flow) };
    phases.push({ phaseId: [...path, entry.phase].join("/"), sha256: hashDefinition(own).sha256 });
  });
  return phases.toSorted((left, right) => left.phaseId.localeCompare(right.phaseId));
}

/** The identity that the last step-grammar build computed for `view`, with
 *  the brief of each step from the current agent of the same record key and
 *  the personas that its grants reached before family roles.
 *  A step whose record the current definition lacks has no entry, so the
 *  comparison with a recorded identity names it. The agent of a repeat's
 *  reassess phase hashes the frozen reassessment contract of the `for` slot
 *  that it was. */
export function retiredStepIdentity(
  view: StepGrammarWorkflow,
  workflow: WorkflowDefinition,
  agents: ReadonlyMap<string, ResolvedAgent>,
  options: DefinitionIdentityOptions,
): StepDefinitionIdentity {
  const record = canonicalStepWorkflowRecord(view);
  const contract = workflowInputContract(workflow);
  const flow = shallowFlow(record.flow);
  const phases = phaseIdentities(record.flow);
  const stepAgents = Object.keys(record.steps).sort().flatMap((stepId) => {
    const agent = agents.get(stepId);
    return agent === undefined ? [] : [{ stepId, agent }];
  });
  return {
    workflowDefinitionId: record.id,
    graphSha256: hashDefinition(contract === null ? flow : { flow, input: contract.schemaSha256 }).sha256,
    ...(Arr.isReadonlyArrayNonEmpty(phases) ? { phases } : {}),
    vmVersion: WORKFLOW_VM_VERSION,
    steps: stepAgents.map(({ stepId, agent }) => {
      const output = agent.reassesses ? agent.retiredOutput : agent.output;
      const step = record.steps[stepId];
      if (step === undefined) throw new Error(`Workflow "${record.id}" retired identity lost step "${stepId}"`);
      return {
        stepId,
        policySha256: hashDefinition(canonicalStepPolicy(stepId, step)).sha256,
        contentSha256: briefContentSha256(agent, output),
        outputSha256: output.schemaSha256,
      };
    }),
    ...composedIdentity(record.id, stepAgents.map(({ agent }) => agent), options, reachedByExactGrants),
  };
}

/** Every value pair the retired step keys could hold: `toolScoping` absent
 *  or any canonical grant set, each with `kind` absent or `check`. */
function retiredStepScopes(): readonly { readonly toolScoping?: ToolScoping; readonly kind?: "check" }[] {
  const keys = Object.keys(CanonicalToolScopingSchema.fields);
  const grants = Array.from({ length: 2 ** keys.length }, (_, mask) => Schema.decodeUnknownSync(CanonicalToolScopingSchema)(
    Object.fromEntries(keys.map((key, index) => [key, (mask & (1 << index)) !== 0])),
  ));
  return [undefined, ...grants].flatMap((toolScoping) => [{ toolScoping }, { toolScoping, kind: "check" as const }]);
}

/** The recorded identity with each step policy hash that covered the retired
 *  `toolScoping` or `kind` key replaced by the policy hash of that step in
 *  the step-grammar view, when the recorded hash proves the step differs
 *  from the view only by those keys. Any other hash stays, so a changed
 *  policy still reports as drift. Returns the same identity when no hash
 *  changes, and when the definition has no step-grammar view. */
export function withoutRetiredStepScopes(identity: DefinitionIdentity, view: StepGrammarWorkflow | undefined): DefinitionIdentity {
  if (isLegacyDefinitionIdentity(identity) || view === undefined) return identity;
  let scopes: ReturnType<typeof retiredStepScopes> | undefined;
  let changed = false;
  const steps = identity.steps.map((entry) => {
    const authored = view.steps[entry.stepId];
    if (!authored) return entry;
    const policy = canonicalStepPolicy(entry.stepId, authored);
    const current = hashDefinition(policy).sha256;
    if (entry.policySha256 === current) return entry;
    scopes ??= retiredStepScopes();
    if (!scopes.some((scope) => hashDefinition({ ...policy, ...scope }).sha256 === entry.policySha256)) return entry;
    changed = true;
    return { ...entry, policySha256: current };
  });
  return changed ? { ...identity, steps } : identity;
}

/** Whether one mismatch is a renamed output contract: the recorded output
 *  hash is the frozen hash of a contract that this change renamed, and the
 *  current hash is that contract now (refer to `retiredOutputContractPairs`). */
function isRenamedContract(change: DefinitionIdentityMismatch, pairs: ReadonlyMap<string, string>): boolean {
  return change.component === "agent" && change.aspect === "output" && pairs.get(change.recorded) === change.current;
}

/** The phase-grammar identity that a run paused before phases adopts, or
 *  the proven identity unchanged. `frozen` is the identity that the last
 *  step-grammar build computes for the view, with the current briefs (refer
 *  to {@link retiredStepIdentity}). When the proven identity differs from
 *  it in nothing, or only in edited briefs and skills and in output
 *  contracts that this change renamed, the run adopts `current`, with each
 *  brief and skill hash that an edit changed kept as recorded, so the edit
 *  still reports as an adopted content change after the upgrade. */
export function adoptPhaseGrammarIdentity(
  proven: DefinitionIdentity,
  frozen: StepDefinitionIdentity | undefined,
  current: StepDefinitionIdentity,
): DefinitionIdentity {
  if (frozen === undefined || isLegacyDefinitionIdentity(proven) || proven.graphSha256 === current.graphSha256) return proven;
  const pairs = retiredOutputContractPairs();
  const evidence = definitionIdentityMismatches(proven, frozen).filter((change) => !isRenamedContract(change, pairs));
  if (evidence.length > 0 && !isContentOnlyIdentityChange(proven, frozen, evidence)) return proven;
  const frozenSteps = new Map(frozen.steps.map((step) => [step.stepId, step]));
  const recordedSteps = new Map(proven.steps.map((step) => [step.stepId, step]));
  const kept = <Entry>(recorded: Entry | undefined, atFreeze: Entry | undefined, now: Entry, hash: (entry: Entry) => string | null): Entry =>
    recorded !== undefined && atFreeze !== undefined && hash(recorded) !== hash(atFreeze) ? recorded : now;
  const frozenSkills = new Map(frozen.skills.map((skill) => [skill.skillId, skill]));
  const recordedSkills = new Map(proven.skills.map((skill) => [skill.skillId, skill]));
  const frozenPersonas = new Map(frozen.personas.map((persona) => [persona.personaName, persona]));
  const recordedPersonas = new Map(proven.personas.map((persona) => [persona.personaName, persona]));
  return {
    ...current,
    steps: current.steps.map((step) => {
      const recorded = recordedSteps.get(step.stepId);
      const atFreeze = frozenSteps.get(step.stepId);
      return recorded === undefined || atFreeze === undefined || recorded.contentSha256 === atFreeze.contentSha256
        ? step
        : { ...step, contentSha256: recorded.contentSha256 };
    }),
    skills: current.skills.map((skill) => kept(recordedSkills.get(skill.skillId), frozenSkills.get(skill.skillId), skill, ({ sha256 }) => sha256)),
    personas: current.personas.map((persona) => kept(recordedPersonas.get(persona.personaName), frozenPersonas.get(persona.personaName), persona, ({ sha256 }) => sha256)),
  };
}

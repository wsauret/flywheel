import { resolveWorkflowAgents, type ArtifactContracts, type ResolvedAgent } from "./agent-resolution.js";
import { workflowInputContract } from "./brief.js";
import type { DefinitionError } from "./definition-provenance.js";
import { parseFieldRef } from "./field-ref.js";
import { referenceIssues } from "./phase-references.js";
import { resolveSkillClosure } from "./skill-closure.js";
import type { SkillDefinition, SkillRegistryRevision } from "./skill-schema.js";
import { authoredStructureFindings } from "./vm/compile.js";
import { fieldIssues, resolveSources } from "./vm/compile-sources.js";
import { SAMPLED_LAUNCH } from "./vm/list-expansion.js";
import { structuralRemedy } from "./vm/structural-admission.js";
import {
  agentLabel,
  agentRecords,
  allPhases,
  isRepeat,
  isStreamOver,
  isWhileRepeat,
  namedAgents,
  phaseKind,
  repeatLabel,
  streams,
  WORKFLOW_INPUT_SOURCE_ID,
  type AgentRecordRef,
  type WorkflowDefinition,
} from "./workflow-schema.js";

export const USER_REQUEST_ARTIFACT_ID = "user-request";

/** A skill's `dependencies` are composed into its prompt without a model in
 *  the loop, so an id that names no installed package, or a cycle, is a
 *  definition error rather than a runtime surprise. */
export function validateSkillDependencies(skills: SkillRegistryRevision): DefinitionError[] {
  const errors: DefinitionError[] = [];
  for (const skill of skills.skills.values()) {
    const failure = describeClosureFailure(skill.dependencies, skills, `Skill "${skill.id}"`);
    if (failure) errors.push({ file: skillLocation(skill), id: skill.id, message: failure });
  }
  return errors;
}

/** Why the dependency closure of one skill or agent cannot be composed, or
 *  undefined when it can. `owner` names the skill or agent in the message.
 *  Two enforcement points share this rule: the definition set at startup,
 *  and the revision one workflow launch captures. Packages hot reload, so
 *  only the captured revision can decide whether a launch may publish. */
export function describeClosureFailure(
  dependencies: readonly string[],
  skills: SkillRegistryRevision,
  owner: string,
): string | undefined {
  try {
    resolveSkillClosure(dependencies, skills, owner);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function skillLocation(skill: SkillDefinition): string {
  return skill.source.kind === "filesystem" ? skill.source.packageDir : `manifest:${skill.source.packageKey}`;
}

/** Validate one workflow against the skill revision it will compose from. */
export function validateWorkflowDefinition(
  workflow: WorkflowDefinition,
  skills: SkillRegistryRevision,
): DefinitionError[] {
  return validateWorkflows(new Map([[workflow.id, workflow]]), skills);
}

function validateWorkflows(
  workflows: ReadonlyMap<string, WorkflowDefinition>,
  skills: SkillRegistryRevision,
): DefinitionError[] {
  const errors: DefinitionError[] = [];
  for (const workflow of workflows.values()) {
    const report = (message: string): void => {
      errors.push(workflowError(workflow, message));
    };
    const before = errors.length;
    validateNames(workflow, report);
    validateRecordKeys(workflow, report);
    validatePhaseKeys(workflow, report);
    const references = referenceIssues(workflow);
    for (const issue of references) report(issue);
    let agents: ReadonlyMap<string, ResolvedAgent>;
    try {
      agents = resolveWorkflowAgents(workflow);
    } catch (err) {
      report(err instanceof Error ? err.message : String(err));
      continue;
    }
    validateAgentPolicy(workflow, agents, skills, report);
    validateWorkflowArtifactContracts([...agents.values()], report);
    validateReassessSources(workflow, agents, report);
    // Only a definition with no located error compiles, so structural
    // admission judges the graph the compiler would emit. Otherwise each
    // list and condition field is judged alone, once its names resolve.
    if (errors.length === before) validateStructure(workflow, agents, report);
    else if (references.length === 0) {
      try {
        for (const issue of fieldIssues(workflow, agents, resolveSources(workflow, agents, SAMPLED_LAUNCH))) report(issue);
      } catch (error) {
        const failures = error instanceof AggregateError ? error.errors : [error];
        for (const failure of failures) report(failure instanceof Error ? failure.message : String(failure));
      }
    }
  }
  return errors;
}

/** Structural admission of the compiled graph: the queued attempts against
 *  the attempt limit, and ownership. A project or account workflow that
 *  admission refuses is skipped with this error as its load warning, so the
 *  person learns the finding and what to change. */
function validateStructure(workflow: WorkflowDefinition, agents: ReadonlyMap<string, ResolvedAgent>, report: (message: string) => void): void {
  let findings: ReturnType<typeof authoredStructureFindings>;
  try {
    findings = authoredStructureFindings(workflow, agents);
  } catch (error) {
    const failures = error instanceof AggregateError ? error.errors : [error];
    for (const failure of failures) report(failure instanceof Error ? failure.message : String(failure));
    return;
  }
  for (const finding of findings) {
    report(`Structural admission rejected the workflow: ${finding.name}: ${finding.message} ${structuralRemedy(finding.name)}`);
  }
}

/** Phase ids and named-agent ids share one namespace in the whole file, and
 *  none takes the reserved id of the launch input. A reference names an
 *  output by this id alone, so two declarations of one name would make it
 *  name two outputs. */
function validateNames(workflow: WorkflowDefinition, report: (message: string) => void): void {
  const seen = new Set<string>();
  const claim = (id: string, label: string): void => {
    if (id === WORKFLOW_INPUT_SOURCE_ID) report(`Workflow "${workflow.id}": ${label} uses the reserved id "${WORKFLOW_INPUT_SOURCE_ID}", which names the launch input; give it another name`);
    else if (seen.has(id)) report(`Workflow "${workflow.id}": ${label} takes the name "${id}", which another phase or agent of this file already takes; give each phase and agent its own name`);
    seen.add(id);
  };
  for (const { phase, location } of allPhases(workflow)) {
    claim(phase.phase, location.label);
    for (const { agent } of namedAgents(phase)) claim(agent, agentLabel(agent));
  }
}

/** Where one record's keys are located in a message: its phase, or its
 *  named agent. */
function recordLabel(record: AgentRecordRef): string {
  return record.kind === "named" ? agentLabel(record.definitionId) : record.location.label;
}

/** Content belongs to the record that states the inline brief. */
const CONTENT_KEYS = ["output", "dependencies", "subagents"] as const;

/** The rules of one agent record's own keys: `runs` and `brief` exclude each
 *  other, a `runs` names what the record would not find without it, a named
 *  reused brief owns its content, and only a
 *  workflow file that a chat launches by path chooses a model or an effort
 *  (refer to "agent record" in docs/terminology.md). */
function validateRecordKeys(workflow: WorkflowDefinition, report: (message: string) => void): void {
  const session = workflow.provenance?.layer === "session";
  for (const record of agentRecords(workflow).values()) {
    const where = `Workflow "${workflow.id}": ${recordLabel(record)}`;
    const { keys } = record;
    const own = record.kind === "named" ? namedAgents(record.phase).find(({ agent }) => agent === record.definitionId) ?? keys : record.phase;
    if (own.runs !== undefined && own.brief !== undefined) report(`${where} runs stands beside brief; a record runs a named brief or states its own, not both`);
    if (own.runs !== undefined && own.runs === record.defaultBriefName) {
      report(`${where} runs names "${own.runs}", the brief that the record runs without it; remove runs`);
    }
    // A phase's own content keys are judged once, at the phase
    // (validatePhaseKeys), not again at each agent that inherits them.
    if (keys.brief === undefined) {
      for (const key of CONTENT_KEYS) {
        if (own[key] !== undefined) report(`${where} ${key} stands beside a reused brief, which declares its own ${key}; write the brief inline to change it`);
      }
    }
    if (!session) {
      for (const key of ["model", "effort"] as const) {
        if (keys[key] === undefined) continue;
        report(`${where} ${key}: only a workflow file that a chat launches by path can set an agent's ${key}. Remove the key; a person chooses the model and effort of this agent in its model seat.`);
      }
    }
  }
}

/** The rules of a phase's own shape: what a list phase, a stream phase, and
 *  a phase of named agents may state, and where a join stands. A join sits
 *  on the last phase of a stream, or on a phase of named agents. The last
 *  phase of a stream and each phase of named agents join with `collect` by
 *  default; the reader drops a join that restates it (refer to
 *  `authored-repairs.ts`). A `runs` or `brief` of a phase of named agents is
 *  the default brief of its agents and runs no agent of its own, so the
 *  phase states one of them. The phase's `output`, `dependencies`, and
 *  `subagents` belong to its inline brief, so they reach an agent only
 *  through a record that runs that brief. */
function validatePhaseKeys(workflow: WorkflowDefinition, report: (message: string) => void): void {
  const briefsRun = new Set([...agentRecords(workflow).values()].map(({ briefName }) => briefName));
  const lastOfStream = new Set(streams(workflow).flatMap((stream) => {
    const last = stream.at(-1);
    return last === undefined ? [] : [last];
  }));
  const headOfStream = new Set(streams(workflow).flatMap((stream) => stream[0] === undefined ? [] : [stream[0]]));
  for (const { phase, location } of allPhases(workflow)) {
    const where = `Workflow "${workflow.id}": ${location.label}`;
    const kind = phaseKind(phase);
    if (phase.join !== undefined) {
      if (kind === "single") report(`${where} join stands on a phase of one agent; a join folds the outputs of a phase's agents`);
      else if (kind === "list" && !lastOfStream.has(phase)) report(`${where} join stands on a phase that a stream phase follows; put the join on the last phase of the stream`);
      const write = phase.join.write;
      const id = write === undefined ? phase.phase : typeof write === "string" ? write : write.id;
      if (id === USER_REQUEST_ARTIFACT_ID) report(`${where} join writes reserved artifact "${USER_REQUEST_ARTIFACT_ID}"`);
    }
    if (kind === "named" && phase.runs !== undefined && phase.brief !== undefined) {
      report(`${where} runs stands beside brief; a record runs a named brief or states its own, not both`);
    }
    if (kind === "named" && !(phase.brief !== undefined && briefsRun.has(phase.phase))) {
      const cause = phase.brief === undefined
        ? "stands on a phase of named agents that states no brief, and it belongs to an inline brief"
        : "belongs to the phase brief, which runs no agent, because each named agent states its own brief or runs";
      for (const key of CONTENT_KEYS) {
        if (phase[key] !== undefined) report(`${where} ${key} ${cause}; move ${key} beside each agent's brief`);
      }
    }
    if (phase.label !== undefined && !headOfStream.has(phase)) report(`${where} label stands on a phase that is not over a list; label names the agent of each item of a phase over a list`);
    if (phase.votes !== undefined && kind !== "list") report(`${where} votes stands on a phase that is not over a list; votes multiplies the agents of each item`);
    if (phase.over !== undefined && !isStreamOver(phase.over) && kind === "list" && !headOfStream.has(phase)) {
      report(`${where} over "${phase.over}" names no list field of an earlier output; write "<phase>.<field>" or "${WORKFLOW_INPUT_SOURCE_ID}.<field>"`);
    }
  }
}

/** Composition and execution policy that one agent declares alone: its
 *  dependency closure composes, and its writes are consistent. */
function validateAgentPolicy(
  workflow: WorkflowDefinition,
  agents: ReadonlyMap<string, ResolvedAgent>,
  skills: SkillRegistryRevision,
  report: (message: string) => void,
): void {
  for (const agent of agents.values()) {
    const closureFailure = describeClosureFailure(agent.dependencies, skills, `Workflow "${workflow.id}" agent "${agent.definitionId}"`);
    if (closureFailure) report(closureFailure);
    const lifetime = agent.writes[0]?.lifetime;
    if (lifetime && agent.writes.some((contract) => contract.lifetime !== lifetime)) report(agentMessage(agent, "mixes transient and durable write lifetimes"));
    for (const contract of agent.writes) validateArtifactContract(agent, contract, report);
  }
}

function validateArtifactContract(agent: ResolvedAgent, contract: ArtifactContracts[number], report: (message: string) => void): void {
  if (contract.id === USER_REQUEST_ARTIFACT_ID) report(agentMessage(agent, `writes reserved artifact "${USER_REQUEST_ARTIFACT_ID}"`));
  if (contract.lifetime !== "durable") return;
  const targets = new Set<string>();
  for (const target of contract.supersedes) {
    if (target === USER_REQUEST_ARTIFACT_ID) report(`Artifact "${contract.id}" supersedes reserved artifact "${USER_REQUEST_ARTIFACT_ID}"`);
    if (target === contract.id) report(`Artifact "${contract.id}" cannot supersede itself`);
    if (targets.has(target)) report(`Artifact "${contract.id}" has duplicate supersession target "${target}"`);
    targets.add(target);
  }
}

/** A repeat whose `reassess` phase edits its items routes each change on the
 *  item's `id`, so each item of its `each` source is an object with a
 *  required string `id`, and the list declares `unique: id`. */
function validateReassessSources(workflow: WorkflowDefinition, agents: ReadonlyMap<string, ResolvedAgent>, report: (message: string) => void): void {
  for (const [topIndex, entry] of workflow.phases.entries()) {
    if (!isRepeat(entry) || isWhileRepeat(entry.repeat) || entry.repeat.reassess === undefined) continue;
    const { source, field } = parseFieldRef(entry.repeat.each);
    const fields = source === WORKFLOW_INPUT_SOURCE_ID
      ? workflowInputContract(workflow)?.fields
      : agents.get(source)?.output.fields;
    const list = fields?.find(({ key }) => key === field);
    if (list === undefined) continue;
    const id = list.of?.type === "object" ? list.of.fields?.id : undefined;
    if (list.type !== "list" || id?.type !== "string" || id.optional === true || id.nullable === true || list.unique !== "id") {
      report(`Workflow "${workflow.id}": ${repeatLabel(topIndex)} each "${entry.repeat.each}" feeds a reassess phase, so each item must be an object with a required string "id" and the list must declare unique: id`);
    }
  }
}

function agentMessage(agent: ResolvedAgent, message: string): string {
  return `Agent "${agent.definitionId}" ${message}`;
}

function workflowError(workflow: WorkflowDefinition, message: string): DefinitionError {
  // Workflow provenance is optional (runtime-synthesized workflows exist);
  // loaded definitions always carry it, so the fallback only labels
  // synthetic ones.
  return {
    file: workflow.provenance?.filePath ?? `workflow:${workflow.id}`,
    layer: workflow.provenance?.layer,
    id: workflow.id,
    shadowedSource: workflow.provenance?.shadowedSource,
    message,
  };
}

/** Each artifact id names one contract in the whole workflow, a durable
 *  artifact supersedes only durable artifacts the workflow declares, and no
 *  supersession forms a cycle. */
function validateWorkflowArtifactContracts(agents: readonly ResolvedAgent[], report: (message: string) => void): void {
  const contracts = new Map<string, { contract: ArtifactContracts[number]; agent: ResolvedAgent }>();
  for (const agent of agents) {
    for (const contract of agent.writes) {
      const previous = contracts.get(contract.id);
      if (previous && contractKey(previous.contract) !== contractKey(contract)) {
        report(agentMessage(agent, `declares artifact "${contract.id}" inconsistently with "${previous.agent.definitionId}"`));
      } else if (!previous) {
        contracts.set(contract.id, { contract, agent });
      }
    }
  }
  for (const agent of agents) for (const [index, contract] of agent.writes.entries()) {
    if (contract.lifetime !== "durable") continue;
    for (const target of contract.supersedes) {
      const superseded = contracts.get(target)?.contract;
      if (!superseded) report(agentMessage(agent, `writes.${index}.supersedes: Artifact "${contract.id}" supersedes unknown artifact "${target}"; remove the target or declare the intended durable artifact`));
      else if (superseded.lifetime !== "durable") report(agentMessage(agent, `writes.${index}.supersedes: Artifact "${contract.id}" supersedes non-durable artifact "${target}"; remove the target or declare the intended durable artifact`));
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reported = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visiting.add(id);
    const contract = contracts.get(id)?.contract;
    if (contract?.lifetime === "durable") {
      for (const target of contract.supersedes) {
        if (visiting.has(target)) {
          const edge = `${id}->${target}`;
          if (!reported.has(edge)) {
            reported.add(edge);
            report(`Artifact supersession cycle includes "${id}" and "${target}"`);
          }
        } else {
          visit(target);
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of contracts.keys()) visit(id);
}

function contractKey(contract: ArtifactContracts[number]): string {
  return contract.lifetime === "transient"
    ? "transient"
    : `durable:${contract.supersedes.toSorted().join("\u0000")}`;
}

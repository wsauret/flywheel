import { contentEvidence } from "../../src/infra/content-evidence.js";
import { resolveSkillBody } from "../../src/workflows/skill-references.js";
import { compileOutput } from "../../src/workflows/output-contract/compile.js";
import type { Field, OutputObject } from "../../src/workflows/output-contract/grammar.js";
import type { LoadedBrief } from "../../src/workflows/brief.js";
import { resolveWorkflowAgents, type ResolvedAgent } from "../../src/workflows/agent-resolution.js";
import { publishSkillRevision, type SkillDefinition, type SkillRegistryRevision } from "../../src/workflows/skill-schema.js";
import { compileReassessmentOutput, compileRetiredReassessmentOutput } from "../../src/workflows/vm/reassessment-contract.js";
import type { AgentRecordKeys, WorkflowDefinition } from "../../src/workflows/workflow-schema.js";
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, workflowIn } from "./project-definitions.js";

/** A workflow whose conditional inline brief composes two external packages. */
export function testDependencyWorkflow(): WorkflowDefinition {
  const workflow = workflowIn(fixtureDefinitions().captureRevision(), FIXTURE_WORKFLOW_ID);
  const { briefs: _briefs, retiredStepGrammar: _retired, inputContract: _input, ...authored } = workflow;
  return {
    ...authored,
    id: "external-fixture",
    name: "External Fixture",
    phases: [
      {
        phase: "start",
        name: "Start",
        brief: "Investigate the reported issue.",
        output: { summary: "What the investigation found.", fields: { hypothesis: { type: "string", nullable: true, description: "The confirmed root cause." } } },
        writes: [],
      },
      {
        phase: "follow",
        if: "start.hypothesis",
        name: "Follow",
        brief: "Do the follow-up work.",
        dependencies: ["fixture.root", "fixture.child"],
        output: { summary: "What the package did." },
        writes: [],
      },
    ],
  };
}

/** One bundled skill package as a loaded definition, without a package on disk.
 *  The body is the id-derived placeholder unless a test asserts on the composed
 *  prompt, in which case it passes its own. */
export function testSkill(id: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  const body = overrides.body ?? `Do the ${id} work.`;
  return {
    id,
    name: id,
    trigger: `Use when the task is about ${id}.`,
    tags: [],
    relatedIds: [],
    dependencies: [],
    agents: [],
    modelInvocable: true,
    resources: [],
    source: { kind: "manifest", authority: "bundled", reach: "global", packageKey: id, files: new Map([["SKILL.md", body]]) },
    ...overrides,
    body,
    evidence: contentEvidence(body),
    packageIdentity: overrides.packageIdentity ?? { sha256: "c".repeat(64), bytes: Buffer.byteLength(body, "utf8") },
  };
}

/** Add deterministic synthetic external packages without reading user stores. */
export function withTestExternalSkills(
  revision: SkillRegistryRevision,
  ids: readonly string[],
): SkillRegistryRevision {
  const skills = new Map(revision.skills);
  for (const [index, id] of ids.entries()) {
    skills.set(id, testSkill(id, {
      source: {
        kind: "filesystem",
        authority: "external",
        reach: "global",
        packageDir: `/configured/${id}`,
        canonicalDir: `/synthetic/${id}`,
        canonicalId: `test:${index}`,
        linked: false,
      },
    }));
  }
  return publishSkillRevision(revision.revision + 1, skills, revision.bundledCorpus);
}

/** A revision that installs exactly these packages. */
export function testSkillRevision(skills: readonly SkillDefinition[]): SkillRegistryRevision {
  return publishSkillRevision(1, new Map(skills.map((skill) => [skill.id, skill])));
}

/** The workflow keys of one test agent: its display name, output contract,
 *  and policy. The procedure comes from the package. */
export type TestAgentOverrides = {
  readonly name?: string;
  readonly writes?: AgentRecordKeys["writes"];
  /** The output lists that a later phase or a join needs, which a workflow
   *  load derives from the phases that read them. */
  readonly countedLists?: readonly string[];
  /** The output lists that a join's admission reads, such as coverage exclusions. */
  readonly admittedLists?: readonly string[];
} & (
  | { readonly output?: OutputObject; readonly reassess?: never }
  /** The item type of the `each` source this agent reassesses; the reassess
   *  phase then owns the agent's output, as the loader gives it. */
  | { readonly reassess: Field; readonly output?: never });

/** Resolve one agent record whose brief is a package's body, the way a brief
 *  file with that body and dependencies resolves. The brief id is the
 *  package id, so the model seat matches a brief file named after it. */
export function testResolvedAgent(definitionId: string, skill: SkillDefinition, overrides: TestAgentOverrides = {}): ResolvedAgent {
  const { output, reassess, name = skill.name, countedLists, admittedLists, ...policy } = overrides;
  const brief: LoadedBrief = {
    briefId: skill.id,
    procedure: {
      name,
      ...(skill.trigger ? { description: skill.trigger } : {}),
      dependencies: skill.dependencies,
      subagents: skill.agents,
      body: resolveSkillBody(skill),
    },
    ...(reassess === undefined
      ? { reassesses: false, output: compileOutput(output ?? {}) }
      : { reassesses: true, output: compileReassessmentOutput(reassess), retiredOutput: compileRetiredReassessmentOutput(reassess) }),
    countedLists: countedLists ?? (reassess === undefined ? [] : ["changes"]),
    admittedLists: admittedLists ?? [],
    defaultedLists: [],
  };
  const workflow: WorkflowDefinition = {
    id: "test-agent",
    name: "Test Agent",
    phases: [{ phase: definitionId, name, brief: skill.body, writes: [], ...policy }],
    briefs: new Map([[definitionId, brief]]),
  };
  const resolved = resolveWorkflowAgents(workflow).get(definitionId);
  if (!resolved) throw new Error(`test agent "${definitionId}" did not resolve`);
  return resolved;
}

/** The resolved agent map a host, compiler, or workflow view is driven with. */
export function testResolvedAgents(agents: readonly ResolvedAgent[]): ReadonlyMap<string, ResolvedAgent> {
  return new Map(agents.map((agent) => [agent.definitionId, agent]));
}

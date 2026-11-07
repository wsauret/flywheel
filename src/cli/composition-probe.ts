// This probe enters before normal command composition and owns its catalog bootstrap.
import "../orchestration/modules.js";
import type { StartupDirectories } from "../infra/directory-authorities.js";
import type { CapabilityCheck } from "../infra/capability-text.js";
import { isDevelopmentBuild } from "../infra/development-mode.js";
import { resolveWorkflowAgents } from "../workflows/agent-resolution.js";
import { personaInstructions } from "../workflows/agents/persona-instructions.js";
import { assembleSkillInvocation } from "../workflows/skill-invocation.js";
import { assembleAgentPrompt } from "../workflows/context-bundle/prompt-assembly.js";
import { skillClosureIds } from "../workflows/skill-closure.js";
import { createInstalledDefinitionRegistry } from "../orchestration/definition-catalog.js";
import { loadWorkflowFile, renderWorkflowFileDiagnostic } from "../workflows/workflow-file.js";
import workflowContent from "./composition-probe.workflow.yaml" with { type: "text" };

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Composition probe is missing ${label}`);
  return value;
}

/** The probe composes for an agent that holds every capability, the default
 *  selection's rendering, so its output depends on no machine's settings. */
const EVERY_CAPABILITY: CapabilityCheck = () => true;

/** Emit deterministic production composition for source-to-binary acceptance. */
export function runCompositionProbe(directories: StartupDirectories): void {
  const definitions = createInstalledDefinitionRegistry({ ...directories, skillRoots: [] });
  const definitionRevision = definitions.captureRevision();
  const revision = definitionRevision.skills;
  const personas = definitionRevision.personas;
  const personaIndex = Object.fromEntries([...personas.values()].filter((agent) => agent.kind === "persona").map(({ name, role }) => [name, { name, role }]));
  const invocationOptions = { skills: revision, personaIndex, capabilities: EVERY_CAPABILITY };
  const direct = Object.fromEntries(["code-review", "plan-review"].map((id) => {
    const skill = required(revision.skills.get(id), `skill ${id}`);
    return [id, {
      closureIds: skillClosureIds([id], revision, `Direct skill "${id}"`),
      render: assembleSkillInvocation(skill, undefined, invocationOptions),
    }];
  }));
  const reviewer = required(personas.get("reviewer-plan-performance"), "reviewer-plan-performance persona");
  if (reviewer.kind !== "persona") throw new Error("Composition probe reviewer is not a persona");
  const requiredSkillIds = reviewer.requiredSkills ?? [];
  const personaClosureIds = skillClosureIds(requiredSkillIds, revision, `Persona "${reviewer.name}"`);
  const personaComposition = personaInstructions(reviewer, revision, EVERY_CAPABILITY);
  const file = "composition-probe.workflow.yaml";
  const loaded = loadWorkflowFile({
    file,
    content: workflowContent,
    location: undefined,
    provenance: { layer: "session", filePath: file },
    skills: revision,
  });
  if (!loaded.ok) throw new Error(loaded.diagnostics.map(renderWorkflowFileDiagnostic).join("\n"));
  const workflow = loaded.workflow;
  const agent = required(resolveWorkflowAgents(workflow).get("fix"), "composition-probe/fix agent");
  const workerPrompt = assembleAgentPrompt({
    attempt: { id: "probe", definitionId: agent.definitionId, briefId: agent.briefId, workflowDefinitionId: workflow.id, name: agent.name, status: "pending", writes: agent.writes.map(({ id }) => id), description: "Fix the confirmed bug.", resumeRevertCount: 0 },
    agent,
    contextBundle: "",
    skills: revision,
    capabilities: EVERY_CAPABILITY,
  });
  const bundledSources = new Set([...revision.bundledCorpus.values()]
    .map((pkg) => required(revision.skills.get(pkg.id), `bundled skill ${pkg.id}`).source.kind));
  const composition = {
    selectedSkills: [...revision.skills.values()].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, packageIdentity, modelInvocable }) => ({ id, packageIdentity, modelInvocable })),
    modelRoster: revision.modelInvocable.map(({ id, trigger }) => ({ id, trigger })),
    coreManifest: revision.coreManifest,
    coreIdentity: revision.coreIdentity,
    direct,
    persona: { id: reviewer.name, requiredSkillIds, closureIds: personaClosureIds, render: personaComposition },
    workflow: { workflowId: workflow.id, definitionId: agent.definitionId, briefId: agent.briefId, ...workerPrompt },
  };
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    evidence: {
      buildKind: isDevelopmentBuild() ? "source" : "compiled",
      bundledSourceKinds: [...bundledSources].sort(),
    },
    composition,
  })}\n`);
}

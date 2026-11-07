/**
 * Compile and print the full system prompt for any runner flavor.
 *
 * Usage:
 *   bun run scripts/dump-prompt.ts chat                        # chat runner (default)
 *   bun run scripts/dump-prompt.ts subagent [agent-type]       # default: implementer
 *   bun run scripts/dump-prompt.ts worker [workflow-file] [phase] # default: composition probe fixture, fix
 *
 *   Add --sizes to print a per-layer size table (chars + estimated tokens)
 *   instead of the raw prompt text, e.g.:
 *   bun run scripts/dump-prompt.ts worker src/cli/composition-probe.workflow.yaml fix --sizes
 *
 *
 * The request comes from the shared assembly (scripts/prompt-assembly.ts),
 * which plans and builds it the way a live request does, over the shipped
 * module composition and the default configuration. Worker mode gives the
 * agent of a workflow the tools that agent-callback gives it and stands a
 * representative session scratch path in for the live one.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInstalledDefinitionRegistry } from "../src/orchestration/definition-catalog.js";
import { resolveWorkflowAgents } from "../src/workflows/agent-resolution.js";
import { loadWorkflowFile, renderWorkflowFileDiagnostic } from "../src/workflows/workflow-file.js";
import { personaInstructions } from "../src/workflows/agents/persona-instructions.js";
import type { SkillRegistryRevision } from "../src/workflows/skill-schema.js";
import { assembleAgentPrompt } from "../src/workflows/context-bundle/prompt-assembly.js";
import type { AttemptRow } from "../src/workflows/view/types.js";
import { loadStandalonePersonaRegistry } from "../src/workflows/agents/registry.js";
import { handoffToolSchemaFromOutput } from "../src/orchestration/workflow-host/handoff-tool-schema.js";
import { loadAgentInstructions } from "../src/orchestration/agent-runtime/project-instructions.js";
import { buildSubagentTask, SUBAGENT_HANDOFF_SCHEMA } from "../src/orchestration/modules/subagents/execution/prompts.js";
import type { SystemPromptPart } from "../src/orchestration/agent-runtime/system-prompt.js";
import { readModuleMemory } from "../src/orchestration/agent-runtime/request-system-prompt.js";
import { SYSTEM_PROMPT_SEPARATOR } from "../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../src/infra/agent-assets/system-prompt.js";
import { personaToolEntries, toolRegistryFromComposition } from "../src/orchestration/agent-runtime/tools/tool-registry.js";
import { captureRuntimeConfigRequest } from "../src/orchestration/agent-runtime/request-config.js";
import type { AgentPurpose } from "../src/orchestration/agent-runtime/types.js";
import { composeFirstPartyModules } from "../src/orchestration/modules.js";
import { loadConfig } from "../src/orchestration/config/loader.js";
import type { AgentDefinition } from "../src/infra/agent-definition.js";
import { planPromptRequest, plannedCapabilities, promptParts, type PlanInput, type PlannedRequest, type PromptAssembly } from "./prompt-assembly.js";

const repoRoot = resolve(import.meta.dir, "..");
const accountHome = homedir();
const userDataRoot = join(accountHome, ".flywheel");
/** One explicit owner for this dump: the definitions and packages a run in
 *  this repository composes from. */
const definitions = createInstalledDefinitionRegistry({
  projectRoot: repoRoot,
  userDataRoot,
  accountHome,
});
const args = process.argv.slice(2).filter((a) => a !== "--sizes");
const showSizes = process.argv.includes("--sizes");
const mode = args[0] ?? "chat";

const moduleSnapshot = composeFirstPartyModules();
const assembly: PromptAssembly = {
  projectRoot: repoRoot,
  userDataRoot,
  accountHome,
  scratchDir: join(repoRoot, ".flywheel", "sessions", "<sessionId>", "scratch"),
  definitions: definitions.captureRevision(),
  // The default configuration, captured the way a request captures it.
  runtimeConfig: (() => {
    const loaded = loadConfig(undefined, process.env, userDataRoot);
    return captureRuntimeConfigRequest({
      revision: 0,
      config: loaded.config,
      warnings: loaded.warnings,
      diagnostics: loaded.diagnostics,
      sourceIdentity: "dump-prompt",
      status: { kind: "missing" },
    }, "default");
  })(),
  capture: moduleSnapshot,
  live: moduleSnapshot,
  // The shipped default mode, so the dump shows what a new account's chat sees.
  workflowsMode: "on",
  servingModel: { model: "dump-model", modelFamily: "anthropic" },
  hosts: false,
};

interface PromptResult {
  label: string;
  systemPrompt: string;
  userPrompt?: string;
  /** Named prompt layers, in assembly order, for the --sizes table. A layer
   *  without a tier is a decomposition of its parent and is not summed again. */
  layers: Array<[name: string, text: string, tier?: SystemPromptPart["tier"]]>;
}

/** The system prompt of one planned request. The core prompt resolves the
 *  same overlay chain a live runner uses; the compiled-in manifest is empty in
 *  a source checkout, so without this the dump would silently drop the first
 *  prompt layer. */
async function compile(purpose: AgentPurpose, planned: PlannedRequest) {
  const parts = await promptParts(assembly, purpose, planned, {
    corePrompt: loadSystemPrompt({ projectRoot: repoRoot, userDataRoot }),
    engineeringDoctrine: loadEngineeringDoctrine({ projectRoot: repoRoot, userDataRoot }),
    agentsMd: await loadAgentInstructions({ executionCwd: repoRoot, projectRoot: repoRoot, accountHome, userDataRoot }),
    memory: (snapshot) => readModuleMemory(snapshot, { projectRoot: repoRoot, accountHome }),
  });
  return {
    systemPrompt: parts.map((p) => p.text).join(SYSTEM_PROMPT_SEPARATOR),
    layers: parts.map((p): PromptResult["layers"][number] => [p.label, p.text, p.tier]),
  };
}

/** Personas of this repository, validated against the skill revision their
 *  `requiredSkills` name. */
function loadRegistry(skills: SkillRegistryRevision): Map<string, AgentDefinition> {
  return new Map(loadStandalonePersonaRegistry(
    join(repoRoot, "src", "workflows", "agents", "personas"),
    skills,
    personaToolEntries(toolRegistryFromComposition(moduleSnapshot)),
    join(repoRoot, ".flywheel", "agents"),
  ));
}

const planTools = (input: PlanInput): Promise<PlannedRequest> => planPromptRequest(assembly, input);

async function buildChatPrompt(): Promise<PromptResult> {
  const skills = definitions.skills();
  const purpose: AgentPurpose = { kind: "interactive-chat" };
  const planned = await planTools({ personas: loadRegistry(skills), purpose, askUser: true });
  planned.tools.delete("handoff"); // chat has no handoff path

  return {
    label: `CHAT (tools: ${[...planned.tools.keys()].join(", ")})`,
    ...await compile(purpose, planned),
  };
}

async function buildSubagentPrompt(agentType: string): Promise<PromptResult> {
  const skills = definitions.skills();
  const registry = loadRegistry(skills);
  const agent = registry.get(agentType);
  if (!agent) {
    const available = Array.from(registry.keys()).join(", ");
    console.error(`Unknown agent type: "${agentType}". Available: ${available}`);
    process.exit(1);
  }
  // The general agent is a clone of its parent, so its prompt and tools exist
  // only at dispatch; there is no authored surface to dump.
  if (agent.kind !== "persona") {
    console.error(`Agent type "${agentType}" inherits the dispatching agent's prompt and tools; dump the parent flavor instead.`);
    process.exit(1);
  }

  const granted = [...agent.tools, "handoff"];
  const purpose: AgentPurpose = { kind: "subagent", renderAs: "subagent", parentToolUseId: "dump" };
  // A persona child sees a step's tools; its task names the ones it may call.
  const planned = await planTools({
    personas: registry,
    purpose,
    handoffSchema: { schema: SUBAGENT_HANDOFF_SCHEMA },
    askUser: false,
  });

  // Dispatch composes the persona's declared packages ahead of its role
  // instructions, so the dump mirrors that order or it reports a prompt no
  // child receives.
  const has = plannedCapabilities(planned);
  const instructions = personaInstructions(agent, skills, has);

  return {
    label: `SUBAGENT: ${agentType} (granted: ${granted.join(", ")})`,
    ...await compile(purpose, planned),
    // The child's task is the turn after the parent's assignment.
    // The task's rules name only tools, which the child may call when its grant holds them.
    userPrompt: buildSubagentTask(instructions, (term) => has(term) && granted.includes(term), agent.maxTurns),
  };
}

async function buildWorkerPrompt(workflowFile: string, definitionId: string): Promise<PromptResult> {
  const revision = definitions.captureRevision();
  const skills = revision.skills;
  const loaded = loadWorkflowFile({
    file: workflowFile,
    content: await Bun.file(workflowFile).text(),
    location: undefined,
    provenance: { layer: "session", filePath: workflowFile },
    skills,
  });
  if (!loaded.ok) throw new Error(loaded.diagnostics.map(renderWorkflowFileDiagnostic).join("\n"));
  const workflow = loaded.workflow;
  const agents = resolveWorkflowAgents(workflow);
  const agent = agents.get(definitionId);
  if (!agent) {
    const available = Array.from(agents.keys()).sort().join(", ");
    console.error(`Unknown phase: "${definitionId}" in workflow file "${workflowFile}". Available: ${available}`);
    process.exit(1);
  }

  const attempt: AttemptRow = {
    id: `test-${definitionId}`,
    definitionId,
    briefId: agent.briefId,
    workflowDefinitionId: workflow.id,
    name: agent.name,
    status: "running",
    description: "Create a file named marker.txt containing exactly 'hello world'.",
    writes: agent.writes.map((contract) => contract.id),
    resumeRevertCount: 0,
  };

  // Mirrors the exposure of an agent of a workflow (agent-callback
  // createContext): every agent gets the whole catalog, and the handoff schema
  // is the agent's compiled output.
  const purpose: AgentPurpose = { kind: "workflow-agent", briefScope: { briefId: agent.briefId }, workflowAttemptId: attempt.id };
  const planned = await planTools({
    personas: loadRegistry(skills),
    purpose,
    handoffSchema: { schema: handoffToolSchemaFromOutput(agent.output) },
    // Only a root chat asks the person (PI-AGENT-024).
    askUser: false,
  });
  const assembled = assembleAgentPrompt({
    attempt,
    agent,
    contextBundle: "",
    skills,
    capabilities: plannedCapabilities(planned),
  });

  return {
    label: `WORKER: ${workflow.id}/${agent.definitionId} (brief ${agent.briefId}; tools: ${[...planned.tools.keys()].join(", ")})`,
    ...await compile(purpose, planned),
    // The step's opening turn: its context, then its task.
    userPrompt: `${assembled.userPrompt}\n\n${assembled.task}`,
  };
}

let result: PromptResult;
switch (mode) {
  case "subagent": result = await buildSubagentPrompt(args[1] ?? "implementer"); break;
  case "worker": result = await buildWorkerPrompt(args[1] ?? join(repoRoot, "src", "cli", "composition-probe.workflow.yaml"), args[2] ?? "fix"); break;
  case "chat": result = await buildChatPrompt(); break;
  default: console.error(`Unknown mode: "${mode}". Use: subagent, worker, or chat`); process.exit(1);
}

const sep = "=".repeat(80);

if (showSizes) {
  const est = (n: number) => Math.round(n / 4);
  console.log(`PROMPT SIZES: ${result.label}\n`);
  const row = (name: string, chars: number, tier = "") => console.log(`${tier.padEnd(12)} ${name.padEnd(38)} ${String(chars).padStart(8)} chars  ~${String(est(chars)).padStart(6)} tok`);
  for (const [name, text, tier] of result.layers) row(name, text.length, tier ?? "");
  if (result.userPrompt) row("user prompt", result.userPrompt.length);
  const tierChars = (tier: SystemPromptPart["tier"]) => result.layers.filter((layer) => layer[2] === tier).map((layer) => layer[1]).join(SYSTEM_PROMPT_SEPARATOR).length;
  const total = result.systemPrompt.length + (result.userPrompt?.length ?? 0);
  console.log("-".repeat(73));
  row("stable tier (shared prompt cache)", tierChars("stable"));
  row("session tier", tierChars("session"));
  row("conversation tier", tierChars("conversation"));
  console.log("-".repeat(73));
  row("TOTAL", total);
  process.exit(0);
}

console.log(sep);
console.log(`PROMPT DUMP: ${result.label}`);
console.log(`${sep}\n`);
console.log("SYSTEM PROMPT\n");
console.log(result.systemPrompt);

if (result.userPrompt) {
  console.log(`\n${sep}\n`);
  console.log("USER PROMPT\n");
  console.log(result.userPrompt);
}

console.log(`\n${sep}`);
const systemTokens = Math.round(result.systemPrompt.length / 4);
const userTokens = result.userPrompt ? Math.round(result.userPrompt.length / 4) : 0;
console.log(`\nSystem prompt: ${result.systemPrompt.length} chars (~${systemTokens} tokens)`);
if (result.userPrompt) console.log(`User prompt: ${result.userPrompt.length} chars (~${userTokens} tokens)`);
console.log(`Total: ${result.systemPrompt.length + (result.userPrompt?.length ?? 0)} chars (~${systemTokens + userTokens} tokens)`);

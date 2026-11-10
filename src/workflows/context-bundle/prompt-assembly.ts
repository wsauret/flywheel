import type { CapabilityCheck } from "../../infra/capability-text.js";
import { Log } from "../../infra/log.js";
import type { ResolvedAgent } from "../agent-resolution.js";
import type { SkillRegistryRevision } from "../skill-schema.js";
import { renderSkillClosure } from "../skill-render.js";
import type { AttemptRow } from "../view/types.js";

const log = Log.create({ service: "prompt-assembly" });

interface AssembleWorkerPromptInput {
  attempt: AttemptRow;
  agent: ResolvedAgent;
  contextBundle: string;
  /** Revision the agent's dependency closure is composed from. The caller
   *  pins it, so a reload mid-attempt cannot change the procedure the agent
   *  runs. */
  skills: SkillRegistryRevision;
  /** The check of the agent that runs the attempt (ARCH-CONTEXT-033): its
   *  composed packages and its postamble render for the tools it may call. */
  capabilities: CapabilityCheck;
  /** The vote that an agent of a list with votes casts on its item. */
  vote?: { readonly number: number; readonly count: number };
  /** What the earlier attempt of an overflow continuation recorded: its
   *  latest rendered checkpoint and the file evidence of its conversations. */
  earlierAttempt?: { readonly checkpoint: string | null; readonly fileEvidence: string | null };
}

interface AgentPrompt {
  task: string;
  userPrompt: string;
}

/** Assemble the task message: the agent's dependency closure, the brief, and the
 *  postamble compiled from the agent's output contract. */
function buildTask(
  agent: ResolvedAgent,
  skills: SkillRegistryRevision,
  capabilities: CapabilityCheck,
): string {
  const parts: string[] = [];

  parts.push(...renderSkillClosure(agent.dependencies, skills, `Agent "${agent.definitionId}"`, capabilities));
  if (agent.body) parts.push(agent.body);
  parts.push(agent.output.instructions(capabilities("bash")));

  return parts.join("\n\n");
}

/** The one rendering rule for the item of an agent of a repeat over items. */
function renderItem(item: unknown): string {
  return `## Item\n\n${JSON.stringify(item, null, 2)}`;
}

/** The one rendering rule for the vote of an agent of a list with votes, so
 *  the brief can give each vote its own angle. */
function renderVote({ number, count }: NonNullable<AssembleWorkerPromptInput["vote"]>): string {
  return `## Vote\n\nYou cast vote ${number} of ${count} on the item in your item context. Each vote runs as its own agent, and no vote sees another.`;
}

/** The one rendering rule for the recorded progress of the attempt that an
 *  overflow continuation continues, so the agent does not repeat its work. */
function renderEarlierAttempt({ checkpoint, fileEvidence }: NonNullable<AssembleWorkerPromptInput["earlierAttempt"]>): string {
  return [
    "## Your Earlier Attempt",
    "An earlier attempt of this agent outgrew its context window. You continue its work in a new conversation. Its latest checkpoint and the file edits that it recorded follow. Do not repeat the work that it finished.",
    ...(checkpoint === null ? [] : [checkpoint]),
    ...(fileEvidence === null ? [] : [fileEvidence]),
  ].join("\n\n");
}

/** Build the user prompt from the brief's description and the canonical context bundle. */
function buildUserPrompt(
  { attempt, contextBundle, vote, earlierAttempt }: Omit<AssembleWorkerPromptInput, "skills" | "capabilities">,
): string {
  const parts: string[] = [];
  if (attempt.description) parts.push(`## Brief\n\n${attempt.description}`);
  if (attempt.item !== undefined) parts.push(renderItem(attempt.item));
  if (vote !== undefined) parts.push(renderVote(vote));
  if (contextBundle) parts.push(contextBundle);
  if (earlierAttempt !== undefined) parts.push(renderEarlierAttempt(earlierAttempt));
  return parts.join("\n\n");
}

/** Assemble complete agent prompts from the resolved agent and one canonical context bundle. */
export function assembleAgentPrompt(input: AssembleWorkerPromptInput): AgentPrompt {
  const { agent, contextBundle, skills, capabilities } = input;
  const task = buildTask(agent, skills, capabilities);
  const userPrompt = buildUserPrompt(input);
  log.info("prompt assembled", {
    taskInstructionBytes: task.length,
    userBytes: userPrompt.length,
    hasContextBundle: contextBundle.length > 0,
  });
  return { task, userPrompt };
}

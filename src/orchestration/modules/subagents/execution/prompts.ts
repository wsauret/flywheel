import { roleCovers, type AgentDefinition } from "../../../../infra/definitions/agent-definition.js";
import type { HandoffToolSchema } from "../../../workflow-host/attempt/handoff-tool-schema.js";
import type { ToolOutcome } from "../../../../infra/substrate/runtime-facts/tool-outcome.js";
import { formatToolInputProblems } from "../../../agent-runtime/tools/input/validate-input.js";
import { gitDisciplineRule, isReadOnlyPersona } from "../../../agent-runtime/request/prompt/persona-tool-rules.js";
import type { CapabilityCheck } from "../../../../infra/definitions/capability-text.js";

interface DispatchInput {
  [key: string]: unknown;
}

/** The subagent catalog: which agent types in `agents` this session may dispatch and when to use them. It varies
 *  with the `subagents` of a brief and a child's granted roles, so it renders in the session tier and the dispatch
 *  tool's own bytes stay the same for every agent that shares the prompt cache. A use case that needs a capability
 *  that the tree check `has` refuses is left out: Ship publishes only through Bash. An unattended tree has no
 *  person who asks for publication, so it gets no publication use case (PI-AGENT-121). Each line names an agent
 *  type only by the name that dispatch accepts, never by its role, which several types can share, and marks a
 *  persona that can change no file (ARCH-TOOLS-011). */
export function renderSubagentRoster(agents: ReadonlyMap<string, AgentDefinition>, has: CapabilityCheck, unattendedTree: boolean): string {
  if (agents.size === 0) return "# Subagents\n\nNo agent type is available for you to dispatch here, so do the work directly.";
  const agentList = Array.from(agents.values())
    .map((a) => `- ${a.name}${isReadOnlyPersona(a) ? " (read-only)" : ""}: ${a.description}${routing(a, has)}`)
    .join("\n");
  const personas = Array.from(agents.values()).filter((agent) => agent.kind === "persona");
  const offers = (role: string) => personas.some((agent) => roleCovers(role, agent.role));
  const useCases: string[] = [];
  if (offers("ship") && has("bash") && !unattendedTree) {
    useCases.push("- Repository publication: after you complete implementation, review, and verification, use the Ship agent. Send only the files you changed, from your own tracked list, and a short summary of user intent and implemented design. Do not run Git analysis, prepare a commit message, or send verification evidence, and do not ask Ship to verify, separate authorship, select hunks, or create isolation worktrees. Add publication instructions only when the user requested a PR or a nondefault destination. For a PR, also send what changed from the approved design, the proof that the change works, and what that proof does not cover, as you wrote them for your reply; Ship puts it in the pull request description as written, without assessing it.");
  }
  if (offers("advisor")) {
    useCases.push(`- Advisor consultation: use the advisor when two materially different approaches remain plausible and evidence does not decide between them, a consequential decision depends on an uncertain assumption, a focused attempt failed and the next move is unclear, or an independent second opinion is needed before an expensive, risky, or difficult-to-reverse action. Do not use it for factual lookup, keyword search, or repository discovery, an obvious or reversible local choice, implementation, or routine review of a finished diff or plan; a user-selected pre-approval design review is allowed. Send a concise decision packet: the exact decision, relevant context and project authority, plausible alternatives with the evidence for and against each, prior attempts and what they ruled out, and the uncertainty.${has("type:general") ? " Use fork: true only when accumulated conversation context is material evidence." : ""} Its guidance is private; you own the decision, execution, verification, and user communication. If it fails or is unavailable, continue with the evidence you have; do not retry or respawn it only for consultation.`);
  }

  return `# Subagents

${agentList}${useCases.length > 0 ? `\n\nWhen to use:\n${useCases.join("\n")}` : ""}`;
}

/** The sentence after the general agent's description that routes work to the other types: a description states only
 *  its own type, and the roster names another type only while the tree check `has` offers it (ARCH-CONTEXT-033). */
function routing(agent: AgentDefinition, has: CapabilityCheck): string {
  if (agent.kind !== "general") return "";
  return has("type:explorer") ? " Prefer explorer for cheap read-only searches and a persona agent for a named specialty." : " Prefer a persona agent for a named specialty.";
}

/** The fewest characters of trimmed `rationale` that a dispatch accepts. The
 *  tool schema declares it, and `validateDispatchInput` enforces it, because the
 *  dispatcher's central validator checks only structure. */
export const MIN_DISPATCH_RATIONALE_LENGTH = 30;

/** The dispatch tool's description for the tree check `has`, so every agent of a tree reads the same bytes. The
 *  catalog it names renders in the session tier (`renderSubagentRoster`). A fork, which copies the dispatcher as the
 *  general agent does, is named only while `has` offers the general agent. An unattended chat has no person who
 *  watches a child stream (PI-AGENT-121). */
export const subagentDescription = (has: CapabilityCheck, unattendedChat: boolean): string => `Launch a subagent for a focused subtask in an isolated context.

Each dispatch returns at once; the result comes to you, not to the user, in a later runtime notification.

Steer a running child with message_session; it replies only to a question. Check, interrupt, or resume it with process by its session_id. A child that you or the runtime interrupted never blocks your handoff: do its work yourself, leave it, or continue it.

Writing the prompt: ${has("type:general") ? "unless you fork, " : ""}the child has not seen your conversation. Give it the goal, file paths, constraints, and the output you want; a scoped task needs only a few sentences. Set a report length only when your context budget needs one.

The runtime records your approved checkpoint Design intent and Decisions in the child's conversation, read-only. Keep your checkpoint current before dispatch; do not copy its intent into the brief. Everything else in an implementation brief is implementation design the subagent may revise and must report.

Give one dispatch one phase, fix, or question; run multi-phase work as sequential dispatches. To have the child prove its work, name the narrowest check; suite-level or project-wide gates are yours to run after you collect the result.

Never delegate understanding: name the files, lines, and change, never "based on your findings, fix the bug."${unattendedChat ? "" : `

The user sees the subagent's output as it streams.`}`;

/** Closure and turn-budget preamble. A function because the budget is the
 *  dispatched agent definition's maxTurns, not a constant of the template,
 *  and because its rules for running checks and commands hold only for a
 *  child that has the shell (ARCH-CONTEXT-033). */
function subagentClosure(maxTurns: number, shell: boolean): string {
  return `# Delegated Subtask

## Closure

No planning, no TODO tracking, no progress updates, no meta-commentary.

Your parent verifies your work after collecting your result.${shell ? " While working, run the narrowest check that proves each change: one test file, not a suite. Run a suite-level or project-wide gate at most once, immediately before handoff, and only when your assignment names that gate; otherwise leave final verification to your parent." : ""}

Before submitting: verify all requested deliverables are present, every claim is grounded in tool output, and no material lookup was skipped.

Stay within your assignment; note anything outside it in your handoff instead of pursuing it.

## Turn Economy

This run stops after at most ${maxTurns} turns, and unreported work is then lost. Keep the last turn for the handoff. Put every independent read, edit, and check that you already know you need in one turn; fixes are batched before one narrow re-verification.`;
}

const SUBAGENT_HANDOFF_CONTRACT = `## Handoff

Call \`handoff\` exactly once. The parent reads only the handoff, not your conversation.

Your handoff is the result, not a replay of the run. For exploration, analysis, and review assignments, the report is the deliverable: include every material finding the assignment requested, with one claim per line and its \`file:line\` evidence. For implementation assignments, submit a concise completion record with the outcome, changed files, exact verification results, every material deviation from the assignment's stated approach (what it said, what you did instead, why, and the evidence), any work that is not done, and any parent action still required. Do not paste command output or replay the work log. In every handoff, omit preamble, process narration, repeated points, and restatement of the assignment.

Do not give up due to uncertainty or missing information obtainable via your tools.`;

/** Build the subagent addendum appended after the persona (or inherited
 *  parent) instructions. The result is the child runner's `task`, which the
 *  child receives as a turn of its conversation, not in its system prompt.
 *  `has` is the child's own agent check (ARCH-CONTEXT-033), so the addendum
 *  states only rules for tools the child's plan lets it call. `maxTurns` is
 *  the dispatched agent definition's turn cap, disclosed so the child can
 *  budget. Git discipline is included only for a subagent that can mutate
 *  files and run git (its premise is "you know your own changes") and sits
 *  beside the turn-economy rules it extends. Which tools the child may call,
 *  its read-only rule, and shell safety follow in its opening turn from its
 *  first tool plan (`tool-notice.ts`), so they state the set its calls meet. */
export function buildSubagentTask(instructions: string, has: CapabilityCheck, maxTurns: number): string {
  const git = gitDisciplineRule(has);
  const sections = [subagentClosure(maxTurns, has("bash")), ...(git === undefined ? [] : [git]), SUBAGENT_HANDOFF_CONTRACT];
  const template = sections.join("\n\n");
  return instructions ? `${instructions}\n\n---\n\n${template}` : template;
}

// Styled after the compaction disclosures (LOCAL_COMPACTION_SUMMARY_PREFIX,
// <compactionSummary>): when the framework manipulates an agent's context, the
// explanation arrives in-band at the manipulation seam, not in the system
// prompt. For a fork the seam is the seeded trailing user turn: the copied
// history sits directly above it, so the disclosure and the assignment land
// together where the confusion would arise.
const FORK_ASSIGNMENT_PREFIX = `The conversation above is a copy of your parent agent's conversation up to the moment it dispatched you. The assistant turns in it are the parent's, not yours; it is included so you can act with the parent's full context. If it ends with an instruction to dispatch or delegate work, that dispatch already happened and produced you, and tools the parent used above (such as subagent or process) may not be available to you.

Your assignment from the parent is below. Work only on this assignment; do not resume or redo the parent's other work.

`;

export function forkAssignment(prompt: string): string {
  return `${FORK_ASSIGNMENT_PREFIX}${prompt}`;
}

export const SUBAGENT_HANDOFF_SCHEMA: HandoffToolSchema = {
  input: {
    type: "object",
    description: "Submit your result to the parent agent. Pass fields directly as top-level keys.",
    properties: {
      summary: { type: "string", description: "What was accomplished or found. Lead with conclusions: a handoff over the parent's budget is cut field by field to head and tail, with the full handoff saved to a file." },
      files_modified: { type: "array", items: { type: "string" }, description: "Files created or changed (empty for read-only work)." },
    },
    required: ["summary"],
    additionalProperties: true,
  },
};

interface SubagentValidationError {
  content: string;
  outcome: ToolOutcome;
}

/** The narrowed dispatch arguments, produced once at the validation boundary so
 *  the caller never re-derives them from the untyped `input` record. */
interface ValidatedDispatch {
  agentType: string;
  prompt: string;
  agent: AgentDefinition;
  fork: boolean;
}

export type DispatchValidation =
  | { ok: true; dispatch: ValidatedDispatch }
  | { ok: false; error: SubagentValidationError };

function invalidDispatch(problem: string): DispatchValidation {
  return {
    ok: false,
    error: {
      content: formatToolInputProblems("subagent", [problem]),
      outcome: "error",
    },
  };
}

/** Admit one dispatch. The dispatcher has already checked the declared fields
 *  and their types against the tool schema, so these checks hold only what a
 *  schema cannot state: a substantive rationale, a nonempty prompt, a
 *  registered persona, and its fork policy. Subagent grants alone decide which
 *  personas the registry holds (PI-AGENT-044). A name the registry does not
 *  hold is refused with `dispatchable`, the names the caller can dispatch, so
 *  the refusal offers no agent that cannot run. A refusal is a tool result, so
 *  it renders from `has`, the dispatcher's agent check (ARCH-CONTEXT-033),
 *  which holds every term where the call has no request surface. */
export function validateDispatchInput(
  input: DispatchInput,
  agentRegistry: ReadonlyMap<string, AgentDefinition>,
  dispatchable: readonly string[],
  has: CapabilityCheck = () => true,
): DispatchValidation {
  const { persona: agentType, rationale, prompt } = input;
  if (typeof rationale !== "string" || rationale.trim().length < MIN_DISPATCH_RATIONALE_LENGTH) {
    return invalidDispatch(`subagent was called without a substantive 'rationale' string (minimum ${MIN_DISPATCH_RATIONALE_LENGTH} characters). Briefly explain why this dispatch is worth doing in a subagent rather than inline: what specific question it answers, why the result wouldn't fit cleanly in your context, and what alternatives you considered. Terse rationales ('investigate', 'do the work') are rejected; the rationale is part of the dispatch decision, not a label.`);
  }
  if (typeof prompt !== "string" || !prompt) {
    return invalidDispatch(has("type:general")
      ? "subagent was called without a 'prompt' string. Unless you fork, the subagent has no access to your conversation; the 'prompt' must be a self-contained task description with the file paths, constraints, and task-specific context the subagent needs (global and project instructions are provided automatically)."
      : "subagent was called without a 'prompt' string. The 'prompt' must be a self-contained task description with the file paths, constraints, and task-specific context the subagent needs (global and project instructions are provided automatically).");
  }

  const agent = typeof agentType === "string" ? agentRegistry.get(agentType) : undefined;
  if (typeof agentType !== "string" || !agent) {
    return invalidDispatch(`No subagent registered as '${String(agentType)}'. Available persona values: ${dispatchable.join(", ") || "(none registered)"}. Pick one from the list, or omit subagent and do the work directly.`);
  }

  const fork = input.fork === true;
  if (fork && agent.kind === "persona" && agent.allowFork === false) {
    return invalidDispatch(`Subagent '${agentType}' does not accept forked conversation history. Send a self-contained prompt instead.`);
  }

  return { ok: true, dispatch: { agentType, prompt, agent, fork } };
}

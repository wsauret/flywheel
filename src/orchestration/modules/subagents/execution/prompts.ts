import type { AgentDefinition } from "../../../../infra/agent-definition.js";
import type { HandoffToolSchema } from "../../../workflow-host/handoff-tool-schema.js";
import type { ToolOutcome } from "../../../../infra/tool-outcome.js";
import { formatToolInputProblems } from "../../../agent-runtime/tools/validate-input.js";
import { gitDisciplineRule } from "../../../agent-runtime/persona-tool-rules.js";

interface DispatchInput {
  [key: string]: unknown;
}

/** The subagent catalog: which agent types this session may dispatch and when
 *  to use them. It varies with the `subagents` of a brief and a child's granted roles,
 *  so it renders in the session tier and the dispatch tool's own bytes stay
 *  the same for every agent that shares the prompt cache. */
export function renderSubagentRoster(agents: ReadonlyMap<string, AgentDefinition>): string {
  if (agents.size === 0) return "# Subagents\n\nNo agent type is available for you to dispatch here, so do the work directly.";
  const agentList = Array.from(agents.values())
    .map((a) => a.kind === "general"
      ? `- ${a.name}: ${a.description}\n  Tools: registry-approved tools derived from your current surface, plus child handoff and granted nested-role tools`
      : `- ${a.name} (role: ${a.role}): ${a.description}\n  Tools: ${a.tools.join(", ")}`)
    .join("\n");
  const personas = Array.from(agents.values()).filter((agent) => agent.kind === "persona");
  const roles = new Set(personas.map((agent) => agent.role));
  const useCases: string[] = [];
  if (roles.has("ship")) {
    useCases.push("- Repository publication: use the Ship agent after the parent has completed implementation, review, and verification. Do not use fork. Send only the files you changed and a short summary of user intent and implemented design. Use your tracked file list. Do not run Git analysis or prepare a commit message for this handoff. Do not send verification evidence or ask Ship to evaluate it. Ship inspects the selected diffs, writes the commit message, commits complete selected files, including concurrent edits, and pushes. Do not ask Ship to separate authorship, select hunks, or create isolation worktrees. Add publication instructions only when the user requested a PR or a nondefault destination. For a PR, also send what changed from the approved design, the proof that the change works, and what that proof does not cover, as you wrote them for your reply; that account is the one exception to the evidence rule, and Ship puts it in the pull request description as written, without assessing it. Ship returns publication evidence, or a summary of the one precise condition that stopped publication. After a successful publication, your reply gives the three things that your instructions define.");
  }
  if (roles.has("reviewer")) {
    useCases.push("- Review/analysis: use a reviewer agent for code review or plan evaluation.");
  }
  if (roles.has("advisor")) {
    useCases.push("- Advisor consultation: use the advisor when two materially different approaches remain plausible and project evidence does not decide between them; a consequential decision depends on an uncertain assumption; a focused attempt failed and the next diagnostic or implementation move is unclear; or an independent second opinion is needed before an expensive, risky, or difficult-to-reverse action. Do not use Advisor for factual lookup, keyword search, or repository discovery; an obvious or reversible local choice; implementation; or routine review of a finished diff or plan. A user-selected pre-approval design review is the narrow exception to the finished-plan restriction. Send a concise decision packet with the exact decision, relevant context and project authority, plausible alternatives, evidence that supports or weakens each alternative, prior attempts and what they ruled out, and the uncertainty that warrants consultation. Use fork: true only when accumulated conversation context is material evidence. Advisor returns private, read-only guidance; the parent owns the final decision, execution, verification, and user communication. Advisor failure or unavailability must not block the parent: continue with available evidence and do not retry or respawn solely for consultation.");
  }

  return `# Subagents

Available agent types:

${agentList}${useCases.length > 0 ? `\n\nWhen to use:\n${useCases.join("\n")}` : ""}`;
}

/** The fewest characters of trimmed `rationale` that a dispatch accepts. The
 *  tool schema declares it, and `validateDispatchInput` enforces it, because the
 *  dispatcher's central validator checks only structure. */
export const MIN_DISPATCH_RATIONALE_LENGTH = 30;

/** The dispatch tool's description, the same for every agent. The catalog it
 *  names renders in the session tier (`renderSubagentRoster`). */
export const SUBAGENT_DESCRIPTION = `Launch a specialized subagent to handle a focused subtask autonomously in an isolated context. Persona agent types have their declared tools and system prompt. The general agent uses your model and system instructions with a child tool surface derived by the runtime registry.

Selecting the agent (required): every dispatch MUST pass \`persona\` as the FIRST field; persona names which agent runs and has no default. Use a persona name from the Subagents catalog in your system prompt. If none fits the task, do the work directly instead of dispatching.

Each dispatch returns immediately. Results come to you, not to the user: the finished subagent arrives in a hidden <subagent_notifications> runtime message, not a message from the human user, reporting the current <remaining_active> count and a <handling> field to follow. Subagents that settle in the same event-loop turn share one batch.

Steering a running child: use message_session to revise its instructions. You can also ask it a question that blocks your work, or answer a question that it asked you. The child replies only when you ask it a question. Address its session_id; it reads the message at its next step. Controlling a child: the process tool lists your children by session_id and gives each child's state and progress. process(action='interrupt') cuts a running child so that its work can continue later. process(action='resume') continues your interrupted child from its saved conversation, or starts a new attempt of a child whose run failed. A message to your interrupted child also continues it. A child that a person interrupted continues only when a person continues it, and it stays your active work until it ends. A child that you or the runtime interrupted never blocks your handoff: do its work yourself, leave it, or continue it.

Writing the prompt:
The subagent has not seen your conversation. Give it the goal, relevant file paths, constraints, and the output format you want; a well-scoped task needs only a few sentences. State a length only when your own context budget demands one; by default the subagent sizes its report to what it finds.
When cwd targets a Git worktree, the parent keeps ownership of integrating and cleaning up that worktree.

The runtime records your approved checkpoint Design intent and Decisions in the child's conversation, read-only. Keep your checkpoint current before dispatch; do not copy its intent into the brief. Everything else in an implementation brief is implementation design the subagent may revise and must report.

Scope one dispatch to one phase, fix, or question; split multi-phase work into sequential dispatches sized to a subagent run. When the child must prove its own work, name the narrowest verification command; it runs once before handoff, and suite-level or project-wide gates are yours to run after you collect the result.

The exception is a dispatch with fork: true (any agent type): the child starts from a copy of your conversation, so its prompt is a directive - what to do - not a re-explanation of the situation.

Never delegate understanding. Do not write "based on your findings, fix the bug" or "based on the research, implement it." Prompts that prove you understood (specific file paths, line numbers, what to change) produce better work.

Rationale: explain why delegation is worthwhile (minimum ${MIN_DISPATCH_RATIONALE_LENGTH} characters); follow the parameter guidance.

The subagent's streaming output (text, tool calls) is visible to the user in real time.`;

/** Closure and turn-budget preamble. A function because the budget is the
 *  dispatched agent definition's maxTurns, not a constant of the template. */
function subagentClosure(maxTurns: number): string {
  return `# Delegated Subtask

You are executing a scoped subtask. Your parent agent dispatched you with a specific assignment.

## Closure

No planning, no TODO tracking, no progress updates, no meta-commentary. Execute the work, then call \`handoff\` to submit your result and terminate.

Your parent verifies your work after collecting your result. While working, run the narrowest check that proves each change: one test file, not a suite. Run a suite-level or project-wide gate at most once, immediately before handoff, and only when your assignment names that gate; otherwise leave final verification to your parent.

Before submitting: verify all requested deliverables are present, every claim is grounded in tool output, and no material lookup was skipped.

Stay within your assignment. Your parent may be running sibling subagents on adjacent work; if you notice something outside your scope, note it in your handoff rather than pursuing it.

Never re-run a failing test or command without changing code first. If a test fails and you cannot identify a fix, report the failure in your handoff rather than retrying with identical input.

## Turn Economy

Every model turn is a paid round-trip, and this run has a hard budget: at most ${maxTurns} turns, then it is cut off and unreported work is lost. Reserve the last turn for the handoff, and finish in the fewest turns honest work allows: each turn carries every independent read, edit, and check you already know you need, and fixes are batched before one narrow re-verification. A bash call that is only one \`cat\`, \`grep\`, or \`ls\` is rejected; bash is for scripts, pipelines, and multi-command chains.`;
}

const SUBAGENT_HANDOFF_CONTRACT = `## Handoff

When finished, you MUST call \`handoff\` exactly once with your structured result. This is your only way to return data to the parent. Do not put your result in plain text; the parent reads the handoff JSON, not your conversation. Pass these fields as top-level keys: \`summary\` (required), what you accomplished or found, with the conclusions first, because a handoff over budget is cut field by field to its head and tail and the full handoff goes to a file; and \`files_modified\`, the files you created or changed, empty for read-only work.

Your handoff is the result, not a replay of the run. For exploration, analysis, and review assignments, the report is the deliverable: include every material finding the assignment requested, with one claim per line and its \`file:line\` evidence. For implementation assignments, submit a concise completion record with the outcome, changed files, exact verification results, every material deviation from the assignment's stated approach (what it said, what you did instead, why, and the evidence), any work that is not done, and any parent action still required. Do not paste command output or replay the work log. In every handoff, omit preamble, process narration, repeated points, and restatement of the assignment.

When a choice that your tools cannot settle stops the work, such as a conflict with the approved design or with an explicit prohibition of the person, message your parent with message_session and wait for its reply. Your parent holds the design and asks the person when it must. Do not give up due to uncertainty or missing information obtainable via your tools.`;

/** Build the subagent addendum appended after the persona (or inherited
 *  parent) instructions. The result is the child runner's `task`, which the
 *  child receives as a turn of its conversation, not in its system prompt.
 *  `maxTurns` is the dispatched agent definition's turn cap, disclosed so the
 *  child can budget. Git discipline is included only for a subagent that can
 *  mutate files (its premise is "you know your own changes") and sits beside
 *  the turn-economy rules it extends. Which tools the child may call, its
 *  read-only rule, and shell safety follow in its opening turn from its
 *  first tool plan (`tool-notice.ts`), so they state the set its calls meet. */
export function buildSubagentTask(instructions: string, toolNames: readonly string[], maxTurns: number): string {
  const git = gitDisciplineRule(toolNames);
  const sections = [subagentClosure(maxTurns), ...(git === undefined ? [] : [git]), SUBAGENT_HANDOFF_CONTRACT];
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
 *  personas the registry holds (PI-AGENT-044). */
export function validateDispatchInput(
  input: DispatchInput,
  agentRegistry: ReadonlyMap<string, AgentDefinition>,
): DispatchValidation {
  const { persona: agentType, rationale, prompt } = input;
  if (typeof rationale !== "string" || rationale.trim().length < MIN_DISPATCH_RATIONALE_LENGTH) {
    return invalidDispatch(`subagent was called without a substantive 'rationale' string (minimum ${MIN_DISPATCH_RATIONALE_LENGTH} characters). Briefly explain why this dispatch is worth doing in a subagent rather than inline: what specific question it answers, why the result wouldn't fit cleanly in your context, and what alternatives you considered. Terse rationales ('investigate', 'do the work') are rejected; the rationale is part of the dispatch decision, not a label.`);
  }
  if (typeof prompt !== "string" || !prompt) {
    return invalidDispatch("subagent was called without a 'prompt' string. Unless you fork, the subagent has no access to your conversation; the 'prompt' must be a self-contained task description with the file paths, constraints, and task-specific context the subagent needs (global and project instructions are provided automatically).");
  }

  const agent = typeof agentType === "string" ? agentRegistry.get(agentType) : undefined;
  if (typeof agentType !== "string" || !agent) {
    const available = Array.from(agentRegistry.keys()).join(", ");
    return invalidDispatch(`No subagent registered as '${String(agentType)}'. Available persona values: ${available || "(none registered)"}. Pick one from the list, or omit subagent and do the work directly.`);
  }

  const fork = input.fork === true;
  if (fork && agent.kind === "persona" && agent.allowFork === false) {
    return invalidDispatch(`Subagent '${agentType}' does not accept forked conversation history. Send a self-contained prompt instead.`);
  }

  return { ok: true, dispatch: { agentType, prompt, agent, fork } };
}

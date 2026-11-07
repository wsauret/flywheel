import { ASK_USER_CANCELLED_RESULT, askUserLeadingContext, normalizeAskUserInput } from "../../../infra/tools/displays/ask-user.js";
import type { QuestionEntry } from "../../../infra/output-blocks.js";
import type { AskUserController, AskUserResult } from "../../runner/ask-user-controller.js";
import type { AgentInputDecision } from "../../session/agent-input-facts.js";
import type { AgentInputAnswers } from "../../../protocol/question-protocol-types.js";
import type { ResolveWorkflowLaunchTarget } from "../../workflow-host/launch-origin.js";
import { workflowLaunchDecision, workflowRefusalText } from "../../workflow-host/launch-origin.js";
import { workflowSource } from "../../../infra/tools/workflow-call-source.js";
import type { AdvertisedTool, RuntimeTool, ToolContext, ToolResult } from "./types.js";

interface AskUserInput {
  [key: string]: unknown;
}

const OPTION_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", description: "Option label shown to the user (1-5 words)." },
    description: { type: "string", description: "Optional one-sentence elaboration." },
    recommended: { type: "boolean", description: "Mark the suggested default; renderer surfaces a hint." },
    requires_text: { type: "boolean", description: "Require inline text when the user selects this option." },
  },
  required: ["label"],
  additionalProperties: false,
} as const;

const QUESTION_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "The question to ask, phrased so it stands on its own." },
    header: { type: "string", description: "Short chip label for the multi-question tab strip (max 12 chars)." },
    options: { type: "array", minItems: 1, items: OPTION_SCHEMA },
    multi_select: { type: "boolean", description: "Allow selecting more than one option." },
  },
  required: ["question", "options"],
  additionalProperties: false,
} as const;

const DEFINITION_OVERRIDE_DECISION_FIELD = {
  definition_override: {
    type: "object",
    properties: { preparation_id: { type: "string" } },
    required: ["preparation_id"],
    additionalProperties: false,
  },
} as const;

const WORKFLOW_LAUNCH_DECISION_FIELD = {
  workflow_launch: {
    type: "object",
    description: "Ask the user to approve one workflow launch. The runtime composes the question and its choices from the workflow file; an approved answer returns the confirmation_id the workflow call must carry.",
    properties: {
      source: {
        type: "object",
        description: "The source this launch would start, exactly as the workflow call names it.",
        properties: {
          kind: { type: "string", enum: ["path", "content"] },
          path: { type: "string", description: "Required when kind is path: the workflow file." },
          content: { type: "string", description: "Required when kind is content: the YAML text of the workflow file, which Flywheel saves as the launch does." },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
} as const;

/** The typed decisions available in this session. A decision kind appears only
 *  when its surface exists, and a session with no decision kind advertises no
 *  `decision` property at all rather than an empty shell. */
function decisionSchema(deps: AskUserToolDeps): AskUserInput | undefined {
  const properties = {
    ...(deps.definitionOverrideProposal === undefined ? {} : DEFINITION_OVERRIDE_DECISION_FIELD),
    ...(deps.workflowLaunch === undefined ? {} : WORKFLOW_LAUNCH_DECISION_FIELD),
  };
  if (Object.keys(properties).length === 0) return undefined;
  return {
    type: "object",
    description: "Bind this question to one typed decision. Name exactly one decision kind.",
    properties,
    additionalProperties: false,
  };
}

function askUserInputSchema(deps: AskUserToolDeps): AskUserInput {
  const decision = decisionSchema(deps);
  return {
    type: "object",
    properties: {
      question: { type: "string", description: "Single-question shorthand for `questions[0].question`." },
      header: { type: "string", description: "Single-question shorthand for `questions[0].header`." },
      options: { type: "array", minItems: 1, items: OPTION_SCHEMA },
      multi_select: { type: "boolean" },
      context: { type: "string", description: "REQUIRED: everything the user needs to answer, addressed to the user. It renders as your reply text above the question and is the only text guaranteed to reach the user: prose elsewhere in your turn can land in thinking, which the user never sees. When the question decides a proposal, plan, or design, put the complete proposal in this field, not a caption of it. Never reference material the user has not received as a committed message, such as 'the design above' or 'as before'." },
      questions: { type: "array", minItems: 1, maxItems: 5, items: QUESTION_SCHEMA },
      ...(decision === undefined ? {} : { decision }),
    },
    required: ["context"],
    additionalProperties: false,
  };
}

/** When a chat agent may ask through the decision UI. Both chat prompts and this tool's description state it. */
export const ASK_USER_DISCUSSION_RULE = "While the user is asking questions or discussing, reply in prose and keep the discussion going. Do not call `ask_user` then. Use `ask_user` only after the discussion has settled on something, to get a final confirmation or a decision you cannot make yourself.";

const ASK_USER_BASE: Pick<RuntimeTool, "name" | "action" | "description" | "promptSnippet" | "unboundedDuration" | "isConcurrencySafe" | "deferUntilAssistantCommitted"> = {
  name: "ask_user",
  action: "ask_user",
  description: [
    "Ask the user a multiple-choice question when their decision is required before continuing.",
    ASK_USER_DISCUSSION_RULE,
    "Once you need that answer before you can continue, call this tool in the same turn as your explanation. Do not end that turn with a prose request for the user to reply.",
    "Before you ask, start all work that does not depend on the answer, so that the wait for the user does not hold it.",
    "The user never sees your thinking, and reply prose can silently land in thinking; the required `context` field is the only guaranteed-visible carrier. It renders as your reply text above the question and must contain everything the user needs to answer, including the complete proposal, plan, or tradeoffs being decided, never a caption pointing at material outside a committed message.",
    "Do not use for preferences you can decide safely.",
    "Do NOT include an \"Other\" option; the UI always appends one.",
    "Set `requires_text: true` when selecting a named option must include inline text.",
    "If you recommend a default, put it first and set `recommended: true`.",
    "For multi-question forms, give each question a short `header` (≤12 chars) for the navigation chips.",
  ].join(" "),
  promptSnippet: "Ask the user for a required decision",
  // Legitimately blocks on a human, which can take far longer than any
  // other tool call; the dispatcher's generic inactivity watchdog would
  // otherwise kill a question the user simply hasn't answered yet.
  unboundedDuration: true,
  // Doesn't mutate shared state; runs freely alongside anything else.
  isConcurrencySafe: true,
  deferUntilAssistantCommitted: true,
};

const ASK_USER_NEEDS_VISIBLE_TEXT =
  "This question was not shown: the turn that asked it carried no visible reply text, and the user never sees your thinking. Call ask_user again with the `context` field set to everything the user needs to answer, addressed to the user, including the complete proposal or plan being decided; it renders as your reply text above the question and is the only text guaranteed to reach the user. An identical retry without `context` or visible text fails again.";

/** Render one answer set as the model reads it, one line for each question
 *  the call asked. A question without an answer is one the person skipped. */
function formatAskUserAnswers(request: readonly QuestionEntry[], answers: AgentInputAnswers): string {
  const lines = request.map(({ question }) => `- ${question}: ${answers[question]?.text ?? "(cancelled by the user)"}`);
  return `User answered:\n${lines.join("\n")}`;
}

export type AnsweredAskUserResult =
  | { readonly content: string; readonly outcome: "ok" }
  | { readonly content: string; readonly outcome: "cancelled" };

/** The result of a launch approval that an earlier build asked for a workflow
 *  named by id. No answer grants a launch: the named workflow is retired.
 *  Remove after 2027-04-30. */
export function retiredWorkflowLaunchText(definitionId: string): string {
  return `The ${definitionId} workflow is retired. Flywheel no longer launches it.`;
}

/** Build the model-visible result from the durable answer authority. Only the
 *  decision's one exact approving choice returns a usable confirmation id. */
export function answeredAskUserResult(
  request: readonly QuestionEntry[],
  answers: AgentInputAnswers,
  decision: AgentInputDecision | undefined,
  confirmationId: string,
): AnsweredAskUserResult {
  const content = formatAskUserAnswers(request, answers);
  if (!decision) return { content, outcome: "ok" };
  if (decision.kind === "workflow_launch" && decision.source.kind === "registered") {
    return { content: `${content}\n\n${retiredWorkflowLaunchText(decision.source.definitionId)}`, outcome: "cancelled" };
  }
  const answer = answers[decision.question];
  const approved = answer?.kind === "choice"
    && answer.selections.length === 1
    && answer.selections[0]?.choiceId === decision.approve.choiceId;
  return approved
    ? { content: `${content}\n\nConfirmation id for this decision: ${confirmationId}`, outcome: "ok" }
    : { content: `${content}\n\nThe user did not approve this decision.`, outcome: "cancelled" };
}


export interface AskUserToolDeps {
  /** Resolves the workflow file one launch approval names. Wired only
   *  while Workflows is in ASK, which is the only mode where a launch needs an
   *  approval to carry. */
  workflowLaunch?: ResolveWorkflowLaunchTarget;
  definitionOverrideProposal?: (preparationId: string) => { readonly summary?: string } | undefined;
}

/** The ask_user tool with no typed decision bound to it. An agent that
 *  cannot ask the person advertises this form, so it names no decision
 *  surface of its own. */
export const ASK_USER_TOOL_DEFINITION: AdvertisedTool = { ...ASK_USER_BASE, inputSchema: askUserInputSchema({}) };

export function createAskUserTool(controller: AskUserController, deps: AskUserToolDeps): RuntimeTool {
  return {
    ...ASK_USER_BASE,
    inputSchema: askUserInputSchema(deps),
    prepareAdmission: async input => {
      let changed = false;
      const options = (value: unknown) => {
        if (!Array.isArray(value)) return value;
        return value.map(option => {
          if (typeof option !== "string") return option;
          changed = true;
          return { label: option };
        });
      };
      const repaired = {
        ...input,
        ...(input.options === undefined ? {} : { options: options(input.options) }),
        ...(Array.isArray(input.questions) ? { questions: input.questions.map(question =>
          typeof question === "object" && question !== null && !Array.isArray(question)
            ? { ...question, ...("options" in question && Object.hasOwn(question, "options") ? { options: options(question.options) } : {}) }
            : question) } : {}),
      };
      return changed ? { repair: { input: repaired, notice: "Note: string options were read as option labels." } } : {};
    },
    async execute(input: AskUserInput, context: ToolContext): Promise<ToolResult> {
      const bound = await resolveDecision(input, deps);
      if (bound && "error" in bound) return { content: bound.error, outcome: "error" };
      // Every question depends on visible explanation the user can read:
      // either the turn's committed reply text or the call's own `context`
      // field, which renders as reply text above the question. This includes
      // bound decisions: Flywheel composes their question text, but the
      // agent's own reasoning for asking now must still reach the user, or a
      // launch approval arrives with no visible reply at all. When neither
      // exists (the prose lived in thinking), reject before recording so the
      // model re-asks with context instead of the user meeting a bare question.
      if (askUserLeadingContext(input) === undefined && context.turnHasVisibleText?.() === false) {
        return { content: ASK_USER_NEEDS_VISIBLE_TEXT, outcome: "error" };
      }
      const normalized = bound ? { success: true as const, questions: [bound.question] } : normalizeAskUserInput(input);
      if (!normalized.success) return { content: normalized.message, outcome: "error" };
      const request = normalized.questions.map((question) => ({
        ...question,
        choices: question.choices.map((choice) => {
          if (choice.kind === "freeform") return choice
          if (!choice.choiceId) throw new Error("Ask User normalization omitted a choice id.")
          return { ...choice, choiceId: choice.choiceId }
        }),
      }))
      const toolUseId = context.toolUseId;
      if (!toolUseId) return { content: "Ask User requires a tool call id.", outcome: "error" };
      if (!context.sessionEventWriter || !context.conversationId) {
        return { content: "Ask User requires durable session context.", outcome: "error" };
      }
      try {
        const stored = await context.sessionEventWriter.record({
          type: "agent_input.requested",
          version: 3,
          actor: "agent",
          payload: {
            interactionId: toolUseId,
            conversationId: context.conversationId,
            toolUseId,
            request,
            ...(bound ? { decision: bound.decision } : {}),
          },
        });
        if (!stored) return { content: "Ask User could not save the question.", outcome: "error" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: `Ask User could not save the question: ${message}`, outcome: "error" };
      }

      const result: AskUserResult = await controller.ask(toolUseId, [...normalized.questions], context.signal);
      if (result.kind === "suspended") return { content: "", outcome: "interrupted", suspendTurn: true };
      if (result.kind === "cancelled") {
        // "cancelled", not "error": the user declined, nothing failed. The
        // model still sees is_error so it never treats this as an answer.
        return { content: ASK_USER_CANCELLED_RESULT, outcome: "cancelled" };
      }
      return answeredAskUserResult(request, result.answers, bound && !("error" in bound) ? bound.decision : undefined, toolUseId);
    },
  };
}

type BoundDecision = { decision: AgentInputDecision; question: QuestionEntry } | { error: string };
interface DefinitionOverrideDecisionInput {
  preparation_id?: string;
}

interface WorkflowLaunchDecisionInput {
  source?: unknown;
}


/** Bind this question to the one typed decision it decides. The model names the
 *  kind and the intent; every word the user reads and every stable choice id
 *  comes from Flywheel's own record of what that intent is. */
async function resolveDecision(input: AskUserInput, deps: AskUserToolDeps): Promise<BoundDecision | undefined> {
  const raw = input.decision;
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) return { error: "decision must be an object naming one decision kind." };
  if ("definition_override" in raw && raw.definition_override !== undefined) {
    if (typeof raw.definition_override !== "object" || raw.definition_override === null) return { error: "definition_override requires preparation_id." };
    return resolveDefinitionOverrideDecision(raw.definition_override, deps.definitionOverrideProposal);
  }
  if ("workflow_launch" in raw && raw.workflow_launch !== undefined) {
    if (typeof raw.workflow_launch !== "object" || raw.workflow_launch === null) return { error: "workflow_launch must be an object with source." };
    return await resolveWorkflowLaunchDecision(raw.workflow_launch, deps.workflowLaunch);
  }
  return { error: "decision requires one decision kind." };
}

function resolveDefinitionOverrideDecision(raw: DefinitionOverrideDecisionInput, resolve: AskUserToolDeps["definitionOverrideProposal"]): BoundDecision {
  if (!resolve) return { error: "This session has no definition override proposal surface." };
  if (typeof raw.preparation_id !== "string" || !raw.preparation_id) return { error: "definition_override requires preparation_id." };
  const preparationId = raw.preparation_id;
  const proposal = resolve(preparationId);
  if (!proposal?.summary) return { error: `No prepared definition override ${preparationId}. Prepare it again.` };
  const question = `Apply this definition override resolution?\n\n${proposal.summary}`;
  const approve = { choiceId: "approve", label: "Approve the override resolution" } as const;
  const reject = { choiceId: "reject", label: "Reject the override resolution" } as const;
  return {
    decision: { kind: "definition_override", preparationId, question, approve, reject },
    question: { question, header: "Override", choices: [{ kind: "option", ...approve }, { kind: "option", ...reject }, { kind: "freeform", label: "Other" }], multiSelect: false },
  };
}

/** Compose the launch approval of one source. The model names only the
 *  source; Flywheel resolves it and owns the question and choices, so an
 *  approval can only authorize that workflow file as it is now. */
async function resolveWorkflowLaunchDecision(launch: WorkflowLaunchDecisionInput, workflowLaunch: ResolveWorkflowLaunchTarget | undefined): Promise<BoundDecision> {
  if (workflowLaunch === undefined) return { error: "This session does not ask before launching a workflow, so a workflow_launch decision is not available. Call workflow directly." };
  const source = workflowSource(launch.source);
  if (source === undefined) return { error: "workflow_launch requires source with kind 'path' and a path, or kind 'content' and content." };
  const target = await workflowLaunch(source);
  if ("error" in target) return { error: workflowRefusalText(target) };
  const launchDecision = workflowLaunchDecision(target);
  return {
    decision: { ...launchDecision.decision, kind: "workflow_launch" },
    question: {
      ...launchDecision.question,
      choices: launchDecision.question.choices.map((choice) => choice.kind === "option"
        ? { ...choice, kind: "option" }
        : { ...choice, kind: "freeform" }),
    },
  };
}

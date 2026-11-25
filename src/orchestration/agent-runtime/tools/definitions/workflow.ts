import {
  createWorkflowToolCore,
  type LaunchableWorkflowToolDeps,
} from "./workflow-tool.js";
import type { RuntimeTool, RuntimeToolInput } from "../types.js";
import type { CapabilityCheck } from "../../../../infra/capability-text.js";
import type { ModuleRuntimeInvocationTool } from "../../../module-contract/module-seams.js";

const LAUNCH_DESCRIPTION = "Launch a workflow as a background child of this chat. It keeps running when this chat is interrupted, and its completion or Stop delivers one hidden runtime notification.";

const fileDescription = (has: CapabilityCheck): string => `${LAUNCH_DESCRIPTION} It launches a workflow file that you wrote.

Write a workflow file for substantive work that needs its own phases, agent mix, verification, or synthesis. A workflow file runs at least two agents, and a later agent reads the output of an earlier one${has("subagent") ? "; dispatch one agent, or agents that can all run at the same time, as subagents instead" : ""}. Read a result yourself when you must judge it against the design. A result that you would read only to brief the next agent belongs inside the workflow, passed with \`reads\`. When several units each need the same chain, such as build, review, and fix, and you revise, commit, or unblock each unit on its own, write the file once with an \`input\` contract and launch it by path for each unit with that unit as \`input\`. When you read the results of all units together, run one workflow over the list instead.

Launch a workflow file that you write in one call: workflow({ source: { kind: "content", content }, summary, description, input }). Flywheel saves the content as scratch/workflows/<id>.workflow.yaml in this session's directory, replacing a file of that name, and launches the saved file. Name a saved file with { kind: "path", path } to launch it again or after you edit it. A path can name any workflow file, also one in the project, so do not read a file only to pass its content. The launch decodes, admits, and verifies the file before any agent starts; a refused launch starts nothing, keeps the saved file, and lists each problem. Before you write a workflow file, load the \`workflow-authoring\` skill. The workflow card shows names: keep each phase and agent name to at most 10 characters, such as \`verify\`, and give a phase over a list of objects a \`label\` that names a short field of each item, such as \`path\`, or its agents show only as numbers.`;

const ASK_GUIDANCE = "Workflows needs the user's typed approval for every launch you start. Call `ask_user` with `decision: { workflow_launch: { source } }`, naming the same `source` as the `workflow` call, plus a `context` paragraph for the user. The runtime composes that question and its choices from the workflow file, so do not write approval options of your own. When you would ask the user whether to launch, make that ask the decision ask; do not ask a plain question first and a decision question second. An approved answer returns a confirmation id; pass it as `confirmation_id` when you call `workflow`. The approval covers that one source and is consumed by one launch. An approval of a workflow file covers the file as it was when you asked; after an edit, ask again.";
const ON_GUIDANCE = "Workflows is On for this session. Call `workflow` directly without asking for workflow-launch confirmation.";

const CONFIRMATION_ID_DESCRIPTION = "The confirmation id that the approved workflow_launch decision of this source returned.";

/** How one schema carries `confirmation_id`: ASK advertises it as required,
 *  ON advertises no such field, and dispatch validates every call against the
 *  schema that accepts it as optional. A call planned under one mode can land
 *  under another, so the workflow controller, which reads the live mode,
 *  answers it rather than a generic unexpected-parameter error. */
type ConfirmationField = "required" | "accepted" | "omitted";

function sourceSchema(): RuntimeToolInput {
  return {
    type: "object",
    description: "A path ends in .workflow.yaml and is absolute, or relative to your working directory and then to the session directory.",
    properties: {
      kind: { type: "string", enum: ["path", "content"] },
      path: { type: "string", description: "Required when kind is path: the workflow file to launch." },
      content: { type: "string", description: "Required when kind is content: the YAML text of the workflow file." },
    },
    required: ["kind"],
    additionalProperties: false,
  };
}

function workflowInputSchema(confirmation: ConfirmationField): RuntimeToolInput {
  return {
    type: "object",
    // The summary precedes the source so that it streams first: it titles
    // the run's card, and a workflow file's content can take seconds.
    properties: {
      summary: {
        type: "string",
        description: "Short user-facing title for this workflow run, usually 2-6 words.",
      },
      source: sourceSchema(),
      description: {
        type: "string",
        description: "Background that every agent reads beside its brief, not its task: the goal, the files, acceptance criteria, and constraints that the briefs and input do not hold, and any binding documents under PROJECT CONTEXT PATHS. It must be self-contained: the workflow has no access to your chat history. Point to earlier results by scratch file path or pass them as `input` instead of pasting them.",
      },
      cwd: {
        type: "string",
        description: "Optional child working directory. Relative paths resolve from this session's execution directory; absolute paths are accepted.",
      },
      input: {
        type: "object",
        description: "The launch input: one inline JSON object that matches the file's `input` contract. Pass a list that a phase runs `over` inline, never as a file path that an agent reads back. A phase over an empty list runs no agents; declare `min: 1` on a list that must not be empty, and the launch refuses an empty one. To give agents a long prose document, such as a design, write it to a file in your scratch directory and pass its absolute path in a string field that the briefs tell agents to read. Omit it when the file declares no input contract.",
      },
      ...(confirmation === "omitted" ? {} : { confirmation_id: { type: "string", description: CONFIRMATION_ID_DESCRIPTION } }),
    },
    required: confirmation === "required"
      ? ["source", "summary", "description", "confirmation_id"]
      : ["source", "summary", "description"],
  };
}

/** The workflow tool's identity, which a runtime invocation's call shares
 *  with a model's call, so the kernel reads both as one tool's call. */
export const WORKFLOW_RUNTIME_INVOCATION_TOOL: ModuleRuntimeInvocationTool = {
  name: "workflow",
  execution: { mode: "background", traceKind: "subagent", childHasOwnViewport: true },
  input(operation) {
    // Recorded runtime launches still render their original cards. Remove after 2027-04-30.
    if (operation.kind === "launch") {
      return {
        source: { kind: "registered", definition_id: operation.input.workflowDefinitionId },
        ...(operation.input.summary ? { summary: operation.input.summary } : {}),
        description: operation.input.description,
        ...(operation.input.launchCwd ? { cwd: operation.input.launchCwd } : {}),
      };
    }
    return {
      workflow_session_id: operation.workflowSessionId,
      // A version-1 adoption recorded no words; its card shows the tool name.
      ...("workflowDefinitionId" in operation ? {
        source: { kind: "registered", definition_id: operation.workflowDefinitionId },
        ...(operation.summary ? { summary: operation.summary } : {}),
      } : {}),
    };
  },
};

const WORKFLOW_BASE: Pick<RuntimeTool, "name" | "action" | "execution" | "isConcurrencySafe"> = {
  name: WORKFLOW_RUNTIME_INVOCATION_TOOL.name,
  action: "ui_meta",
  execution: WORKFLOW_RUNTIME_INVOCATION_TOOL.execution,
  isConcurrencySafe: true,
};


/** The workflow tool of one request. Its advertised schema and guidance are the
 *  mode's own: the provider never sees a `confirmation_id` field whose
 *  requirement changes behind one static signature. Its description renders
 *  from `capabilities`, the tree check, so every agent of a tree reads one text. */
export function createWorkflowTool(deps: LaunchableWorkflowToolDeps & { readonly capabilities: CapabilityCheck }): RuntimeTool {
  const core = createWorkflowToolCore(deps);
  const promptGuidelines = [...core.promptGuidelines];
  if (deps.mode === "on") promptGuidelines.push(ON_GUIDANCE);
  else if (deps.askUserAvailable) promptGuidelines.push(ASK_GUIDANCE);
  return {
    ...WORKFLOW_BASE,
    description: fileDescription(deps.capabilities),
    inputSchema: workflowInputSchema(deps.mode === "ask" ? "required" : "omitted"),
    inputValidationSchema: workflowInputSchema("accepted"),
    promptGuidelines,
    execute: (input, context) => core.execute(input, {
      toolUseId: context.toolUseId,
      modelRequestId: context.modelRequestId,
      parentToolUseId: context.parentToolUseId,
      conversationId: context.conversationId,
      ...(context.capabilityAccess ? { capabilityAccess: context.capabilityAccess } : {}),
    }),
  };
}

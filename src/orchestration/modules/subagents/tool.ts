import { createSubagentDispatch } from "./execution/tool.js";
import { MIN_DISPATCH_RATIONALE_LENGTH, subagentDescription } from "./execution/prompts.js";
import type { CapabilityCheck } from "../../../infra/capability-text.js";
import type { SubagentDispatchDeps } from "./execution/dispatch-deps.js";
import { summarizeSubagentWork } from "./execution/summarize-work.js";
import { SUBAGENT_SUMMARY_ROLE_ID } from "../../config/roles.js";
import type { AdvertisedTool, RuntimeTool } from "../../agent-runtime/tools/types.js";
import type { SubagentContext, SubagentResult } from "./execution/control-actions.js";

// The tool only dispatches: `process` controls a child after its launch.
// The dispatcher's central validator reports missing fields and types from
// this schema; validateDispatchInput enforces what a schema cannot state.
// Its text renders from the tree check `has`, so every agent of a tree reads
// the same bytes. `fork` copies the dispatcher as the general agent does, so
// the schema offers it only while `has` offers the general agent; a closed
// schema then refuses a `fork` field (ARCH-CONTEXT-033).
function subagentInputSchema(has: CapabilityCheck) {
  return {
    type: "object",
    properties: {
      persona: {
        type: "string",
        description: "Put first. One agent type from the Subagents catalog. If none fits, do the work directly.",
      },
      description: {
        type: "string",
        description: "3 to 5 word task label, shown as the subagent's goal.",
      },
      rationale: {
        type: "string",
        minLength: MIN_DISPATCH_RATIONALE_LENGTH,
        description: "One or two sentences: the question this dispatch answers, why its result should not fill your own context, and the alternatives you considered.",
      },
      prompt: {
        type: "string",
        minLength: 1,
        description: "The task brief.",
      },
      ...has("type:general") ? {
        fork: {
          type: "boolean",
          description: "Copy your conversation into the child, so 'prompt' is only a directive. It re-sends your full context as input tokens: fork only when the task needs that context.",
        },
      } : {},
      cwd: {
        type: "string",
        description: "Child working directory; a relative path resolves from yours.",
      },
    },
    required: ["persona", "rationale", "prompt"],
  }
}

const subagentPromptGuidelines = (has: CapabilityCheck): string[] => [
  "Delegate when a task would need 3+ lookups, spans 2+ subsystems you have not read yet, or its intermediate output is not worth keeping in your context. Do not delegate work a single lookup would cover.",
  has("type:general")
    ? "A question about what an external service returns, which endpoints exist, or how a dependency or the runtime behaves is not a lookup: it needs an experiment against the real thing, which a read-only agent cannot run. Run it inline or dispatch general."
    : "A question about what an external service returns, which endpoints exist, or how a dependency or the runtime behaves is not a lookup: it needs an experiment against the real thing, which a read-only agent cannot run. Run it inline.",
  "Do not also investigate a question that you delegated, except to check an audit or a review independently and reconcile both results.",
  "After dispatching, continue independent work. Never fill the gap with busywork, re-reading known files, or status chatter.",
]

/** The dispatch tool as the model sees it under the tree check `has`, the same bytes for every agent of the tree. */
export function subagentToolDefinition(has: CapabilityCheck, unattendedChat: boolean): AdvertisedTool {
  return {
    name: "subagent",
    action: "task_subagent",
    description: subagentDescription(has, unattendedChat),
    promptGuidelines: subagentPromptGuidelines(has),
    inputSchema: subagentInputSchema(has),
    execution: { mode: "background", traceKind: "subagent", childHasOwnViewport: true },
    // execute() itself only launches and returns a deferCompletion ack; the
    // actual subagent work runs independently with its own stall watchdog.
    isConcurrencySafe: true,
  }
}

export function createSubagentTool(deps: SubagentDispatchDeps, has: CapabilityCheck, unattendedChat: boolean): RuntimeTool {
  const dispatch = createSubagentDispatch({ ...deps, failureSummarizerForChild: childFailureSummarizer(deps) });
  // ToolContext structurally satisfies the narrower SubagentContext.
  return subagentToolWith(dispatch.execute, has, unattendedChat);
}

/** The dispatch tool under the tree check `has` with the given handler behind it. */
export function subagentToolWith(execute: RuntimeTool["execute"], has: CapabilityCheck, unattendedChat: boolean): RuntimeTool {
  return { ...subagentToolDefinition(has, unattendedChat), execute };
}

/** The Resume of a child, from its parent's `process` call or a person's
 *  control: the dispatch path continued from the child's saved run, entered
 *  without a new parent tool call. */
export function createSubagentResume(deps: SubagentDispatchDeps): (childSessionId: string, context: SubagentContext) => Promise<SubagentResult> {
  return createSubagentDispatch({ ...deps, failureSummarizerForChild: childFailureSummarizer(deps) }).resume;
}

function childFailureSummarizer(deps: SubagentDispatchDeps): NonNullable<SubagentDispatchDeps["failureSummarizerForChild"]> {
  return ({ sessionId, conversationId, projectRoot, executionCwd, eventWriter, reader, capabilityAccess }) => (records, terminalError, signal) => summarizeSubagentWork({
    records,
    terminalError,
    createRunner: deps.createRunner,
    runnerOptions: async () => {
      const treeRoot = (await deps.inheritableRuntimeSurfaces.sessions?.identity(sessionId))?.rootSessionId;
      return {
        projectRoot,
        executionCwd,
        userDataRoot: deps.userDataRoot,
        accountHome: deps.accountHome,
        resolveRoles: deps.resolveRoles,
        requestSelection: (roles) => ({ roleId: SUBAGENT_SUMMARY_ROLE_ID, ...roles.get(SUBAGENT_SUMMARY_ROLE_ID) }),
        ...(deps.captureProviderConnection ? { captureProviderConnection: deps.captureProviderConnection } : {}),
        moduleSelection: deps.moduleSelection,
        captureRuntimeConfig: deps.captureRuntimeConfig,
        awaitModelAccessSettled: deps.awaitModelAccessSettled,
        runtimeSurfaces: {},
        capabilityAccess,
        memorySnapshot: null,
        ...(deps.usageProfile ? { usageProfile: deps.usageProfile } : {}),
        ...(treeRoot === undefined ? {} : { treeRootSessionId: treeRoot }),
      };
    },
    child: { sessionId, conversationId, writer: eventWriter, reader },
    ...(signal ? { signal } : {}),
  });
}

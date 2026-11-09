import { createRuntimeEvent } from "../../../infra/runtime-event-factory.js";
import { asRecord } from "../../../infra/record.js";
import type { RuntimeEvent } from "../../../infra/runtime-event-types.js";
import { textField } from "../../../infra/output/json-field.js";
import { workflowCallSource, workflowSource, workflowSourceLabel, type WorkflowCallSource, type WorkflowLaunchSource } from "../../../infra/tools/workflow-call-source.js";
import type { ToolOutcome } from "../../../infra/tool-outcome.js";
import type { AgentFailureDisplay } from "../../../infra/output-blocks.js";
import type { BackgroundKillSource, BackgroundWorkResult, ChildInterruption } from "../background-work.js";
import type { WorkflowsMode } from "../../../protocol/module-protocol-types.js";
import {
  NO_WORKFLOW_DIRECTORY,
  type ModelWorkflowLaunchContext,
  type ModelWorkflowLaunchIntent,
  type ResolveWorkflowLaunchTarget,
  type WorkflowLaunchConfirmation,
  type WorkflowLaunchRefusal,
  workflowRefusalText,
} from "../../workflow-host/launch-origin.js";
import { stageWorkflowSource, type LaunchingSessionAuthority } from "../../workflow-host/path-workflow.js";
import type { VerificationUncertaintyKind, WorkflowVerificationResult } from "../../../workflows/vm/verify-types.js";
import type { WorkflowAgentModels } from "../../config/workflow-agent-models.js";

import type { CapabilityAccess, RuntimeToolInput } from "./types.js";
/** Result of an atomic workflow aggregate publication. The parent is the
 * invocation-owning chat, not a workflow/session alias. */
export interface PublishedWorkflowLaunch {
  workflowId: string;
  parentSessionId: string;
  done: Promise<BackgroundWorkResult>;
  /** The launch's one Stop, the same settlement a person's Stop reaches
   *  through the child's durable binding. `done` then answers from the Stop
   *  that the parent's call records, naming who stopped it. */
  terminate: (source: BackgroundKillSource) => Promise<void>;
  /** Who interrupted the workflow now. A workflow that this parent or the
   *  runtime interrupted is not active work, so no wait of the parent parks
   *  on it and no handoff waits for it. A person's interrupt leaves it the
   *  parent's active work (PI-AGENT-025). */
  interruption: ChildInterruption;
  /** What a launch of a workflow file states about the file it started. */
  workflowFile?: LaunchedWorkflowFile;
  /** The model and effort that the launch bound for its agents. */
  stepModels: WorkflowAgentModels;
}

/** The file one path launch started, as the launching agent reads it: the
 *  run's provenance, its definition identity, the verifier's result, the
 *  most attempts the run can queue, and what the launch warned about, one
 *  short located line each. */
interface LaunchedWorkflowFile {
  readonly path: string;
  readonly definitionSha256: string;
  readonly verification: WorkflowVerificationResult;
  readonly verificationUncertainties: readonly VerificationUncertaintyKind[];
  readonly worstCaseAttempts: number;
  readonly warnings: readonly string[];
}

/** One model-originated launch: the intent the model stated plus the call
 *  context the tool attests. The host that owns the runner stamps the trusted
 *  origin variant, so the model cannot present itself as explicit user intent. */
export interface ModelWorkflowLaunch extends ModelWorkflowLaunchIntent {
  readonly model: ModelWorkflowLaunchContext;
  /** The structured launch input as the call passed it. The launch decodes
   *  it against the workflow's input contract. */
  readonly input?: unknown;
}

export type StartModelWorkflow = (launch: ModelWorkflowLaunch) => Promise<PublishedWorkflowLaunch | WorkflowLaunchRefusal>;

export interface WorkflowToolDeps {
  startWorkflow: StartModelWorkflow;
  onRenderEvent: (event: RuntimeEvent) => void;
  /** Workflows mode of the request this tool was planned for. The planner omits
   *  the tool when Workflows is off, so an advertised tool always carries a
   *  launchable mode and the advertised schema matches that mode exactly. The
   *  mode shapes only what the model is told: the workflow controller reads
   *  the live mode at the call and is the one authority on approval. */
  mode: WorkflowsMode;
  /** The source an ASK approval question is composed from. Read by the
   *  `ask_user` planner, which owns that question. */
  resolveLaunchTarget: ResolveWorkflowLaunchTarget;
  /** The absolute path of this session's directory, or absent for a
   *  session without one, which launches no file. */
  sessionDir?: string;
  /** The agent's working directory, from which a relative workflow file path resolves first. */
  executionCwd: string;
}

/** Workflow deps of a mode that can actually launch. Only these build a tool.
 *  `authority` is what the calling session's planned tools hold, which a
 *  workflow file may grant its agents. */
export type LaunchableWorkflowToolDeps = Omit<WorkflowToolDeps, "mode"> & {
  readonly mode: "ask" | "on";
  readonly askUserAvailable: boolean;
  readonly authority: LaunchingSessionAuthority;
};

export interface WorkflowToolResult {
  content: string;
  outcome: ToolOutcome;
  deferCompletion?: boolean;
  details?: { readonly agentFailure: AgentFailureDisplay };
}

/** Trusted context of one model `workflow` call. The tool attests it; it never
 *  reads identity out of the model's own input. */
interface WorkflowToolCallContext {
  readonly toolUseId?: string;
  readonly modelRequestId?: string;
  readonly parentToolUseId?: string;
  readonly conversationId?: string;
  readonly capabilityAccess?: CapabilityAccess;
}

interface WorkflowToolDefinition<Result> {
  name: string;
  promptGuidelines: readonly string[];
  execute: (input: RuntimeToolInput, context: WorkflowToolCallContext) => Promise<Result>;
}

function taskSummary(input: RuntimeToolInput): string | undefined {
  return textField(input, "summary") ?? textField(input, "task_summary") ?? undefined;
}

export function decorateWorkflowToolCall<T extends { name: string; input: RuntimeToolInput }>(
  toolCall: T,
): T {
  if (toolCall.name !== "workflow") return toolCall;
  const source = workflowCallSource(toolCall.input);
  const workflowName = source === undefined ? "Workflow" : workflowSourceLabel(source);
  const summary = taskSummary(toolCall.input);
  return {
    ...toolCall,
    input: {
      ...toolCall.input,
      workflow_display_name: workflowName,
      ...(summary ? { summary } : {}),
    },
  };
}

/** The source one live call names, or the refusal that says how to name one.
 *  The handler enforces the field that each kind requires, because the
 *  schema root stays one object. */
function requestedSource(value: unknown): WorkflowCallSource | WorkflowLaunchRefusal {
  const source = workflowSource(value);
  if (source !== undefined) return source;
  const kind = asRecord(value)?.kind;
  if (kind === "path") return { error: "A source of kind path requires source.path, the workflow file to launch." };
  if (kind === "content") return { error: "A source of kind content requires source.content, the YAML text of the workflow file to save and launch." };
  return { error: "The workflow tool requires 'source' with kind 'path' and a path, or kind 'content' and content." };
}

/** The source that one call launches, and how its refusals read. A call
 *  that saves a file, from its content or from a file outside the workflow
 *  directory, saves it before any check and carries those bytes to
 *  admission, so another call replacing the file cannot change this call's
 *  definition. Every refusal names the saved file to fix. */
function launchSource(requested: WorkflowCallSource, sessionDir: string | undefined, executionCwd: string): { readonly source: WorkflowLaunchSource; readonly savedContent?: string; readonly refuse: (refusal: WorkflowLaunchRefusal) => WorkflowToolResult } | WorkflowLaunchRefusal {
  if (sessionDir === undefined) return { error: NO_WORKFLOW_DIRECTORY };
  const staged = stageWorkflowSource(requested, sessionDir, executionCwd);
  if ("error" in staged) return { error: staged.error };
  const source: WorkflowLaunchSource = { kind: "path", path: staged.path };
  if (staged.savedContent === undefined) return { source, refuse: refusedLaunch };
  const saved = staged.copiedFrom === undefined ? `Flywheel saved the file as ${staged.path}.` : `Flywheel saved a copy of ${staged.copiedFrom} as ${staged.path}.`;
  return {
    source,
    savedContent: staged.savedContent,
    refuse: (refusal) => refusedLaunch({ ...refusal, recovery: [saved, ...(refusal.recovery === undefined ? [] : [refusal.recovery])].join(" ") }),
  };
}

/** What the call result tells the launching agent about the model and
 *  effort that each agent starts on, and the persona that each runs as. */
function agentModelsReport({ pairs, personas, unavailable = [] }: WorkflowAgentModels): string {
  const groups = pairs.map(({ model, effort, definitionIds }) => `${model} at ${effort} effort for ${definitionIds.join(", ")}`)
  const runAs = personas.map(({ persona, agentIds }) => `${agentIds.join(", ")} as ${persona}`)
  const pending = unavailable.map(({ definitionId, reason }) => `${definitionId}: ${reason === "access-pending" ? "model access is still being checked" : "no reachable model in this profile"}`)
  return `${groups.length === 0 ? "" : ` The agents run on ${groups.join("; ")}.`}${pending.length === 0 ? "" : ` Model selection: ${pending.join("; ")}.`}${runAs.length === 0 ? "" : ` The agents run ${runAs.join("; ")}.`}`
}


/** What the call result tells the launching agent about the file it started. */
function workflowFileReport(file: LaunchedWorkflowFile): string {
  const { warnings } = file;
  const unproved = file.verificationUncertainties.length === 0
    ? ""
    : ` (leaves ${file.verificationUncertainties.map((name) => name.replaceAll("_", " ")).join(", ")} unproved)`;
  const warned = warnings.length === 0
    ? ""
    : `\nThe launch warns about ${warnings.length === 1 ? "1 problem that does" : `${warnings.length} problems that do`} not stop the run; fix them in the file before you launch it again:\n${warnings.map((warning) => `- ${warning}\n`).join("")}`;
  return ` It runs the workflow file ${file.path} with definition hash ${file.definitionSha256}. The verifier result is ${file.verification}${unproved}, and the run can queue at most ${file.worstCaseAttempts} attempts.${warned}`;
}

export function createWorkflowToolCore(deps: LaunchableWorkflowToolDeps): WorkflowToolDefinition<WorkflowToolResult> {
  return {
    name: "workflow",
    promptGuidelines: [
      `Keep your checkpoint's approved Design intent and Decisions current before launch. The runtime records them once in the workflow's shared request context for every agent; do not copy them into the launch description or briefs. Every agent treats that intent as fixed and everything else as implementation design it may revise.`,
      `When cwd targets a Git worktree, the parent keeps ownership of integrating and cleaning up that worktree.`,
      `After launch, target your workflow id in message_session to add direction to its request. Without targets, every running and later agent reads it. With targets, only the addressed items or named agents read it, including later agents that the address covers. A message to an agent session reaches only that agent and never adds workflow direction. Put a change to fixed intent under the heading Design intent. A workflow target takes no reply wait.`,
      // The launch resolves a relative path from the session directory, and
      // the file tools from the project directory first, so only the absolute
      // path names one file for both. The guideline names the directory by
      // its place in the scratchpad, whose absolute path the session tier
      // states: guidelines render in the stable tier, which every session of
      // the same role shares from the prompt cache.
      ...(deps.sessionDir === undefined ? [] : ["This session's workflow directory is `workflows` inside its scratchpad directory, where a content launch saves its file. Edit a saved file by its absolute path, because a relative scratch/ path reaches this directory only when the project has no scratch entry of its own, and launch it by that same path."]),
    ],
    async execute(input: RuntimeToolInput, context: WorkflowToolCallContext): Promise<WorkflowToolResult> {
      const requested = requestedSource(input.source);
      if ("error" in requested) return refusedLaunch(requested);
      const launched = launchSource(requested, deps.sessionDir, deps.executionCwd);
      if ("error" in launched) return refusedLaunch(launched);
      const { source, refuse } = launched;
      const description = input.description;

      if (typeof description !== "string" || !description) {
        return refuse({ error: "The workflow tool requires a 'description' string with detailed task instructions for the agents of the workflow." });
      }
      if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length === 0)) {
        return refuse({ error: "The workflow tool requires 'cwd' to be a non-empty string when supplied." });
      }
      const launchInput = structuredInput(input.input);
      if (launchInput === INVALID_INPUT) {
        return refuse({
          error: "The workflow tool requires 'input' to be one JSON object when supplied.",
          recovery: "Pass the object that the input schema of the workflow describes, or omit 'input'.",
        });
      }

      const toolUseId = context.toolUseId;
      const conversationId = context.conversationId;
      if (!toolUseId || !conversationId) {
        return refuse({ error: "The workflow tool requires durable session context." });
      }

      const launch = await deps.startWorkflow({
        source,
        ...(launched.savedContent === undefined ? {} : { savedContent: launched.savedContent }),
        description,
        ...(typeof input.cwd === "string" ? { launchCwd: input.cwd } : {}),
        ...(taskSummary(input) === undefined ? {} : { summary: taskSummary(input) }),
        ...(launchInput === undefined ? {} : { input: launchInput }),
        model: {
          conversationId,
          toolUseId,
          confirmation: suppliedConfirmation(input),
          authority: deps.authority,
          ...(context.capabilityAccess ? { capabilityAccess: context.capabilityAccess } : {}),
        },
      });

      // Refusal precedes aggregate publication and background registration.
      if ("error" in launch) return refuse(launch);

      // The aggregate's current launch binding now owns this invocation.
      deps.onRenderEvent(createRuntimeEvent("agent.workflow_link.published", {
        tool_use_id: toolUseId,
        link_uri: `flywheel://workflow/${launch.workflowId}`,
      }));
      // Synchronous with agent_link emit above; no awaits between them.
      deps.onRenderEvent(createRuntimeEvent("agent.subagent.dispatched", {
        tool_use_id: toolUseId,
      }));
      return {
        content: `Workflow started (workflow ${launch.workflowId}).${launch.workflowFile ? workflowFileReport(launch.workflowFile) : ""}${agentModelsReport(launch.stepModels)} Open this activity row to inspect it. The process tool takes this workflow id for its progress, an interrupt, a resume, or a stop. To add workflow direction, target this workflow id in message_session, with item or named-agent targets when needed. To answer one agent, use that agent's session id from workflow status. Completion or Stop will settle this call and notify this chat once. Closing the viewer or interrupting this chat does not stop the workflow. Continue follow-up conversation in this chat; the completed workflow is read-only.`,
        outcome: "ok",
        deferCompletion: true,
      };
    },
  };
}

const INVALID_INPUT = Symbol("invalid workflow input");

/** The structured input one call carries: absent, one object, or invalid.
 *  Some models send an object argument as its JSON text, so a string that
 *  parses to one object is that object. The launch decodes the object
 *  against the workflow's input contract. */
function structuredInput(value: unknown): object | undefined | typeof INVALID_INPUT {
  if (value === undefined) return undefined;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return INVALID_INPUT;
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : INVALID_INPUT;
}

/** The confirmation one call carries. The tool reads it without regard to
 *  mode: the workflow controller decides against the live mode whether the
 *  launch needs it, accepts it, or refuses it. */
function suppliedConfirmation(input: RuntimeToolInput): WorkflowLaunchConfirmation {
  const supplied = input.confirmation_id;
  return typeof supplied === "string" && supplied.length > 0
    ? { kind: "supplied", confirmationId: supplied }
    : { kind: "absent" };
}

/** Every launch the workflow tool refuses, in one shape. The model reads the
 *  reason, each located problem, and the recovery path. The launch card shows
 *  the reason and how many problems there are under a workflow title, and
 *  offers no retry advice of its own, because the agent, not the person, acts
 *  on the refusal. The recorded details keep the card the same when a client
 *  rebuilds it from history. */
function refusedLaunch(refusal: WorkflowLaunchRefusal): WorkflowToolResult {
  const problems = refusal.problems ?? []
  return {
    content: workflowRefusalText(refusal),
    outcome: "error",
    details: {
      agentFailure: {
        title: "Workflow not started",
        message: problems.length === 0 ? refusal.error : `${refusal.error.replace(/\.$/, "")} (${problems.length} problem${problems.length === 1 ? "" : "s"}).`,
        guidance: "The agent reads this reason and chooses the next step.",
      },
    },
  };
}

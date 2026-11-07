import { assertNever } from "../../infra/assert-never.js";
import type { CapabilityCheck } from "../../infra/capability-text.js";
import { isAbortError } from "../../infra/abort.js";
import { errorMessage } from "../../infra/error-message.js";
import { InvariantViolation } from "../../infra/invariant.js";
import { Schema } from "effect";
import { classifyError, type ErrorType, WorkerFailedError } from "../context-bundle/error-classifier.js";
import { HandoffError, HandoffNotProducedError } from "../context-bundle/handoff-errors.js";
import { assembleAgentPrompt } from "../context-bundle/prompt-assembly.js";
import { describeOutputIssues } from "../output-contract/accept.js";
import { commandEvidenceRefusal } from "../output-contract/envelope.js";
import { buildAttemptContextBundle, type ArtifactContextBuilder } from "../context-bundle/attempt-artifacts.js";
import type { WorkflowContextStore } from "../context-bundle/context-store.js";
import type { ContextRecipient } from "../context-bundle/context.js";
import type { AttemptRow } from "../view/types.js";
import type { SkillRegistryRevision } from "../skill-schema.js";
import type { ResolvedAgent } from "../agent-resolution.js";
import type { AttemptExecutionInput } from "./commands.js";
import type {
  AttemptFailure,
  AttemptOutcome,
  ReassessmentProposal,
} from "./events.js";
import { reassessesRetiredFor, reassessmentIssues, reassessmentProposal, type ReassessmentControl, type ReassessmentHandoff } from "./reassessment.js";
import type { AgentOutput } from "./agent-outcome.js";


interface AttemptRunHost {
  /** The session of the workflow, which records every handoff of its agents. */
  readonly workflowSessionId: string;
  readonly conversationId: string;
  readonly signal: AbortSignal;
  readonly committedControl: () => ReassessmentControl;
  /** Every conversation in which the tool calls of one attempt ran, oldest
   *  first, from the workflow's committed facts. */
  readonly conversationsOf: (attemptId: string) => Promise<readonly string[]>;
}

/** What an attempt's agent reads first: its user prompt and its task. */
interface AttemptBrief {
  readonly userPrompt: string;
  readonly task: string;
}

/** Composes the brief of an attempt for the check of the agent that runs it (ARCH-CONTEXT-033): the tools that its
 *  first request can call and the definitions available to it. The worker plans the agent's run and calls it once,
 *  before the brief commits. It records the attempt's invocation, and it rejects when the agent cannot do the
 *  attempt's work, as an output that requires command evidence without a usable `bash`. */
export type ComposeAttemptBrief = (capabilities: CapabilityCheck) => Promise<AttemptBrief>;

export interface AttemptExecutorDeps {
  /** Resolved agent records of this workflow, keyed by definition id. The
   *  record owns the execution policy of its graph position: its output
   *  contract, writes, and tool scope. */
  readonly resolvedAgents: ReadonlyMap<string, ResolvedAgent>;
  readonly context: Pick<WorkflowContextStore, "getContext">;
  /** Skill revision every attempt of this workflow composes its brief's
   *  dependency closure from, bound once by the host that passed preflight. */
  readonly skills: SkillRegistryRevision;
  readonly worker: (
    attempt: AttemptRow,
    brief: ComposeAttemptBrief,
    signal: AbortSignal,
    conversationId: string,
    /** Reports measured operations even when the worker throws before returning. */
    onToolUses?: (count: number) => void,
    /** The launch seed's approved intent, sent in the workflow-shared system tier. */
    inheritedIntent?: string,
  ) => Promise<AgentOutput>;
  readonly recordInvocation: () => Promise<void>;
  readonly buildArtifactContext?: ArtifactContextBuilder;
  /** Why the agent of an attempt may not call the tool of the tool term
   *  `term`, which its check refuses. */
  readonly unavailableToolReason: (term: string) => string;
  /** The latest checkpoint of an earlier conversation of this workflow's
   *  agents, rendered for the agent's check, or null when it recorded none. */
  readonly earlierCheckpoint: (conversationId: string, capabilities: CapabilityCheck) => Promise<string | null>;
}

interface AttemptRunSuccess extends AttemptOutcome {
  readonly kind: "success";
}

type AttemptRunFailure = AttemptFailure;
type ClassifiedAttemptFailure = Extract<AttemptFailure, {
  kind: "handoff" | "transient" | "context_overflow" | "fatal";
}>;

export type AttemptRunOutcome = AttemptRunSuccess | AttemptRunFailure;

export interface AttemptExecutor {
  run(input: AttemptExecutionInput, host: AttemptRunHost): Promise<AttemptRunOutcome>;
}

function attemptRowFor(
  input: AttemptExecutionInput,
  conversationId: string,
  resolvedAgent: ResolvedAgent,
): AttemptRow {
  return {
    id: input.attemptId,
    definitionId: input.definitionId,
    briefId: resolvedAgent.briefId,
    workflowDefinitionId: input.workflowDefinitionId,
    name: resolvedAgent.name,
    status: "running",
    writes: resolvedAgent.writes.map(({ id }) => id),
    resumeRevertCount: 0,
    lastConversationId: conversationId,
    ...(input.priorRetryFeedback !== null
      ? { description: `Retry ${input.iteration}: prior: ${input.priorRetryFeedback}` }
      : resolvedAgent.description === undefined ? {} : { description: resolvedAgent.description }),
    ...(input.item === null ? {} : { item: input.item }),
  };
}

function describeInvariant(error: unknown): string {
  if (error instanceof InvariantViolation) return `${error.kind}: ${error.detail}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function failureReason(errorType: ErrorType, error: unknown, input: AttemptExecutionInput): string {
  const reason = errorMessage(error);
  switch (errorType) {
    case "fatal": return `fatal error - ${reason}`;
    case "invariant": return `invariant violation - ${describeInvariant(error)}`;
    case "handoff": {
      const attempts = input.iteration > 1 || input.priorRetryFeedback !== null ? ` after ${input.iteration} of ${input.iteration} attempts` : "";
      return `agent handoff failed${attempts} - ${reason}`;
    }
    case "transient": return `provider not responding - ${reason}`;
    case "unknown": return `unexpected error - ${reason}`;
    default: return assertNever(errorType);
  }
}

function failure(
  input: AttemptExecutionInput,
  conversationId: string,
  kind: ClassifiedAttemptFailure["kind"],
  reason: string,
  toolUses?: number,
): ClassifiedAttemptFailure {
  return {
    attemptId: input.attemptId,
    conversationId,
    kind,
    reason,
    ...(toolUses === undefined ? {} : { toolUses }),
  };
}

/** The context recipient of one attempt: the attempt, its logical node, its
 *  scope, and the outputs that its record reads. A resumed attempt resolves
 *  its record from the same recorded definition, so it reads the same
 *  outputs. */
export function attemptContextRecipient(
  input: Pick<AttemptExecutionInput, "attemptId" | "logicalNodeId" | "scope">,
  agent: Pick<ResolvedAgent, "reads">,
): ContextRecipient {
  return { attemptId: input.attemptId, nodeId: input.logicalNodeId, scope: input.scope, reads: agent.reads };
}

/** Execute one already-committed worker attempt without persistence or routing authority. */
export function createAttemptExecutor(deps: AttemptExecutorDeps): AttemptExecutor {
  /** What the conversations before this one recorded: the latest one's
   *  checkpoint, and the file edits of all of them, which stay on disk. */
  async function readEarlierAttempt(attemptId: string, agentName: string, capabilities: CapabilityCheck, host: AttemptRunHost) {
    const earlier = (await host.conversationsOf(attemptId)).filter((conversationId) => conversationId !== host.conversationId);
    const latest = earlier.at(-1);
    return {
      checkpoint: latest === undefined ? null : await deps.earlierCheckpoint(latest, capabilities),
      fileEvidence: await deps.buildArtifactContext?.([{ agentName, conversationIds: earlier, handoffs: [] }], host.signal) ?? null,
    };
  }

  return {
    async run(input, host): Promise<AttemptRunOutcome> {
      host.signal.throwIfAborted();
      const resolvedAgent = deps.resolvedAgents.get(input.definitionId);
      // Compilation resolves every graph position to a resolved record, so an
      // attempt that names none is a corrupted control record, not a record
      // to improvise.
      if (!resolvedAgent) return failure(input, host.conversationId, "fatal", `fatal error - attempt names unknown agent record "${input.definitionId}"`);
      const attempt = attemptRowFor(input, host.conversationId, resolvedAgent);
      let toolUses: number | undefined;
      try {
        const context = await deps.context.getContext(attemptContextRecipient(input, resolvedAgent));
        if (context.request === null) throw new Error("Workflow context has no seeded user request");
        const contextBundle = await buildAttemptContextBundle(attempt, context, {
          signal: host.signal,
          workflowSessionId: host.workflowSessionId,
          resolvedAgents: deps.resolvedAgents,
          buildArtifactContext: deps.buildArtifactContext,
          conversationsOf: host.conversationsOf,
        });

        // The refusal that the brief raised, which the attempt reports as its failure.
        let refusal: string | undefined;
        const brief: ComposeAttemptBrief = async (capabilities) => {
          if (resolvedAgent.output.requiresCommandEvidence && !capabilities("bash")) {
            refusal = commandEvidenceRefusal(`Workflow "${input.workflowDefinitionId}" agent "${resolvedAgent.definitionId}"`, deps.unavailableToolReason("bash"));
            throw new Error(refusal);
          }
          const earlierAttempt = input.provenance._tag === "continuation" && input.provenance.reason === "overflow"
            ? await readEarlierAttempt(input.attemptId, resolvedAgent.name, capabilities, host)
            : undefined;
          const { task, userPrompt } = assembleAgentPrompt({
            attempt,
            agent: resolvedAgent,
            contextBundle,
            skills: deps.skills,
            capabilities,
            ...(input.vote === undefined ? {} : { vote: input.vote }),
            ...(earlierAttempt === undefined ? {} : { earlierAttempt }),
          });
          host.signal.throwIfAborted();
          await deps.recordInvocation();
          host.signal.throwIfAborted();
          return { task, userPrompt };
        };

        host.signal.throwIfAborted();
        let workerOutput: AgentOutput;
        try {
          workerOutput = await deps.worker(attempt, brief, host.signal, host.conversationId, (count) => { toolUses = count; }, context.request.inheritedIntent);
        } catch (error) {
          if (refusal === undefined) throw error;
          return failure(input, host.conversationId, "fatal", `fatal error - ${refusal}`);
        }
        toolUses = workerOutput.toolUses ?? toolUses;
        host.signal.throwIfAborted();
        if (workerOutput.output === "context_overflow") {
          return failure(
            input,
            host.conversationId,
            "context_overflow",
            "context overflow - the agent's conversation outgrew the model's context window",
            toolUses,
          );
        }
        if (workerOutput.output === "failed") {
          throw new WorkerFailedError(
            workerOutput.failureKind,
            workerOutput.failureMessage,
            workerOutput.failureDetail,
          );
        }
        const content = workerOutput.handoffContent;
        if (!content) {
          const error = new HandoffNotProducedError(attempt.id);
          return {
            attemptId: input.attemptId,
            conversationId: host.conversationId,
            kind: "missing_handoff",
            reason: failureReason("handoff", error, input),
            ...(toolUses === undefined ? {} : { toolUses }),
          };
        }
        let reassessment: ReassessmentProposal | null = null;
        if (resolvedAgent.reassesses) {
          // The boundary decoded this payload with the same schema; decoding
          // again here gives the VM its typed view of the proposal. A `for`
          // node of control from before phases reads its frozen contract.
          const control = host.committedControl();
          const handoff: ReassessmentHandoff = reassessesRetiredFor(input, control)
            ? { retired: true, payload: Schema.decodeUnknownSync(resolvedAgent.retiredOutput.schema)(content) }
            : { retired: false, payload: Schema.decodeUnknownSync(resolvedAgent.output.schema)(content) };
          const issues = reassessmentIssues(handoff, input, control);
          if (issues.length > 0) {
            return {
              attemptId: input.attemptId,
              conversationId: host.conversationId,
              kind: "invalid_handoff",
              reason: describeOutputIssues(issues).join("; "),
              content,
              issues,
              ...(toolUses === undefined ? {} : { toolUses }),
            };
          }
          reassessment = reassessmentProposal(handoff, input, control);
        }
        return {
          kind: "success",
          attemptId: input.attemptId,
          conversationId: host.conversationId,
          handoff: content,
          reassessment,
          ...(toolUses === undefined ? {} : { toolUses }),
        };
      } catch (error) {
        if (host.signal.aborted || isAbortError(error)) throw error;
        const errorType = error instanceof HandoffError ? "handoff" : classifyError(error);
        return failure(
          input,
          host.conversationId,
          errorType === "transient" ? "transient" : error instanceof HandoffError ? "handoff" : "fatal",
          failureReason(errorType, error, input),
          toolUses,
        );
      }
    },
  };
}

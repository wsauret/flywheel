import { assertNever } from "../../infra/assert-never.js";
import type { CapabilityCheck } from "../../infra/capability-text.js";
import { isAbortError } from "../../infra/abort.js";
import { errorMessage } from "../../infra/error-message.js";
import { InvariantViolation } from "../../infra/invariant.js";
import { Result, Schema } from "effect";
import { Log } from "../../infra/log.js";
import type { UnknownRecord } from "../../infra/record.js";
import { classifyError, type ErrorType, WorkerFailedError } from "../context-bundle/error-classifier.js";
import { HandoffError, HandoffNotProducedError } from "../context-bundle/handoff-errors.js";
import { assembleAgentPrompt } from "../context-bundle/prompt-assembly.js";
import { describeOutputIssues, schemaIssues } from "../output-contract/accept.js";
import type { CompiledOutput } from "../output-contract/compile.js";
import { declaredPayload } from "../output-contract/leniency.js";
import type { OutputIssue } from "../output-contract/paths.js";
import { salvageDelivered } from "../output-contract/salvage.js";
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

const log = Log.create({ service: "workflow-attempt" });


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

/** What a reassess attempt's handoff proposes (refer to {@link readReassessment}). */
interface ReassessmentRead {
  readonly refused: boolean;
  readonly proposal: ReassessmentProposal | null;
  readonly issues: readonly OutputIssue[];
}

/** The proposal of a reassess attempt's handoff. An accepted handoff that
 *  cannot become a proposal is `refused`, as before. A delivered handoff
 *  (`delivered`) never fails its attempt: it reads only the reassessment's
 *  own fields, its reason (`summary`) and its changes, so a problem in
 *  another field never hides a valid change. Each change that cannot apply
 *  is left out with its issues, and a handoff from which no valid change
 *  can be read changes nothing, so the workflow runs on with its plan. */
function readReassessment(
  output: CompiledOutput<unknown>,
  retired: boolean,
  handoff: UnknownRecord,
  input: AttemptExecutionInput,
  control: ReassessmentControl,
  delivered: boolean,
): ReassessmentRead {
  // The boundary decoded the declared keys of this payload with the same
  // schema; decoding again here gives the VM its typed view of the proposal.
  const decode = (payload: UnknownRecord): Result.Result<ReassessmentHandoff, readonly OutputIssue[]> => {
    const decoded = Schema.decodeUnknownResult(output.schema, { errors: "all" })(declaredPayload(output.payloadFields, payload).payload);
    if (Result.isFailure(decoded)) return Result.fail(schemaIssues(decoded.failure.issue));
    // SAFETY: `output` is the reassessment contract that `retired` selects, so its payload is that arm's payload.
    return Result.succeed({ retired, payload: decoded.success } as ReassessmentHandoff); // oxlint-disable-line typescript/consistent-type-assertions -- boundary: the caller selects the contract by the same `retired` flag.
  };
  if (!delivered) {
    const decoded = decode(handoff);
    if (Result.isFailure(decoded)) throw new Error(`Workflow invariant rejected the accepted reassessment handoff of attempt "${input.attemptId}"`);
    const issues = reassessmentIssues(decoded.success, input, control);
    return issues.length === 0
      ? { refused: false, proposal: reassessmentProposal(decoded.success, input, control), issues: [] }
      : { refused: true, proposal: null, issues };
  }
  const unchanged = (because: string): OutputIssue => ({ path: "changes", message: `no change was applied, so the remaining items stay as they are, because ${because}` });
  const left: OutputIssue[] = [];
  // Each remaining change keeps the place the agent gave it, so an issue of a
  // later pass names the change as the agent sent it.
  let remaining: { readonly change: unknown; readonly sent: number }[] | undefined = Array.isArray(handoff.changes)
    ? handoff.changes.map((change: unknown, sent) => ({ change, sent }))
    : undefined;
  // Each pass leaves out every change that cannot apply. Leaving one out can
  // break a later change anchored on it, so the read repeats until every
  // remaining change applies; each pass removes at least one change.
  for (;;) {
    const decoded = decode({ summary: handoff.summary, changes: remaining?.map(({ change }) => change) ?? handoff.changes });
    if (Result.isFailure(decoded)) {
      return { refused: false, proposal: null, issues: [...left, unchanged(decoded.failure.map(({ path, message }) => `${path}: ${message}`).join("; "))] };
    }
    const issues = reassessmentIssues(decoded.success, input, control);
    if (issues.length === 0) return { refused: false, proposal: reassessmentProposal(decoded.success, input, control), issues: left };
    const failing = new Set<number>();
    for (const issue of issues) {
      const match = /^changes\.(\d+)(\..*)?$/.exec(issue.path);
      const failed = match === null ? undefined : remaining?.[Number(match[1])];
      if (match === null || failed === undefined) continue;
      failing.add(Number(match[1]));
      left.push({ ...issue, path: `changes.${failed.sent}${match[2] ?? ""}`, message: `${issue.message}; this change was left out`, hint: `change: ${JSON.stringify(failed.change)}` });
    }
    if (failing.size === 0 || remaining === undefined) {
      return { refused: false, proposal: null, issues: [...left, unchanged(issues.map(({ path, message }) => `${path}: ${message}`).join("; "))] };
    }
    remaining = remaining.filter((_change, index) => !failing.has(index));
  }
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
        // A handoff that the tool refused until its correction ran out is
        // delivered, with the lists that later phases and joins need salvaged
        // and every remaining problem recorded, so its work is kept.
        // A `for` node of control from before phases reads its frozen
        // reassessment contract.
        const control = resolvedAgent.reassesses ? host.committedControl() : undefined;
        const retired = resolvedAgent.reassesses && control !== undefined && reassessesRetiredFor(input, control);
        const contract: CompiledOutput<unknown> = resolvedAgent.reassesses && retired ? resolvedAgent.retiredOutput : resolvedAgent.output;
        const refusedIssues = workerOutput.handoffIssues;
        const salvaged = refusedIssues === undefined ? undefined : salvageDelivered(contract, content, { counted: resolvedAgent.countedLists, admitted: resolvedAgent.admittedLists });
        const handoff = salvaged?.payload ?? content;
        const issues: OutputIssue[] = refusedIssues === undefined || salvaged === undefined ? [] : [...refusedIssues, ...salvaged.issues];
        let reassessment: ReassessmentProposal | null = null;
        if (control !== undefined) {
          const read = readReassessment(contract, retired, handoff, input, control, refusedIssues !== undefined);
          if (read.refused) {
            return {
              attemptId: input.attemptId,
              conversationId: host.conversationId,
              kind: "invalid_handoff",
              reason: describeOutputIssues(read.issues).join("; "),
              content: handoff,
              issues: read.issues,
              ...(toolUses === undefined ? {} : { toolUses }),
            };
          }
          reassessment = read.proposal;
          issues.push(...read.issues);
        }
        if (refusedIssues !== undefined) {
          log.info("workflow agent handoff delivered after its correction ran out", {
            attemptId: input.attemptId,
            issues: issues.length,
            leftOutItems: salvaged?.issues.length ?? 0,
            reassessment: resolvedAgent.reassesses ? (reassessment === null ? "no_change" : "applied") : "none",
          });
        }
        return {
          kind: "success",
          attemptId: input.attemptId,
          conversationId: host.conversationId,
          handoff,
          reassessment,
          ...(refusedIssues === undefined ? {} : { issues }),
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

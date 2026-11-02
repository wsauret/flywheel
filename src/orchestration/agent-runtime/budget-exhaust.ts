/**
 * Budget boundary for the agent loop: the hard-cap exhaustion turn (handoff
 * for agents of a workflow and subagents, free-text summary for chat).
 *
 * The exhaustion turn deliberately runs OUTSIDE the normal stream collector:
 * it builds its own short stream, whose dispatch executes only handoff (or no
 * tool for a summary), so the structured handoff artifact is produced and the
 * agent loop has a single, predictable exit even when the model has been
 * running ragged. It repeats a step only for the model's own behavior: an
 * empty answer or calls that it refused. A request that the provider walk
 * failed throws the walk's typed error, which ends the run as any failed
 * request does; the walk owns every retry inside a request (ARCH-PROVIDERS-032).
 */

import { Effect, Exit, Scope } from "effect";
import type { PersistenceWriteRefused } from "../../infra/event-store-types.js";
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import type { ReasoningEffort } from "../../infra/llm/models.js";
import { Log } from "../../infra/log.js";
import { fixedTurnOutputBound } from "./compaction/compaction-policy.js";
import type { AgentLoopOptions } from "./agent-loop-types.js";
import { createTurnDispatcher, stampToolRegistration } from "./agent-loop-tools.js";
import { settleTurn, type SettledTurn } from "./agent-turn-settlement.js";
import type { OwnedTurn } from "./run-lifecycle.js";
import type { AssistantAttemptInput } from "./assistant-turn-attempt.js";
import type { AssistantTurnResult } from "./assistant-turn-result.js";
import type { ToolResultEntry } from "./agent-state.js";
import type {
  ConversationMessage,
  ContentBlock,
  StreamEvent,
  StreamOptions,
  ToolCall,
  TurnModelClient,
} from "./llm/types.js";
import type { RuntimeTool, ToolContext } from "./tools/types.js";
import type { ExecutionWhitelist } from "./tools/tool-policy.js";
import type { PreparedRequestAttempt } from "./request-tool-surface.js";
import type { ModelInteractionProfile } from "./model-interaction-profile.js";
import type { ProviderRequestAuditWriter } from "./llm/provider-request-audit.js";
import { streamAssistantTurn } from "./assistant-turn-stream.js";
import type { PromptStaleMasking, PromptToolHistoryProjection } from "../session/provider-request-audit-types.js";
import { prepareLocalTokenizer } from "../../infra/local-tokenizer.js";
import type { createHandoffTracker } from "./agent-loop-handoff.js";
import { repairToolName } from "./tools/tool-dispatch.js";

const log = Log.create({ service: "budget-exhaust" });

const MAX_SUMMARY_ATTEMPTS = 3;

/** The effort of an exhaustion step, which only writes the agent's last words. */
const EXHAUSTION_EFFORT: ReasoningEffort = "low";

/** What an exhaustion step executes. The step keeps the agent's whole tool list and its automatic tool choice, so its
 *  request differs from the agent's other requests only in its messages and effort: a hosted agent whose request
 *  narrowed its tools or forced a tool would start another engine process (agent-host/host-registry.ts). A call
 *  outside the whitelist is refused with a text that names what the agent can still do. */
function exhaustionWhitelist(handoffToolName: string | undefined): ExecutionWhitelist {
  const refusal = (toolName: string, instead: string) => `The ${toolName} tool is unavailable to this agent now: the turn budget is spent. Do not call ${toolName} again; ${instead}.`;
  return handoffToolName === undefined
    ? { tools: new Set(), deniedReason: (toolName) => refusal(toolName, "answer in text") }
    : { tools: new Set([handoffToolName]), deniedReason: (toolName) => refusal(toolName, `call ${handoffToolName}`) };
}

interface BudgetRequestCapture {
  client: TurnModelClient;
  request: import("./llm/types.js").AdmittedModelRequest;
  interactionProfile: ModelInteractionProfile;
  materializeCandidatePolicy(attempt: import("./llm/types.js").ServingAttempt): void;
  prepareOutgoing(attempt: import("./llm/types.js").ServingAttempt): PreparedBudgetExhaustionRequest | Promise<PreparedBudgetExhaustionRequest>;
  /** Appends the route's request entries to the loop's canonical history (`ServingAttempt.requestEntries`). */
  appendEntries(entries: readonly ConversationMessage[]): Promise<void>;
  providerOptions: ProviderRequestOptions | undefined;
  cacheRetentionPolicies?: StreamOptions["cacheRetentionPolicies"];
  tools: ReadonlyMap<string, RuntimeTool>;
  executionAdmission?: (toolName: string) => import("./tools/tool-dispatch.js").PreparedCallCapabilityAdmission;
  toolExecutionGate?: import("./tools/tool-dispatch.js").ToolExecutionGate;
}

interface BudgetExhaustionInput {
  handoffTracker: ReturnType<typeof createHandoffTracker>;
  /** Consumes the loop's admitted request at attempt 1; later attempts capture a new request. */
  captureRequest(attempt: number): Promise<BudgetRequestCapture>;
  signal: AbortSignal | undefined;
  requestAudit: ProviderRequestAuditWriter | undefined;
  turnOrdinal: number;
  cacheRetention: StreamOptions["cacheRetention"];
  onEvent: AgentLoopOptions["onEvent"];
  onLoginWait?: (waiting: boolean) => void;
  waitForEventCapacity?: AssistantAttemptInput["waitForEventCapacity"];
  providerSessionKey: string;
  promptCacheKey: string;
  artifactScopeId: string;
  maxLLMCalls: number;
  handoffConfigured: boolean;
  toolContext: ToolContext;
  /** The loop's background-execution owner, forwarded unchanged: the forced
   *  handoff dispatch runs through the same owner as any other turn's. */
  background: AgentLoopOptions["background"];
  afterToolCall: AgentLoopOptions["afterToolCall"];
  /** The turn this forced handoff settles in, opened and ended by the loop:
   *  its scope owns the handoff's foreground fiber. */
  turn: OwnedTurn;
  onTurnAssistantMessage: AgentLoopOptions["onTurnAssistantMessage"];
  reserveMessageId?: () => Promise<string>;
  releaseMessageId?: (id: string) => void;
  pushMessage(message: ConversationMessage, humanTyped?: boolean, entryId?: string): void | Promise<ConversationMessage | void>;
  pushUser(content: string | ContentBlock[]): void | Promise<void>;
  pushToolResults(results: ReadonlyArray<ToolResultEntry>): void | Promise<void>;
  usageSettlement?: AssistantAttemptInput["usageSettlement"];
  flushCanonicalMessages?: () => Promise<void>;
}

interface PreparedBudgetExhaustionRequest {
  readonly messages: ConversationMessage[];
  readonly prepared: PreparedRequestAttempt;
  readonly staleMasking: PromptStaleMasking | undefined;
  readonly toolHistoryProjection: PromptToolHistoryProjection | undefined;
  readonly messageCount: number;
  readonly estimatedContextTokens: number;
}

/** Drives the final turn after the agent loop hits its hard cap (the loop
 *  then exits with the `budget_exhausted` terminal). The budget notice tells the
 *  agent what still runs: only handoff for an agent that hands off, else no tool.
 *  Reports whether handoff was written so the loop's handoff bookkeeping stays
 *  accurate. */
export async function runBudgetExhaustionTurn(input: BudgetExhaustionInput): Promise<{ handoffWritten: boolean }> {
  const used = `Budget exhausted (${input.maxLLMCalls} LLM calls used).`;
  await input.pushUser(input.handoffConfigured
    ? `${used} Only handoff runs now: call handoff with a final summary of progress and remaining work.`
    : `${used} No tool runs now: provide a final summary of progress and remaining work in text.`);
  await input.flushCanonicalMessages?.();
  const outcome = await runExhaustionStream({
    captureRequest: input.captureRequest,
    handoffConfigured: input.handoffConfigured,
    requestAudit: input.requestAudit,
    turnOrdinal: input.turnOrdinal,
    cacheRetention: input.cacheRetention,
    signal: input.signal,
    onEvent: input.onEvent,
    onLoginWait: input.onLoginWait,
    handoffTracker: input.handoffTracker,
    waitForEventCapacity: input.waitForEventCapacity,
    providerSessionKey: input.providerSessionKey,
    promptCacheKey: input.promptCacheKey,
    usageSettlement: input.usageSettlement,
    turn: input.turn,
    toolContext: input.toolContext,
    background: input.background,
    afterToolCall: input.afterToolCall,
    artifactScopeId: input.artifactScopeId,
    onTurnAssistantMessage: input.onTurnAssistantMessage,
    reserveMessageId: input.reserveMessageId,
    releaseMessageId: input.releaseMessageId,
    pushMessage: input.pushMessage,
    pushToolResults: input.pushToolResults,
    flushCanonicalMessages: input.flushCanonicalMessages,
  });

  input.signal?.throwIfAborted();
  if (outcome.handoffWritten || outcome.answered) return { handoffWritten: outcome.handoffWritten };

  const fallback: ContentBlock[] = [{ type: "text", text: `Budget exhausted. The agent gave no final summary after ${MAX_SUMMARY_ATTEMPTS} requests.` }];
  const entryId = await input.reserveMessageId?.() ?? crypto.randomUUID();
  input.onTurnAssistantMessage?.(fallback, entryId);
  await input.pushMessage({ kind: "assistant", content: fallback }, false, entryId);
  return { handoffWritten: false };
}

// ── Internal: exhaustion stream attempts ──────────────────────────

interface ExhaustionStreamInput {
  handoffTracker: ReturnType<typeof createHandoffTracker>;
  reserveMessageId?: () => Promise<string>;
  releaseMessageId?: (id: string) => void;
  captureRequest: BudgetExhaustionInput["captureRequest"];
  handoffConfigured: boolean;
  requestAudit: ProviderRequestAuditWriter | undefined;
  turnOrdinal: number;
  cacheRetention: StreamOptions["cacheRetention"];
  signal: AbortSignal | undefined;
  providerSessionKey: string | undefined;
  promptCacheKey: string;
  onEvent: (event: StreamEvent) => void;
  onLoginWait?: (waiting: boolean) => void;
  waitForEventCapacity?: AssistantAttemptInput["waitForEventCapacity"];
  usageSettlement?: AssistantAttemptInput["usageSettlement"];
  turn: OwnedTurn;
  toolContext: ToolContext;
  background: AgentLoopOptions["background"];
  afterToolCall: AgentLoopOptions["afterToolCall"];
  artifactScopeId: string;
  onTurnAssistantMessage: AgentLoopOptions["onTurnAssistantMessage"];
  pushMessage: BudgetExhaustionInput["pushMessage"];
  pushToolResults(results: ReadonlyArray<ToolResultEntry>): void | Promise<void>;
  flushCanonicalMessages?: () => Promise<void>;
}

interface ExhaustionStreamOutcome {
  /** Whether the step committed an answer: assistant content without a call that the step refused. */
  answered: boolean;
  handoffWritten: boolean;
  /** The typed error of a request that the provider walk failed or that overflowed the context. */
  failure?: Extract<AssistantTurnResult["outcome"], { kind: "stream_error" | "context_overflow" }>["error"];
}

/** One exhaustion step: the agent's request as every other step sends it, at `EXHAUSTION_EFFORT`, whose dispatch
 *  executes only `handoffToolName` and refuses every other call (`exhaustionWhitelist`). Without a handoff tool the
 *  step executes no tool. */
async function attemptExhaustionTurn(input: ExhaustionStreamInput & BudgetRequestCapture, handoffToolName: string | undefined): Promise<ExhaustionStreamOutcome> {
  const executionWhitelist = exhaustionWhitelist(handoffToolName);
  return streamAssistantTurn<ExhaustionStreamOutcome>({
    client: input.client,
    executionCwd: input.toolContext.executionCwd,
    request: input.request,
    signal: input.signal,
    onLoginWait: input.onLoginWait,
    providerOptions: input.providerOptions,
    appendEntries: input.appendEntries,
    prepare: async (candidate) => {
      await prepareLocalTokenizer();
      input.materializeCandidatePolicy(candidate);
      const outgoing = await input.prepareOutgoing(candidate);
      return { input: {
        interactionProfile: input.interactionProfile,
        messages: outgoing.messages,
        prepareAttempt: () => outgoing.prepared,
        reasoningEffort: EXHAUSTION_EFFORT,
        signal: input.signal,
        cacheRetention: input.cacheRetention,
        cacheRetentionPolicies: input.cacheRetentionPolicies,
        providerSessionKey: input.providerSessionKey,
        promptCacheKey: input.promptCacheKey,
        providerOptions: input.providerOptions,
        requestAudit: input.requestAudit,
        usageSettlement: input.usageSettlement,
        staleMasking: outgoing.staleMasking,
        toolHistoryProjection: outgoing.toolHistoryProjection,
        waitForEventCapacity: input.waitForEventCapacity,
        requestContext: undefined,
        turn: input.turnOrdinal,
        messageCount: outgoing.messageCount,
        estimatedContextTokens: outgoing.estimatedContextTokens,
        onEvent: input.onEvent,
        reserveMessageId: input.reserveMessageId,
        releaseMessageId: input.releaseMessageId,
      }, execute: async (_candidate, fold) => {
      const executionScope = Scope.forkUnsafe(input.turn.scope, "sequential");
      try {
      const observedCalls: ToolCall[] = [];
      const handoffAdmission = handoffToolName === undefined ? undefined : input.handoffTracker.request();
      if (handoffAdmission) input.toolContext.refuseAfterHandoff = handoffAdmission.refuse;
      const registrationIds = new Map(outgoing.prepared.auditTools.map(({ executableId, registrationId }) => [executableId, registrationId]));
      const dispatcher = createTurnDispatcher({
        tools: input.tools,
        ...(input.executionAdmission ? { executionAdmission: input.executionAdmission } : {}),
        toolContext: input.toolContext,
        signal: input.signal,
        background: input.background,
        turnScope: executionScope,
        afterToolCall: input.afterToolCall,
        onEvent: input.onEvent,
        artifactScopeId: input.artifactScopeId,
        outputBound: fixedTurnOutputBound(candidate.contextLimit),
        executionWhitelist,
        ...(input.toolExecutionGate ? { toolExecutionGate: input.toolExecutionGate } : {}),
      });
      return await fold({
        ...(handoffAdmission ? { onHandoffStarted: handoffAdmission.start } : {}),
        canonicalizeToolName: (name) => repairToolName(name, input.tools) ?? name,
        canonicalizeToolCall: (call) => {
          const registered = stampToolRegistration(dispatcher.onToolUse(call), registrationIds);
          observedCalls.push(registered);
          return registered;
        },
      }, async (attempt) => {
        const settled = await input.turn.settle<SettledTurn<AssistantTurnResult>, PersistenceWriteRefused>((publishSettlement) => settleTurn({
          dispatcher,
          ...(input.signal ? { turnSignal: input.signal } : {}),
          stream: attempt.stream,
          commitAssistant: async (exit) => {
            if (Exit.isFailure(exit)) return observedCalls;
            const content = exit.value.assistantContent;
            if (content.length > 0) {
              input.onTurnAssistantMessage?.(content, exit.value.entryId);
              await input.pushMessage({ kind: "assistant", content }, false, exit.value.entryId);
            }
            return observedCalls;
          },
          commitResults: async (results) => {
            await input.pushToolResults(results);
            await input.flushCanonicalMessages?.();
          },
          closeAttempt: attempt.close,
          onEvent: input.onEvent,
          publishTerminal: (exit) => {
            if (!attempt.failure() && Exit.isSuccess(exit) && exit.value.terminalEvent) input.onEvent(exit.value.terminalEvent);
          },
          publishSettlement,
        }));
        const handedOff = settled.batch.toolResults.some((result) => observedCalls.some((call) => call.name === handoffToolName && call.id === result.toolUseId));
        const outcome = settled.turn.outcome;
        const handoffWritten = handoffToolName !== undefined && input.handoffTracker.recordBatch(observedCalls, settled.batch.toolResults, outcome.kind);
        return {
          value: {
            answered: settled.turn.assistantContent.length > 0 && (handedOff || observedCalls.length === 0),
            handoffWritten,
            ...(outcome.kind === "stream_error" || outcome.kind === "context_overflow" ? { failure: outcome.error } : {}),
          },
          stop: handedOff,
        };
      });
      } finally {
        await Effect.runPromise(Scope.close(executionScope, Exit.void));
      }
      } };
    },
  });
}

/** Runs exhaustion steps until one answers, writes the handoff, or `MAX_SUMMARY_ATTEMPTS` ran. A step whose calls
 *  were all refused runs again at once, so the agent answers after it reads the refusals. A failed request throws
 *  its typed error. */
async function runExhaustionStream(input: ExhaustionStreamInput): Promise<ExhaustionStreamOutcome> {
  for (let attempt = 1; attempt <= MAX_SUMMARY_ATTEMPTS; attempt++) {
    input.signal?.throwIfAborted();
    const captured = { ...input, ...await input.captureRequest(attempt) };
    const handoffToolName = captured.tools.has("handoff") && input.handoffConfigured ? "handoff" : undefined;
    const outcome = await attemptExhaustionTurn(captured, handoffToolName);
    input.signal?.throwIfAborted();
    if (outcome.failure) throw outcome.failure;
    if (outcome.handoffWritten) return outcome;
    if (input.handoffTracker.isHandingOff) continue;
    if (outcome.answered) return outcome;
    log.warn("budget exhaust step returned no answer", { attempt, handoff: handoffToolName !== undefined });
  }

  input.signal?.throwIfAborted();
  return { answered: false, handoffWritten: false };
}

import { canUseCheckpoint, renderSessionNotesAutoCompactFallback, CHECKPOINT_TOOL_NAMES } from "../../infra/agent-assets/session-notes.js";
import type { ExecutionWhitelist } from "./tools/tool-policy.js";
import type { CapabilityCheck } from "../../infra/capability-text.js";
import type { ConversationCheckpoint } from "../session/conversation-checkpoint-facts.js";
import type { AgentLoopOptions, CompactionInstallation } from "./agent-loop-types.js";
import { createTokenEstimationCache, estimateConversationTokens } from "./compaction/token-counter.js";
import type { PlannedCompactionOperation } from "./compaction/triggers.js";
import type { CacheRetention, ConversationMessage, StreamEvent, ServingAttempt } from "./llm/types.js";
import { redactMessage } from "./agent-loop-history.js";
import { modelRequestRoute, type createActiveRequestContext } from "./active-request-context.js";
import type { RequestToolSurfaceOwner } from "./request-tool-surface.js";
import type { ModelInteractionProfile } from "./model-interaction-profile.js";
import { applyCompaction } from "./compaction/apply.js";
import { runManualVisibleCompaction, runProactiveCompaction } from "./compaction/triggers.js";
import type { AssistantTurnResult } from "./assistant-turn-result.js";
import type { OutgoingContextSnapshot } from "./context-token-anchor.js";
import { Log } from "../../infra/log.js";
import { renderConversationCheckpoint } from "../session/conversation-checkpoint.js";

const log = Log.create({ service: "agent-loop" });

const CHECKPOINT_WRITE_TOOLS: ReadonlySet<string> = new Set(["checkpoint_replace", "checkpoint_decide"]);
// A save round spans at most two requests: the first may only read the checkpoint.
const SAVE_ROUND_REQUESTS = 2;
const SAVE_ROUND_WHITELIST: ExecutionWhitelist = {
  tools: CHECKPOINT_TOOL_NAMES,
  deniedReason: (toolName) => `Tool '${toolName}' denied: this context window is exhausted and waits for its checkpoint save. Only checkpoint_read, checkpoint_replace, and checkpoint_decide run now. Save the checkpoint; the task continues in the next context.`,
};

/** A plan with the outcome of its save round. */
export interface SettledCompaction {
  readonly operation: PlannedCompactionOperation;
  readonly saved: boolean;
}

const RECALL_HINT = "Use the read-only `recall` tool to recover missing details from recorded history; use `expand` for a known durable entry ID.";

/** The text that opens a fresh context: the checkpoint or its absence, the
 *  standing brief, and one recovery instruction chosen by the save state. It
 *  never points to a checkpoint that does not exist. */
export function renderCompactionOpening(input: {
  readonly checkpoint: ConversationCheckpoint | undefined;
  readonly brief: string | undefined;
  readonly saved: boolean;
  readonly recallAvailable: boolean;
  /** The agent check of the request that opens the fresh context. */
  readonly capabilities: CapabilityCheck;
}): string {
  const recall = input.recallAvailable ? [RECALL_HINT] : [];
  const recovery = input.checkpoint && input.saved ? [...recall, "Continue the task from the checkpoint above."]
    : input.checkpoint ? ["This reset came before a checkpoint save, so the checkpoint above may not include the latest work.", ...recall, "Then continue the task."]
    : input.brief ? [...recall, "Continue the task from the brief above."]
    : input.recallAvailable ? ["Use the read-only `recall` tool to recover the latest user request and the work done for it from recorded history, then continue the task."]
    : ["Ask the person what to continue."];
  return [
    input.checkpoint ? renderConversationCheckpoint(input.checkpoint, input.capabilities) : "No checkpoint has been saved.",
    ...(input.brief ? [`# Brief\n\n${input.brief}`] : []),
    ["A fresh context window has started without summarizing the prior conversation.", ...recovery].join(" "),
  ].join("\n\n");
}

interface CompactionStateInput {
  options: AgentLoopOptions;
  messages(): ConversationMessage[];
  surface: RequestToolSurfaceOwner;
  requestContext: ReturnType<typeof createActiveRequestContext>;
  initialInteractionProfile: ModelInteractionProfile;
  prepareCurrentPrompt(profile: ModelInteractionProfile): Promise<void>;
  selectAttempt(attempt: ServingAttempt): void;
  attempt(): ServingAttempt;
  logicalRequestContext(): string | undefined;
  admitSurface(surface: Awaited<ReturnType<RequestToolSurfaceOwner["resolve"]>>): void;
  /** The tools that the budget closure leaves to the request `requestsAhead` from now, or undefined outside the closure. */
  compactionAllowedTools(requestsAhead: number): ReadonlySet<string> | undefined;
  carryTurnEnd(): boolean;
  setMessages(messages: ConversationMessage[]): void;
  onEvent(event: StreamEvent): void;
  pushUser(content: string): void | Promise<void>;
  pushMessage(message: ConversationMessage): Promise<ConversationMessage>;
  /** Reports the system-origin messages that durable history already
   *  holds, as `pushUser` reports the ones it appends. */
  onUserMessage?: AgentLoopOptions["onUserMessage"];
  checkpoint?: AgentLoopOptions["checkpoint"];
  recallAvailable(): boolean;
}

/** Owns the loop's compaction plan and all history replacement side effects. */
export function createAgentLoopCompactionState(input: CompactionStateInput) {
  let planned: { operation: PlannedCompactionOperation; recoveryAvailable: boolean; announced: boolean } | null = null;
  let idleCache: { key: string; observedAt: number; ttlMs: number } | undefined;
  const estimationCache = createTokenEstimationCache();
  const checkpointUsable = (allowed: ReadonlySet<string> | undefined): boolean => canUseCheckpoint(input.checkpoint !== undefined, input.surface.current().tools, allowed);
  /** A reset at the next request, which runs no save round. */
  const canCompact = (): boolean => checkpointUsable(input.compactionAllowedTools(1));
  /** A plan is admitted only when its whole save round precedes the budget
   *  closure, so a save round and the closure are never both active. Its
   *  eligibility is judged once, here, and not again when it settles. */
  const canPlan = (): boolean => checkpointUsable(input.compactionAllowedTools(SAVE_ROUND_REQUESTS));

  const installHistory = (messages: ConversationMessage[]): void => {
    idleCache = undefined;
    input.setMessages(messages);
    input.requestContext.anchor.reset();
  };

  /** The one recorded message that opens the fresh context (ARCH-CONTEXT-027).
   *  `saved` says whether the agent saved its checkpoint for this reset. */
  const prepareCompactedHistory = async ({ saved }: { saved: boolean }): Promise<CompactionInstallation> => {
    const checkpoint = await input.checkpoint?.read();
    const brief = await input.options.standingBrief?.();
    const additions = [
      redactMessage({ kind: "user", content: renderCompactionOpening({ checkpoint, brief, saved, recallAvailable: input.recallAvailable(), capabilities: input.surface.current().capabilities }) }, false),
    ];
    const tokenPolicy = input.requestContext.tokenPolicy();
    let measured: number | undefined;
    const measure = (messages: readonly ConversationMessage[]): number => {
      measured = input.requestContext.prefixTokens() + estimateConversationTokens(messages, tokenPolicy, estimationCache);
      return measured;
    };
    return { additions, measure, async install(messages, recorded) {
      installHistory(messages);
      for (const addition of additions) {
        const message = recorded ? addition : await input.pushMessage(addition);
        if (message.kind !== "user") continue;
        input.onUserMessage?.(message.content, "system", message);
      }
      if (!recorded) input.requestContext.anchor.reset();
      return measured ?? measure(messages);
    } };
  };

  const resetInput = ({ operation, saved }: SettledCompaction) => ({
    messages: input.messages(), onEvent: input.onEvent,
    tokensBefore: input.requestContext.beforeCompaction(),
    prepareCompactedHistory: () => prepareCompactedHistory({ saved }), after: operation.after, carryTurnEnd: input.carryTurnEnd(),
    emitContextUpdate: () => input.requestContext.anchor.emit(), options: input.options,
  });

  const runRequested = async (signal: AbortSignal, settled: SettledCompaction & { operation: Exclude<PlannedCompactionOperation, { kind: "automatic" }> }): Promise<void> => {
    const { operation } = settled;
    const surface = await input.surface.resolve();
    if (operation.kind === "idle" && (surface.runtimeConfig.idleCompaction === false || surface.runtimeConfig.proactiveCompactionThreshold <= 0 || signal.aborted)) {
      log.info("idle context reset withdrawn before preparation", { sessionId: input.options.sessionId ?? input.options.artifactScopeId, reason: signal.aborted ? "interrupted" : "disabled" });
      return;
    }
    // The closure was judged when the plan was admitted; the surface resolved again.
    if (!checkpointUsable(undefined)) return;
    const runtime = surface.providerRuntime;
    const route = runtime?.mainRoute ?? modelRequestRoute(input.options.client, input.options.providerOptions);
    const request = runtime?.admittedRequest ?? await surface.admitProviderRequest(route.client, signal);
    const attempt = runtime?.plannedAttempt ?? await request.plannedAttempt(route.providerOptions);
    input.selectAttempt(attempt);
    await input.prepareCurrentPrompt(runtime?.interactionProfile ?? input.initialInteractionProfile);
    input.requestContext.select(surface, attempt, input.logicalRequestContext());
    input.admitSurface(surface);
    if (operation.kind === "idle") {
      if (!signal.aborted) await applyCompaction({ ...resetInput(settled), signal });
    } else await runManualVisibleCompaction(resetInput(settled));
  };

  return {
    prepareCompactedHistory,
    canCompact,
    canPlan,
    async applyCheckpoint(settled: SettledCompaction, turnSignal: AbortSignal, interruptSignal: AbortSignal): Promise<void> {
      const { operation } = settled;
      if (operation.kind === "idle" && (!settled.saved || input.options.signal?.aborted || interruptSignal.aborted)) {
        if (!input.options.signal?.aborted && !interruptSignal.aborted) input.options.onSystemMessage?.("Idle checkpoint did not save session notes. Context has been kept.", "error");
        return;
      }
      if (operation.kind === "automatic") {
        const result = await runProactiveCompaction({ ...resetInput(settled), contextLimit: input.attempt().contextLimit });
        if (result.applied) input.setMessages(result.newMessages);
      } else await runRequested(turnSignal, { ...settled, operation });
    },
    observeCache(usage: AssistantTurnResult["usageAnchor"], snapshot: OutgoingContextSnapshot, attempt: ServingAttempt, observedAt: number, cacheRetention: CacheRetention | undefined): void {
      const key = JSON.stringify([snapshot.anchorKey, attempt.credentialLineage, attempt.accessProviderCandidate, cacheRetention]);
      if (idleCache?.key !== key || usage?.cacheRetentionMs === null) idleCache = undefined;
      if (usage?.cacheRetentionMs && usage.cacheReadTokens + usage.cacheWriteTokens > 0) idleCache = { key, observedAt, ttlMs: usage.cacheRetentionMs };
      else if (idleCache && (usage?.cacheReadTokens ?? 0) > 0) idleCache.observedAt = observedAt;
      else idleCache = undefined;
    },
    parkedCache() {
      return idleCache ? { observedAt: idleCache.observedAt, ttlMs: idleCache.ttlMs, contextTokens: input.requestContext.anchor.estimate() } : undefined;
    },
    /** Plans a compaction. The checkpoint instruction waits for `announce`. */
    schedule(operation: PlannedCompactionOperation): void {
      if (operation.kind === "idle") {
        idleCache = undefined;
        input.options.onSystemMessage?.("Idle compaction: saving session notes before the observed prompt cache expires.");
      }
      planned = { operation, recoveryAvailable: true, announced: false };
    },
    /** Writes the planned checkpoint instruction once. The loop calls it at the
     *  request boundary after it pins the checkpoint request's surface, so the
     *  `recall` hint names a tool only when that request offers it. A plan made
     *  while parked otherwise reads the surface pinned before the park. */
    async announce(): Promise<void> {
      if (!planned || planned.announced) return;
      planned.announced = true;
      await input.pushUser(input.checkpoint
        ? renderSessionNotesAutoCompactFallback({ has: input.surface.current().capabilities })
        : "Save one concise checkpoint of the current task state now. Do not continue the task or give a final answer in this response.");
    },
    hasPlanned(): boolean {
      return planned !== null;
    },
    /** While an announced plan waits for its save, only the checkpoint tools run. */
    executionWhitelist(): ExecutionWhitelist | undefined {
      return planned?.announced ? SAVE_ROUND_WHITELIST : undefined;
    },
    isIdle(): boolean { return planned?.operation.kind === "idle"; },
    /** Drops the plan and returns its operation, or null when none was planned. */
    discard(): PlannedCompactionOperation | null {
      const operation = planned?.operation ?? null;
      planned = null;
      return operation;
    },
    /** Settles the plan against the response that answered its instruction.
     *  A first response that only read the checkpoint keeps the plan for one
     *  more response. The checkpoint is saved when the response served and one
     *  checkpoint write succeeded. */
    settle(responseOk: boolean, calls: readonly { name: string; ok: boolean }[]): SettledCompaction | null {
      if (!planned) return null;
      if (planned.recoveryAvailable && responseOk && calls.length > 0
        && calls.every((call) => call.name === "checkpoint_read" && call.ok)) {
        planned.recoveryAvailable = false;
        return null;
      }
      const { operation } = planned;
      planned = null;
      if (operation.kind === "idle") idleCache = undefined;
      return { operation, saved: responseOk && calls.some((call) => call.ok && CHECKPOINT_WRITE_TOOLS.has(call.name)) };
    },
  };
}

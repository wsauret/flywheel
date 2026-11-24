import { canUseCheckpoint, renderSessionNotesAutoCompactFallback, CHECKPOINT_TOOL_NAMES } from "../../../infra/agent-assets/session-notes.js";
import type { ExecutionWhitelist } from "../tools/dispatch/tool-policy.js";
import type { CapabilityCheck } from "../../../infra/capability-text.js";
import type { ConversationCheckpoint } from "../../session/persistence/conversation-checkpoint-facts.js";
import type { AgentLoopOptions, CompactionInstallation } from "../agent-loop-types.js";
import { createTokenEstimationCache, estimateConversationTokens } from "../compaction/token-counter.js";
import type { PlannedCompactionOperation } from "../compaction/triggers.js";
import type { CacheRetention, ConversationMessage, StreamEvent, ServingAttempt } from "../llm/types.js";
import { redactMessage } from "./turn/agent-loop-history.js";
import { turnContextEntry } from "../request/prompt/agent-loop-turn-context.js";
import { modelRequestRoute, type createActiveRequestContext } from "../request/active-request-context.js";
import type { RequestToolSurfaceOwner } from "../request/request-tool-surface.js";
import type { ModelInteractionProfile } from "../request/prompt/model-interaction-profile.js";
import { applyCompaction } from "../compaction/apply.js";
import { runManualVisibleCompaction, runProactiveCompaction } from "../compaction/triggers.js";
import type { AssistantTurnResult } from "./turn/assistant-turn-result.js";
import type { OutgoingContextSnapshot } from "../request/context-token-anchor.js";
import { Log } from "../../../infra/diagnostics/log.js";
import { DebugLog } from "../../../infra/diagnostics/debug-log.js";
import { effectiveProactiveTrigger, proactiveCompactionTriggers } from "../compaction/compaction-policy.js";
import { renderConversationCheckpoint } from "../../session/conversation-records/conversation-checkpoint.js";

const log = Log.create({ service: "agent-loop" });

const CHECKPOINT_WRITE_TOOLS: ReadonlySet<string> = new Set(["checkpoint_replace", "checkpoint_decide"]);
// A save round spans at most four requests: one that may only read the checkpoint, and up to three that try to
// write it. A reset that follows an unsaved round opens a fresh context with no record of the latest work, so a
// response that saves nothing, or has any checkpoint write refused, is asked again until the bound. The context
// limit can end the round sooner, through overflow recovery.
const SAVE_ROUND_REQUESTS = 4;
const SAVE_RETRY_NOTICE = "<context_window_reminder>\nThe checkpoint was not saved: no `checkpoint_replace` or `checkpoint_decide` call succeeded, or one of them was refused. For each refused write, read its error, shrink the section it names if the checkpoint is over its limit, and send that write again. Save the sections that changed now. Do not continue the task or use other tools in this exhausted context.\n</context_window_reminder>";
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
const SKILL_RELOAD_HINT = "Reload the listed relevant skills that still apply with the `skill` tool.";

/** The text that opens a fresh context: the checkpoint or its absence, the
 *  standing brief, and one recovery instruction chosen by the save state. It
 *  never points to a checkpoint that does not exist. */
function renderCompactionOpening(input: {
  readonly checkpoint: ConversationCheckpoint | undefined;
  readonly brief: string | undefined;
  readonly saved: boolean;
  readonly recallAvailable: boolean;
  /** The agent check of the request that opens the fresh context. */
  readonly capabilities: CapabilityCheck;
}): string {
  const recall = input.recallAvailable ? [RECALL_HINT] : [];
  const restore = input.checkpoint && input.checkpoint.relevantSkills.length > 0 && input.capabilities("skill")
    ? [...recall, SKILL_RELOAD_HINT] : recall;
  const recoveryLines = (): string[] => {
    if (input.checkpoint && input.saved) return [...restore, "Continue the task from the checkpoint above."];
    if (input.checkpoint) return ["This reset came before a checkpoint save, so the checkpoint above may not include the latest work.", ...restore, "Then continue the task."];
    if (input.brief) return [...recall, "Continue the task from the brief above."];
    if (input.recallAvailable) return ["Use the read-only `recall` tool to recover the latest user request and the work done for it from recorded history, then continue the task."];
    return ["Ask the person what to continue."];
  };
  const recovery = recoveryLines();
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
  /** The standing context of the logical turn, which the fresh context records after its opening (ARCH-CONTEXT-042). */
  turnContext(): string | undefined;
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
  let planned: { operation: PlannedCompactionOperation; requests: number; announced: boolean; unsavedNotice: boolean } | null = null;
  let idleCache: { key: string; observedAt: number; ttlMs: number } | undefined;
  // The tokens that a reset reopens at: prefix, checkpoint, brief, and recovery
  // text. Each installed reset records it; a run that opens above the trigger
  // measures it once. It is the same for every request until the next reset.
  let freshContextTokens: number | undefined;
  let deferralReported = false;
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
    const turnContext = input.turnContext();
    const additions = [
      redactMessage({ kind: "user", content: renderCompactionOpening({ checkpoint, brief, saved, recallAvailable: input.recallAvailable(), capabilities: input.surface.current().capabilities }) }, false),
      ...turnContext === undefined ? [] : [redactMessage(turnContextEntry(turnContext), false)],
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
      freshContextTokens = measured ?? measure(messages);
      deferralReported = false;
      return freshContextTokens;
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
    input.requestContext.select(surface, attempt);
    input.admitSurface(surface);
    if (operation.kind === "idle") {
      if (!signal.aborted) await applyCompaction({ ...resetInput(settled), signal });
    } else await runManualVisibleCompaction(resetInput(settled));
  };

  return {
    prepareCompactedHistory,
    canCompact,
    canPlan,
    /** Whether an automatic reset is due at `contextTokens` (ARCH-CONTEXT-036):
     *  the context reached the first trigger that the fresh context is below.
     *  A reset that cannot reopen below a trigger is never due at it. The
     *  first deferral after each reset is recorded and shown once. Call it
     *  after the request context is selected, because the fresh context
     *  counts its prefix. */
    async automaticResetDue(contextTokens: number, contextLimit: number, configuredTokens: number): Promise<boolean> {
      const [first] = proactiveCompactionTriggers(contextLimit, configuredTokens);
      if (first === undefined || contextTokens < first) return false;
      if (freshContextTokens === undefined) {
        const installation = await prepareCompactedHistory({ saved: true });
        freshContextTokens = installation.measure(installation.additions);
      }
      const freshTokens = freshContextTokens;
      const trigger = effectiveProactiveTrigger(contextLimit, configuredTokens, freshTokens);
      if (trigger !== first && !deferralReported) {
        deferralReported = true;
        const sessionId = input.options.sessionId ?? input.options.artifactScopeId;
        DebugLog.record({ type: "agent.compaction.deferred", payload: { sessionId, freshContextTokens: freshTokens, triggerTokens: first, effectiveTriggerTokens: trigger || null, contextLimit } });
        const count = (tokens: number): string => tokens.toLocaleString("en-US");
        input.options.onSystemMessage?.(`Automatic compaction is deferred: a fresh context would start at about ${count(freshTokens)} tokens, which is not below its trigger of ${count(first)} tokens. ${trigger === 0
          ? "Only context overflow recovery resets this context."
          : `It now runs at ${count(trigger)} tokens, near the model's context window.`}`);
      }
      return trigger > 0 && contextTokens >= trigger;
    },
    /** The context size at which the next automatic reset runs under the
     *  pinned request's configuration, or 0 when none can run: no trigger
     *  qualifies, or no plan can be admitted before the budget closure. Each
     *  context measurement carries it to clients. */
    effectiveTrigger(): number {
      if (planned === null && !canPlan()) return 0;
      return effectiveProactiveTrigger(input.attempt().contextLimit, input.surface.current().runtimeConfig.proactiveCompactionThreshold, freshContextTokens);
    },
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
      planned = { operation, requests: 0, announced: false, unsavedNotice: false };
    },
    /** Writes the planned checkpoint instruction once, and the notice that a
     *  response saved nothing before the request that asks again. The loop calls
     *  it at the request boundary after it pins the checkpoint request's surface,
     *  so the `recall` hint names a tool only when that request offers it. A plan
     *  made while parked otherwise reads the surface pinned before the park. */
    async announce(): Promise<void> {
      if (!planned) return;
      if (planned.unsavedNotice) {
        planned.unsavedNotice = false;
        await input.pushUser(SAVE_RETRY_NOTICE);
      }
      if (planned.announced) return;
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
     *  The checkpoint is saved when the response served, it made at least one
     *  checkpoint write, and no checkpoint write was refused: a refused write
     *  beside a successful one still loses its section. A first response that
     *  only read the checkpoint keeps the plan for one more response. For a
     *  plan that resets, every later response that did not save, whether it
     *  read again, had a write refused, answered in text only, or failed, is
     *  asked again until the round reaches `SAVE_ROUND_REQUESTS`. An idle plan
     *  keeps its context when it does not save, so it does not ask again. */
    settle(responseOk: boolean, calls: readonly { name: string; ok: boolean }[]): SettledCompaction | null {
      if (!planned) return null;
      planned.requests += 1;
      const writes = calls.filter((call) => CHECKPOINT_WRITE_TOOLS.has(call.name));
      const saved = responseOk && writes.length > 0 && writes.every((call) => call.ok);
      const firstRead = planned.requests === 1 && responseOk && calls.length > 0 && calls.every((call) => call.name === "checkpoint_read" && call.ok);
      if (!saved && planned.requests < SAVE_ROUND_REQUESTS && (firstRead || planned.operation.kind !== "idle")) {
        planned.unsavedNotice = !firstRead;
        return null;
      }
      const { operation, requests } = planned;
      planned = null;
      if (operation.kind === "idle") idleCache = undefined;
      else if (!saved) log.info("context reset without a checkpoint save", { sessionId: input.options.sessionId ?? input.options.artifactScopeId, kind: operation.kind, requests });
      return { operation, saved };
    },
  };
}

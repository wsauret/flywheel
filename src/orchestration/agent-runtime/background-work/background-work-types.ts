/**
 * The records that background work and its helpers share: a task's result,
 * its metadata, and who stopped or interrupted it. The registry, its process
 * table, its notifications, and its producers all read these shapes, so they
 * sit below every one of them.
 */

import type { MutationEvidence } from "../../../infra/mutation-evidence.js";
import type { PausedBy } from "../../../infra/output-blocks.js";

/** The result of background work, by status. */
export type BackgroundWorkResult =
  | BackgroundWorkResultBase & {
    /** `partial`: the work stopped at its turn budget and `content` is what it
     *  had, not a completion. The parent decides whether to retask or accept. */
    /** `stopped`: a person ended the work with Cancel; `cancelled`: the
     *  requesting agent did. Both end the run for its parent; only an
     *  explicit Resume of a child runs it again. */
    status: "completed" | "partial" | "cancelled" | "stopped";
  }
  | BackgroundWorkResultBase & {
    status: "failed";
    /** Internal retry admission evidence. Present only for a model-run failure. */
    modelFailure?: true;
  }
  | BackgroundWorkResultBase & {
    /** `interrupted`: a person, the parent agent, or the runtime interrupted a child run. The run
     *  has not ended: it keeps its parent binding and can resume (ARCH-SESSIONS-018). */
    status: "interrupted";
    /** Who interrupted the child run: a person, its parent agent, or the
     *  runtime. Absent for a planned replacement's cut, which the successor
     *  resumes without a notice. */
    interruptedBy?: PausedBy;
  };

interface BackgroundWorkResultBase {
  content: string;
  /** A wait's notice that a route may deliver with the parked tool results it follows (`ConversationMessage`
   *  `runtimeNotice`): only a reply wait's end without a reply sets it. */
  runtimeNotice?: true;
  executionOutputTail?: string;
  /** A background command has one exactly when its exit was observed. One
   *  without it ended with no recorded outcome, as in a crash. */
  exit?: CommandExit;
  /** What a mutating command published to the project when it exited. The
   *  registry records it with the settled tail, against the original tool
   *  call, so that call's row and per-file undo find it. */
  mutationEvidence?: MutationEvidence;
  usage?: {
    totalTokens: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
    reasoningTokens?: number;
    totalCostUsd?: number;
    toolUses: number;
    durationMs: number;
  };
}

/** The result of work that ended. An interrupted run has not ended, so it
 *  never records a completion. */
export type EndedWorkResult = Exclude<BackgroundWorkResult, { readonly status: "interrupted" }>;

/** Identity pair of the originating tool call. Deferred facts written after
 *  dispatch (live output tails, terminal results, background meta) echo the
 *  identity the call's tool.input.completed fact carries so the
 *  tool-execution projection can match them to that call. */
export interface ToolCallIdentity {
  parentToolUseId?: string;
  modelRequestId?: string;
}

interface BackgroundWorkMetaBase extends ToolCallIdentity {
  id: string;
  type: string;
  description: string;
  toolUseId?: string;
  /** The key the completion publishes under, so a repeat of it commits once. */
  notificationKey?: string;
  /** Set for a watch (ARCH-TOOLS-059): its result content is its last notice
   *  already formatted, and its index record marks it. */
  watch?: true;
}

export type BackgroundWorkMeta = BackgroundWorkMetaBase & (
  | { model: string; effort?: string; roleSessionId?: string }
  | { model?: never; effort?: never; roleSessionId?: never }
);

/** How a command whose end was observed ended: with its own exit code, or
 *  by a signal, which leaves it no exit code. `signal` is null when the
 *  platform named none. */
export type CommandExit = { readonly code: number } | { readonly signal: string | null };

/** Who asked a task to stop: its requesting agent, a person, or the runtime. */
export type BackgroundKillSource = "agent" | "user" | "runtime";

/** Who interrupted a tracked child now, as the child's own runner reports
 *  it, or nothing while it is not interrupted. A child that its parent agent
 *  or the runtime interrupted is not active work: no wait parks on it, and a
 *  handoff does not wait for it. A child that a person interrupted stays the
 *  parent's active work (PI-AGENT-025). A Resume makes it active work again. */
export interface ChildInterruption {
  interruptedBy(): PausedBy | undefined;
  /** Calls `listener` on each change of `interruptedBy`, until the returned
   *  function ends the observation. */
  observe(listener: () => void): () => void;
}

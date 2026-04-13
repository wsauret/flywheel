// Queue System — ADR-004 Guardrails
//
// Implements 6 guardrails for queue mutations:
//
// 1. Max queue length (default 50) — enforced on all mutation operations
// 2. Max mutations per step completion (default 3) — limits dispatcher
//    mutations per invocation
// 3. Max inserted steps per session (default 20) — tracks total inserts
//    (excluding initial template steps) and rejects when exceeded
// 4. Budget visibility — every dispatcher call receives remaining budget
// 5. Objective anchoring — every dispatcher mutation prompt includes
//    original session objective
// 6. Provenance logging — enforced at the queue mutation API level
//    (see queue.ts — all mutations require Provenance)
//
// Usage:
//   const guardrails = createGuardrails({ maxQueueLength: 50, ... });
//   // Before applying dispatcher mutations:
//   const budget = guardrails.getMutationBudget(stepId, queue.steps.length);
//   const results = guardrails.applyMutations(queue, stepId, mutations, prov);

import type { Step, Queue } from "./types.js";
import type { MutationRequest } from "./step-dispatcher.js";
import {
  insertAfter,
  removeStep,
  skipStep,
  type Provenance,
} from "./queue.js";
import { Log } from "../../infra/log.js";

const log = Log.create({ service: "guardrails" });

// Types

/** Configuration for guardrails. All limits are configurable. */
export interface GuardrailOptions {
  /** Maximum number of steps allowed in the queue. Default: 50. */
  maxQueueLength?: number;
  /** Maximum mutations the dispatcher can request per step completion. Default: 3. */
  maxMutationsPerStepCompletion?: number;
  /** Maximum total steps inserted during a session (excludes template steps). Default: 20. */
  maxInsertedStepsPerSession?: number;
  /** Session objective string for anchoring. */
  sessionObjective?: string;
}

/** Result of a guardrail check. */
interface GuardrailCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Budget information exposed to the dispatcher. */
export interface MutationBudget {
  /** Configured max queue length. */
  readonly maxQueueLength: number;
  /** Current number of steps in the queue. */
  readonly currentQueueLength: number;
  /** Remaining capacity (maxQueueLength - currentQueueLength). */
  readonly remainingQueueCapacity: number;
  /** Mutations already applied for this step. */
  readonly mutationsUsedThisStep: number;
  /** Mutations remaining for this step. */
  readonly mutationsRemainingThisStep: number;
  /** Total steps inserted during this session (excluding template). */
  readonly totalSessionInserts: number;
  /** Remaining session insert capacity. */
  readonly sessionInsertsRemaining: number;
  /** Session objective for anchoring. */
  readonly sessionObjective: string;
}

/** Result of applying a single mutation through guardrails. */
interface MutationApplicationResult {
  readonly applied: boolean;
  readonly reason?: string;
}

// Guardrails interface

export interface Guardrails {
  /** Get the remaining mutation budget for a step. */
  getMutationBudget(stepId: string, currentQueueLength: number): MutationBudget;
  /**
   * Apply a set of dispatcher-requested mutations through all guardrails.
   * Returns one result per mutation request.
   */
  applyMutations(
    queue: Queue,
    stepId: string,
    mutations: MutationRequest[],
    provenance: Provenance,
  ): MutationApplicationResult[];
}

// Defaults

const DEFAULT_MAX_QUEUE_LENGTH = 50;
const DEFAULT_MAX_MUTATIONS_PER_STEP = 3;
const DEFAULT_MAX_INSERTED_STEPS_PER_SESSION = 20;
// createGuardrails — factory function

export function createGuardrails(options: GuardrailOptions = {}) {
  const maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
  const maxMutationsPerStep = options.maxMutationsPerStepCompletion ?? DEFAULT_MAX_MUTATIONS_PER_STEP;
  const maxInsertedPerSession = options.maxInsertedStepsPerSession ?? DEFAULT_MAX_INSERTED_STEPS_PER_SESSION;
  const sessionObjective = options.sessionObjective ?? "";

  // --- Internal state ---

  /** Per-step mutation counts. */
  const stepMutationCounts = new Map<string, number>();
  /** Total session inserts (excluding initial template steps). */
  let sessionInsertCount = 0;

  // Guardrail 1: Max queue length

  function checkInsert(queue: Queue, count: number): GuardrailCheckResult {
    if (queue.steps.length + count > maxQueueLength) {
      return {
        allowed: false,
        reason: `Cannot insert ${count} step(s): would exceed max queue length (${maxQueueLength}). Current: ${queue.steps.length}`,
      };
    }
    return { allowed: true };
  }

  // Guardrail 2: Max mutations per step completion

  function checkMutationBudget(stepId: string): GuardrailCheckResult {
    const used = stepMutationCounts.get(stepId) ?? 0;
    if (used >= maxMutationsPerStep) {
      return {
        allowed: false,
        reason: `Step "${stepId}" has exhausted its mutation budget (${maxMutationsPerStep} mutations per step completion)`,
      };
    }
    return { allowed: true };
  }

  function recordMutation(stepId: string): void {
    const current = stepMutationCounts.get(stepId) ?? 0;
    stepMutationCounts.set(stepId, current + 1);
  }

  // Guardrail 3: Max inserted steps per session

  function checkSessionInsertBudget(count: number): GuardrailCheckResult {
    if (sessionInsertCount + count > maxInsertedPerSession) {
      return {
        allowed: false,
        reason: `Cannot insert ${count} step(s): would exceed max session inserts (${maxInsertedPerSession}). Already inserted: ${sessionInsertCount}`,
      };
    }
    return { allowed: true };
  }

  function recordSessionInsert(): void {
    sessionInsertCount++;
  }

  // Guardrail 4 & 5: Budget visibility and objective anchoring

  function getMutationBudget(stepId: string, currentQueueLength: number): MutationBudget {
    const mutationsUsed = stepMutationCounts.get(stepId) ?? 0;
    return {
      maxQueueLength,
      currentQueueLength,
      remainingQueueCapacity: maxQueueLength - currentQueueLength,
      mutationsUsedThisStep: mutationsUsed,
      mutationsRemainingThisStep: Math.max(0, maxMutationsPerStep - mutationsUsed),
      totalSessionInserts: sessionInsertCount,
      sessionInsertsRemaining: Math.max(0, maxInsertedPerSession - sessionInsertCount),
      sessionObjective,
    };
  }

  function getSessionObjective(): string {
    return sessionObjective;
  }

  // applyMutations — apply dispatcher mutations through all guardrails

  function applyMutations(
    queue: Queue,
    stepId: string,
    mutations: MutationRequest[],
    provenance: Provenance,
  ): MutationApplicationResult[] {
    const results: MutationApplicationResult[] = [];

    for (const mutation of mutations) {
      const budgetCheck = checkMutationBudget(stepId);
      if (!budgetCheck.allowed) {
        results.push({ applied: false, reason: budgetCheck.reason });
        log.warn("mutation rejected: per-step budget exceeded", { stepId, type: mutation.type, reason: budgetCheck.reason });
        continue;
      }

      const mutationResult = applySingleMutation(queue, stepId, mutation, provenance);
      results.push(mutationResult);

      if (mutationResult.applied) {
        log.info("mutation applied", { stepId, type: mutation.type, reason: mutation.reason });
      } else {
        log.warn("mutation rejected", { stepId, type: mutation.type, reason: mutationResult.reason });
      }
    }

    return results;
  }

  function applySingleMutation(
    queue: Queue,
    stepId: string,
    mutation: MutationRequest,
    provenance: Provenance,
  ): MutationApplicationResult {
    switch (mutation.type) {
      case "insert_after": {
        if (!mutation.targetStepId || !mutation.steps || mutation.steps.length === 0) {
          return { applied: false, reason: "insert_after requires targetStepId and steps" };
        }
        const insertCheck = checkInsert(queue, mutation.steps.length);
        if (!insertCheck.allowed) return { applied: false, reason: insertCheck.reason };
        const sessionCheck = checkSessionInsertBudget(mutation.steps.length);
        if (!sessionCheck.allowed) return { applied: false, reason: sessionCheck.reason };

        const result = insertAfter(queue, mutation.targetStepId, mutation.steps, provenance);
        if (!result.success) return { applied: false, reason: result.error };
        sessionInsertCount += mutation.steps.length;
        recordMutation(stepId);
        return { applied: true };
      }

      case "skip":
      case "remove": {
        if (!mutation.targetStepId) {
          return { applied: false, reason: `${mutation.type} requires targetStepId` };
        }
        const fn = mutation.type === "skip" ? skipStep : removeStep;
        const result = fn(queue, mutation.targetStepId, provenance);
        if (!result.success) return { applied: false, reason: result.error };
        recordMutation(stepId);
        return { applied: true };
      }

      default: {
        const _exhaustive: never = mutation.type;
        return { applied: false, reason: `Unknown mutation type: ${_exhaustive}` };
      }
    }
  }

  return {
    getMutationBudget,
    applyMutations,
    // Exposed for targeted unit testing via GuardrailsTestable cast in tests.
    // Not on the public Guardrails interface — production code sees only the two methods above.
    checkInsert, checkMutationBudget, checkSessionInsertBudget,
    recordMutation, recordSessionInsert, getSessionObjective,
  };
}

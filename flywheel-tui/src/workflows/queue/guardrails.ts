import type { Step, Queue } from "./types.js";
import type { MutationRequest, MutationBudget } from "./step-dispatcher-types.js";
import {
  insertAfter,
  removeStep,
  skipStep,
  type Provenance,
} from "./queue.js";
import { Log } from "../../infra/log.js";

const log = Log.create({ service: "guardrails" });

interface GuardrailOptions {
  maxQueueLength?: number;
  maxMutationsPerStepCompletion?: number;
  maxInsertedStepsPerSession?: number;
}

interface GateResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

type MutationApplicationResult = GateResult;

export interface Guardrails {
  getMutationBudget(stepId: string, currentQueueLength: number): MutationBudget;
  applyMutations(
    queue: Queue,
    stepId: string,
    mutations: MutationRequest[],
    provenance: Provenance,
  ): MutationApplicationResult[];
}

const DEFAULT_MAX_QUEUE_LENGTH = 50;
const DEFAULT_MAX_MUTATIONS_PER_STEP = 3;
const DEFAULT_MAX_INSERTED_STEPS_PER_SESSION = 20;

export function createGuardrails(options: GuardrailOptions = {}) {
  const maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH;
  const maxMutationsPerStep = options.maxMutationsPerStepCompletion ?? DEFAULT_MAX_MUTATIONS_PER_STEP;
  const maxInsertedPerSession = options.maxInsertedStepsPerSession ?? DEFAULT_MAX_INSERTED_STEPS_PER_SESSION;

  const stepMutationCounts = new Map<string, number>();
  let sessionInsertCount = 0;

  function checkInsert(queue: Queue, count: number) {
    if (queue.steps.length + count > maxQueueLength) {
      return {
        allowed: false,
        reason: `Cannot insert ${count} step(s): would exceed max queue length (${maxQueueLength}). Current: ${queue.steps.length}`,
      };
    }
    return { allowed: true };
  }

  function checkMutationBudget(stepId: string) {
    const used = stepMutationCounts.get(stepId) ?? 0;
    if (used >= maxMutationsPerStep) {
      return {
        allowed: false,
        reason: `Step "${stepId}" has exhausted its mutation budget (${maxMutationsPerStep} mutations per step completion)`,
      };
    }
    return { allowed: true };
  }

  function recordMutation(stepId: string) {
    const current = stepMutationCounts.get(stepId) ?? 0;
    stepMutationCounts.set(stepId, current + 1);
  }

  function checkSessionInsertBudget(count: number) {
    if (sessionInsertCount + count > maxInsertedPerSession) {
      return {
        allowed: false,
        reason: `Cannot insert ${count} step(s): would exceed max session inserts (${maxInsertedPerSession}). Already inserted: ${sessionInsertCount}`,
      };
    }
    return { allowed: true };
  }

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
    };
  }

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
        results.push({ allowed: false, reason: budgetCheck.reason });
        log.warn("mutation rejected: per-step budget exceeded", { stepId, type: mutation.type, reason: budgetCheck.reason });
        continue;
      }

      const mutationResult = applySingleMutation(queue, stepId, mutation, provenance);
      results.push(mutationResult);

      if (mutationResult.allowed) {
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
        const insertCheck = checkInsert(queue, mutation.steps.length);
        if (!insertCheck.allowed) return { allowed: false, reason: insertCheck.reason };
        const sessionCheck = checkSessionInsertBudget(mutation.steps.length);
        if (!sessionCheck.allowed) return { allowed: false, reason: sessionCheck.reason };

        const result = insertAfter(queue, mutation.targetStepId, mutation.steps, provenance);
        if (!result.success) return { allowed: false, reason: result.error };
        sessionInsertCount += mutation.steps.length;
        recordMutation(stepId);
        return { allowed: true };
      }

      case "skip":
      case "remove": {
        const fn = mutation.type === "skip" ? skipStep : removeStep;
        const result = fn(queue, mutation.targetStepId, provenance);
        if (!result.success) return { allowed: false, reason: result.error };
        recordMutation(stepId);
        return { allowed: true };
      }

      default:
        return { allowed: false, reason: `Unknown mutation type: ${(mutation as { type: string }).type}` };
    }
  }

  return { getMutationBudget, applyMutations };
}

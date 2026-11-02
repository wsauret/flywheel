import { runModuleObserverHooks } from "../module-hooks.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { formatRuntimeNotification } from "./runtime-notifications.js";

const log = Log.create({ service: "batch-observers" });

/** An observer that an agent of a workflow asks after each settled tool
 *  batch. Its notice, when it has one, reaches the agent as a private runtime
 *  notice with that batch's results (ARCH-TOOLS-007). */
export interface BatchObserver {
  onBatchSettled(): string | null | Promise<string | null>;
  /** Starts the observer over, for a new run of the agent. */
  reset(): void;
}

export function createObserverChain(observers: BatchObserver[]) {
  return {
    async onBatchSettled(): Promise<string[]> {
      const notices: string[] = [];
      for (const [index, observer] of observers.entries()) {
        try {
          const notice = await observer.onBatchSettled();
          if (notice !== null) notices.push(notice);
        } catch (error) {
          log.error("capability observer failed", { observerId: `batch-observer-${index}:onBatchSettled`, error: errorMessage(error) });
        }
      }
      return notices;
    },
    reset(): void {
      runModuleObserverHooks(observers.map((observer, index) => ({
        id: `batch-observer-${index}:reset`,
        observe: () => { observer.reset(); },
      })), "reset");
    },
  };
}

interface BudgetInfo {
  remainingCalls: number;
  remainingTokens: number;
}

/** Tells the agent once which workflow budget limits run low, and again only
 *  when another limit joins them: a notice at every batch would only repeat
 *  itself. */
export function createBudgetAwarenessObserver(
  getBudgetInfo: () => BudgetInfo | null | Promise<BudgetInfo | null>,
): BatchObserver {
  let reportedLimits = "";
  return {
    async onBatchSettled(): Promise<string | null> {
      const info = await getBudgetInfo();
      if (!info) return null;
      const low = [
        ...(info.remainingCalls < 5 ? [{ limit: "attempts", text: `${info.remainingCalls} attempts` }] : []),
        ...(info.remainingTokens < 10_000 ? [{ limit: "tokens", text: `${info.remainingTokens} tokens` }] : []),
      ];
      const limits = low.map(({ limit }) => limit).join(",");
      if (low.length === 0 || limits === reportedLimits) return null;
      reportedLimits = limits;
      return formatRuntimeNotification({
        tag: "workflow_budget_notice",
        handling: `Workflow budget running low: ${low.map(({ text }) => text).join(" and ")} remain. This agent can finish, but no attempt starts after the budget runs out. Prioritize completing your brief efficiently.`,
      });
    },
    reset(): void {
      reportedLimits = "";
    },
  };
}

export function createContextPressureObserver(
  getContextPercent: () => number | Promise<number>,
): BatchObserver {
  let hasFired = false;

  return {
    async onBatchSettled(): Promise<string | null> {
      if (hasFired) return null;
      const percent = await getContextPercent();
      if (percent > 60) {
        hasFired = true;
        return formatRuntimeNotification({
          tag: "context_pressure_notice",
          handling: "Context is filling up. Be concise in your responses and tool usage to preserve context space.",
        });
      }
      return null;
    },
    reset(): void {
      hasFired = false;
    },
  };
}
